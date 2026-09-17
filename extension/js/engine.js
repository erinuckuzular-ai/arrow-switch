/*
 * Arrow AutoCut — edit decision engine.
 *
 * Pure functions, no Premiere or Node dependencies, so the logic can be
 * unit-tested outside of Premiere (see test/engine.test.js).
 *
 * Pipeline:
 *   per-track loudness (dB per window)
 *     -> detectSpeech()   which speakers are talking in each window
 *     -> buildEdit()      camera segments honoring min/max shot rules
 *     -> snapToFrames()   frame-accurate cut list for Premiere
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AutoCutEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SILENT_DB = -120;

  var DEFAULTS = {
    windowSec: 0.1,        // analysis resolution
    sensitivityDb: 10,     // dB above a track's noise floor that counts as speech
    overlapMarginDb: 6,    // speakers within this many dB of the dominant one count as talking over each other
    smoothingSec: 0.3,     // loudness smoothing radius
    minShotSec: 2.5,       // no shot shorter than this
    maxShotSec: 0,         // 0 = off; otherwise cut to wide when one angle is held longer than this
    wideShotSec: 3,        // length of wide cutaways inserted by maxShotSec
    overlapToWide: true,   // cross-talk goes to the wide shot
    leadInSec: 0.2         // cut slightly before the speaker starts talking
  };

  function withDefaults(opts) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var j in (opts || {})) if (opts[j] !== undefined && opts[j] !== null) out[j] = opts[j];
    return out;
  }

  function percentile(values, p) {
    if (!values.length) return SILENT_DB;
    var sorted = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[idx];
  }

  // Moving average in the power domain, returned in dB.
  function smoothDb(levels, radius) {
    var n = levels.length;
    var power = new Float64Array(n);
    for (var i = 0; i < n; i++) power[i] = Math.pow(10, levels[i] / 10);
    var prefix = new Float64Array(n + 1);
    for (var p = 0; p < n; p++) prefix[p + 1] = prefix[p] + power[p];
    var out = new Float32Array(n);
    for (var w = 0; w < n; w++) {
      var a = Math.max(0, w - radius), b = Math.min(n, w + radius + 1);
      var mean = (prefix[b] - prefix[a]) / (b - a);
      out[w] = mean > 0 ? Math.max(SILENT_DB, 10 * Math.log10(mean)) : SILENT_DB;
    }
    return out;
  }

  /*
   * trackLevels: array (one per speaker) of dB-per-window arrays, all the same length.
   * Returns { active: Array<number[]>, stats: [{floor, speech, threshold}] }
   * where active[i] lists the speaker indexes talking in window i.
   */
  function detectSpeech(trackLevels, opts) {
    var o = withDefaults(opts);
    var radius = Math.max(0, Math.round(o.smoothingSec / o.windowSec));
    var n = trackLevels.length ? trackLevels[0].length : 0;

    var smoothed = [], stats = [];
    for (var t = 0; t < trackLevels.length; t++) {
      var sm = smoothDb(trackLevels[t], radius);
      var present = [];
      for (var i = 0; i < n; i++) if (sm[i] > -100) present.push(sm[i]);
      var floor = percentile(present, 0.15);
      var speech = percentile(present, 0.95);
      // Keep the threshold reachable on quiet or heavily-compressed mics.
      var threshold = Math.min(floor + o.sensitivityDb, speech - 3);
      smoothed.push(sm);
      stats.push({ floor: floor, speech: speech, threshold: threshold });
    }

    var active = new Array(n);
    for (var w = 0; w < n; w++) {
      var talking = [], best = -Infinity;
      for (var s = 0; s < smoothed.length; s++) {
        if (smoothed[s][w] > stats[s].threshold) {
          // Compare relative to each mic's own speaking level so gain differences
          // between mics don't matter and bleed is naturally quieter.
          var rel = smoothed[s][w] - stats[s].speech;
          talking.push({ s: s, rel: rel });
          if (rel > best) best = rel;
        }
      }
      var list = [];
      for (var k = 0; k < talking.length; k++) {
        if (talking[k].rel >= best - o.overlapMarginDb) list.push(talking[k].s);
      }
      active[w] = list;
    }
    return { active: active, stats: stats };
  }

  function mergeEqual(runs) {
    var out = [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (out.length && out[out.length - 1].cam === r.cam) out[out.length - 1].end = r.end;
      else out.push({ cam: r.cam, start: r.start, end: r.end });
    }
    return out;
  }

  // Merge runs shorter than minDur into their longer neighbour, escalating the
  // threshold gradually so tiny blips are resolved before medium ones.
  function absorbShort(runs, minDur) {
    if (minDur <= 0) return runs;
    var steps = [0.25, 0.5, 0.75, 1];
    for (var si = 0; si < steps.length; si++) {
      var limit = minDur * steps[si];
      var changed = true;
      while (changed && runs.length > 1) {
        changed = false;
        for (var i = 0; i < runs.length; i++) {
          var r = runs[i];
          if (r.end - r.start >= limit) continue;
          var prev = runs[i - 1], next = runs[i + 1];
          var target;
          if (!prev) target = next;
          else if (!next) target = prev;
          else target = (prev.end - prev.start) >= (next.end - next.start) ? prev : next;
          if (target === prev) prev.end = r.end;
          else next.start = r.start;
          runs.splice(i, 1);
          runs = mergeEqual(runs);
          changed = true;
          break;
        }
      }
    }
    return runs;
  }

  /*
   * active: output of detectSpeech().active
   * cfg: {
   *   speakerCams: camera id for each speaker index,
   *   wideCam: camera id for the wide shot, or null,
   *   ...DEFAULTS
   * }
   * Returns [{ start, end, cam }] in seconds covering [0, active.length * windowSec].
   */
  function buildEdit(active, cfg) {
    var o = withDefaults(cfg);
    var cams = cfg.speakerCams || [];
    var wide = cfg.wideCam === undefined ? null : cfg.wideCam;
    var n = active.length;
    var total = n * o.windowSec;
    if (!n) return [];

    // 1. Desired camera per window (null = no opinion, hold the current shot).
    var desired = new Array(n);
    for (var i = 0; i < n; i++) {
      var list = active[i];
      if (!list.length) { desired[i] = null; continue; }
      var first = cams[list[0]];
      var same = true;
      for (var j = 1; j < list.length; j++) if (cams[list[j]] !== first) same = false;
      if (same) desired[i] = first;
      else desired[i] = (o.overlapToWide && wide !== null) ? wide : null;
    }

    // 2. Raw runs of the same desired camera, holding through silence.
    var runs = [];
    var startCam = wide !== null ? wide : cams[0];
    for (var f = 0; f < n; f++) if (desired[f] !== null) { startCam = desired[f]; break; }
    var cur = startCam, runStart = 0;
    for (var w = 0; w < n; w++) {
      var d = desired[w];
      if (d === null || d === cur) continue;
      runs.push({ cam: cur, start: runStart * o.windowSec, end: w * o.windowSec });
      cur = d;
      runStart = w;
    }
    runs.push({ cam: cur, start: runStart * o.windowSec, end: total });
    runs = mergeEqual(runs.filter(function (r) { return r.end > r.start; }));

    // 3. Enforce minimum shot length.
    runs = absorbShort(runs, o.minShotSec);

    // 4. Cut a little before the speaker starts, without starving the prior shot.
    if (o.leadInSec > 0) {
      for (var b = 1; b < runs.length; b++) {
        var shift = Math.min(o.leadInSec, Math.max(0, (runs[b - 1].end - runs[b - 1].start) - o.minShotSec));
        runs[b - 1].end -= shift;
        runs[b].start -= shift;
      }
    }

    // 5. Break up long holds with wide cutaways.
    if (o.maxShotSec > 0 && wide !== null) {
      var out = [];
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        var len = run.end - run.start;
        if (run.cam === wide || len <= o.maxShotSec) { out.push(run); continue; }
        var pieces = Math.floor(len / (o.maxShotSec + o.wideShotSec));
        var t0 = run.start;
        for (var p = 0; p < pieces; p++) {
          var cutAt = t0 + o.maxShotSec;
          if (run.end - (cutAt + o.wideShotSec) < o.minShotSec) break;
          out.push({ cam: run.cam, start: t0, end: cutAt });
          out.push({ cam: wide, start: cutAt, end: cutAt + o.wideShotSec });
          t0 = cutAt + o.wideShotSec;
        }
        out.push({ cam: run.cam, start: t0, end: run.end });
      }
      runs = mergeEqual(out);
    }

    return runs;
  }

  // Round segment boundaries to whole frames and drop anything that collapses.
  function snapToFrames(segments, fps) {
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var startF = Math.round(s.start * fps), endF = Math.round(s.end * fps);
      if (endF <= startF) continue;
      if (out.length && out[out.length - 1].cam === s.cam) out[out.length - 1].endFrame = endF;
      else if (out.length) { out[out.length - 1].endFrame = startF; out.push({ cam: s.cam, startFrame: startF, endFrame: endF }); }
      else out.push({ cam: s.cam, startFrame: startF, endFrame: endF });
    }
    return out;
  }

  function summarize(segments) {
    var perCam = {};
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      perCam[s.cam] = (perCam[s.cam] || 0) + (s.end - s.start);
    }
    return { cuts: Math.max(0, segments.length - 1), secondsPerCam: perCam };
  }

  return {
    DEFAULTS: DEFAULTS,
    SILENT_DB: SILENT_DB,
    detectSpeech: detectSpeech,
    buildEdit: buildEdit,
    snapToFrames: snapToFrames,
    summarize: summarize,
    _smoothDb: smoothDb,
    _absorbShort: absorbShort
  };
});
