/*
 * Arrow Switch — edit decision engine.
 *
 * Pure functions, no Premiere or Node dependencies, so the logic can be
 * unit-tested outside of Premiere (see test/engine.test.js) and scored against
 * synthetic podcasts with known answers (test/bench/accuracy.js).
 *
 * Pipeline:
 *   per-track loudness (dB per window)
 *     -> detectSpeech()   which speakers are talking in each window
 *     -> buildEdit()      camera segments honoring min/max shot rules
 *     -> snapToFrames()   frame-accurate cut list for Premiere
 */
(function (root, factory) {
  var api = factory();
  // Premiere panels run with Node enabled, so `module` exists there too: set both.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchEngine = api;
  else root.ArrowSwitchEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SILENT_DB = -120;

  var DEFAULTS = {
    windowSec: 0.05,       // analysis resolution
    sensitivityDb: 10,     // dB above a track's noise floor that counts as speech
    overlapMarginDb: 6,    // speakers within this many dB of the dominant one count as talking over each other
    bleedMarginDb: 3,      // a mic must be this far above the bleed predicted from the other mics
    hysteresisDb: 3,       // once talking, a mic can drop this much below threshold before it stops
    smoothingSec: 0.15,    // loudness smoothing radius
    bridgeGapSec: 0.35,    // pauses shorter than this don't end someone's turn
    minTalkSec: 1.2,       // bursts shorter than this ("yeah", "mm-hm") never move the camera
    minShotSec: 2.5,       // no shot shorter than this
    maxShotSec: 0,         // 0 = off; otherwise cut to wide when one angle is held longer than this
    wideShotSec: 3,        // length of wide cutaways inserted by maxShotSec
    overlapToWide: true,   // cross-talk goes to the wide shot
    minOverlapSec: 1.0,    // cross-talk shorter than this is a hand-over, not a wide moment
    leadInSec: 0.2         // cut slightly before the speaker starts talking
  };

  function withDefaults(opts) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var j in (opts || {})) if (opts[j] !== undefined && opts[j] !== null) out[j] = opts[j];
    return out;
  }

  // Percentiles over dB values via a 0.25 dB histogram: O(n), so settings stay live on long episodes.
  var HIST_MIN = -120, HIST_STEP = 0.25, HIST_BINS = 481;
  function Histogram() { this.bins = new Uint32Array(HIST_BINS); this.count = 0; }
  Histogram.prototype.add = function (db) {
    var b = Math.round((db - HIST_MIN) / HIST_STEP);
    this.bins[b < 0 ? 0 : b >= HIST_BINS ? HIST_BINS - 1 : b]++;
    this.count++;
  };
  Histogram.prototype.percentile = function (p, fallback) {
    if (!this.count) return fallback;
    var target = p * (this.count - 1), seen = 0;
    for (var b = 0; b < HIST_BINS; b++) {
      seen += this.bins[b];
      if (seen > target) return HIST_MIN + b * HIST_STEP;
    }
    return HIST_MIN + (HIST_BINS - 1) * HIST_STEP;
  };

  function percentile(values, p) {
    var h = new Histogram();
    for (var i = 0; i < values.length; i++) h.add(values[i]);
    return h.percentile(p, SILENT_DB);
  }

  // Moving average in the power domain, returned in dB.
  function smoothDb(levels, radius) {
    var n = levels.length;
    var prefix = new Float64Array(n + 1);
    for (var p = 0; p < n; p++) prefix[p + 1] = prefix[p] + Math.pow(10, levels[p] / 10);
    var out = new Float32Array(n);
    for (var w = 0; w < n; w++) {
      var a = Math.max(0, w - radius), b = Math.min(n, w + radius + 1);
      var mean = (prefix[b] - prefix[a]) / (b - a);
      out[w] = mean > 0 ? Math.max(SILENT_DB, 10 * Math.log10(mean)) : SILENT_DB;
    }
    return out;
  }

  // In-place on a 0/1 mask: close gaps shorter than `gap` windows, then drop runs shorter than `min`.
  function cleanMask(mask, gap, min) {
    var n = mask.length, i, j;
    if (gap > 0) {
      i = 0;
      while (i < n) {
        if (mask[i]) { i++; continue; }
        j = i;
        while (j < n && !mask[j]) j++;
        if (i > 0 && j < n && j - i < gap) for (var k = i; k < j; k++) mask[k] = 1;
        i = j;
      }
    }
    if (min > 1) {
      i = 0;
      while (i < n) {
        if (!mask[i]) { i++; continue; }
        j = i;
        while (j < n && mask[j]) j++;
        if (j - i < min) for (var m = i; m < j; m++) mask[m] = 0;
        i = j;
      }
    }
    return mask;
  }

  /*
   * trackLevels: array (one per speaker) of dB-per-window arrays, all the same length.
   * Returns {
   *   active:  Array<number[]>  speaker indexes holding the floor in each window
   *   talking: Uint8Array[]     per-speaker talk mask after clean-up (for display)
   *   stats:   [{ floor, speech, threshold, talkSec, bleed: [dB from each other mic] }]
   *   similar: [[i, j]]         pairs of tracks that sound identical (same file / same channel)
   * }
   */
  function detectSpeech(trackLevels, opts) {
    var o = withDefaults(opts);
    var S = trackLevels.length;
    var n = S ? trackLevels[0].length : 0;
    var radius = Math.max(0, Math.round(o.smoothingSec / o.windowSec));
    var minConfident = Math.round(2 / o.windowSec);

    // 1. Smooth and find each mic's noise floor and typical speech level.
    var sm = [], stats = [];
    for (var t = 0; t < S; t++) {
      var s = smoothDb(trackLevels[t], radius);
      var all = new Histogram();
      for (var i = 0; i < n; i++) if (s[i] > -100) all.add(s[i]);
      var floor = all.percentile(0.05, SILENT_DB);
      var loud = new Histogram();
      for (var i2 = 0; i2 < n; i2++) if (s[i2] > floor + o.sensitivityDb) loud.add(s[i2]);
      var speech = loud.count >= Math.max(3, Math.round(0.3 / o.windowSec)) ? loud.percentile(0.5, floor) : all.percentile(0.95, floor);
      sm.push(s);
      stats.push({ floor: floor, speech: speech, threshold: 0, talkSec: 0, bleed: [] });
    }
    function setThresholds() {
      for (var q = 0; q < S; q++) {
        // Keep the threshold reachable on quiet or heavily-compressed mics, but never inside
        // the noise itself, or an unused mic would "talk" all episode.
        stats[q].threshold = Math.max(stats[q].floor + 4, Math.min(stats[q].floor + o.sensitivityDb, stats[q].speech - 3));
      }
    }
    setThresholds();

    // 2. Learn from the unambiguous moments. When one mic clearly dominates we know who is
    //    talking, so we can (a) re-estimate that person's real speaking level without bleed
    //    and backchannels mixed in, and (b) measure how much of them leaks into every other mic.
    var confident = [];
    for (var pass = 0; pass < 2; pass++) {
      confident = [];
      for (var c = 0; c < S; c++) confident.push([]);
      for (var w = 0; w < n; w++) {
        var best = -1, bestRel = -Infinity, secondRel = -Infinity;
        for (var k = 0; k < S; k++) {
          if (sm[k][w] <= stats[k].threshold) continue;
          var rel = sm[k][w] - stats[k].speech;
          if (rel > bestRel) { secondRel = bestRel; bestRel = rel; best = k; }
          else if (rel > secondRel) secondRel = rel;
        }
        if (best >= 0 && bestRel - secondRel >= 10 && bestRel > -12) confident[best].push(w);
      }
      for (var r = 0; r < S; r++) {
        if (confident[r].length < minConfident) continue;
        var h = new Histogram();
        for (var x = 0; x < confident[r].length; x++) h.add(sm[r][confident[r][x]]);
        stats[r].speech = h.percentile(0.5, stats[r].speech);
      }
      setThresholds();
    }

    // bleed[i][j]: typical level on mic j relative to mic i while i talks alone.
    var bleed = [];
    for (var bi = 0; bi < S; bi++) {
      bleed.push([]);
      for (var bj = 0; bj < S; bj++) {
        if (bi === bj || confident[bi].length < minConfident) { bleed[bi].push(null); continue; }
        var hb = new Histogram();
        for (var y = 0; y < confident[bi].length; y++) {
          var wi = confident[bi][y];
          hb.add(Math.max(HIST_MIN, Math.min(0, sm[bj][wi] - sm[bi][wi])));
        }
        bleed[bi].push(hb.percentile(0.5, null));
      }
      stats[bi].bleed = bleed[bi];
    }

    // 3. Per-speaker talk masks: over threshold (with hysteresis), louder than the bleed the
    //    other mics would put there, and within the overlap margin of whoever is loudest.
    var masks = [];
    for (var mm = 0; mm < S; mm++) masks.push(new Uint8Array(n));
    var on = new Uint8Array(S);
    var cand = new Uint8Array(S), relv = new Float32Array(S);
    for (var v = 0; v < n; v++) {
      var top = -Infinity;
      for (var a = 0; a < S; a++) {
        cand[a] = 0;
        var level = sm[a][v];
        var thr = stats[a].threshold - (on[a] ? o.hysteresisDb : 0);
        if (level <= thr) continue;
        var predicted = -Infinity;
        for (var b = 0; b < S; b++) {
          if (b === a || bleed[b][a] === null || sm[b][v] <= stats[b].threshold) continue;
          var pr = sm[b][v] + bleed[b][a];
          if (pr > predicted) predicted = pr;
        }
        if (level < predicted + o.bleedMarginDb) continue;
        cand[a] = 1;
        relv[a] = level - stats[a].speech;
        if (relv[a] > top) top = relv[a];
      }
      for (var d = 0; d < S; d++) {
        on[d] = cand[d] && relv[d] >= top - o.overlapMarginDb ? 1 : 0;
        masks[d][v] = on[d];
      }
    }

    var gap = Math.round(o.bridgeGapSec / o.windowSec);
    var minRun = Math.round(o.minTalkSec / o.windowSec);
    for (var e = 0; e < S; e++) {
      cleanMask(masks[e], gap, minRun);
      var cnt = 0;
      for (var f = 0; f < n; f++) cnt += masks[e][f];
      stats[e].talkSec = cnt * o.windowSec;
    }

    var active = new Array(n);
    for (var g = 0; g < n; g++) {
      var list = [];
      for (var u = 0; u < S; u++) if (masks[u][g]) list.push(u);
      active[g] = list;
    }

    // Tracks that are the same signal (one mono file on two tracks) can't be told apart.
    var similar = [];
    for (var p1 = 0; p1 < S; p1++) {
      for (var p2 = p1 + 1; p2 < S; p2++) {
        var diff = new Histogram(), step = Math.max(1, Math.floor(n / 20000));
        for (var z = 0; z < n; z += step) {
          if (sm[p1][z] > stats[p1].threshold || sm[p2][z] > stats[p2].threshold) diff.add(-Math.abs(sm[p1][z] - sm[p2][z]));
        }
        if (diff.count > 50 && diff.percentile(0.1, -99) > -1) similar.push([p1, p2]);
      }
    }

    return { active: active, talking: masks, stats: stats, similar: similar };
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
        var out = [];
        for (var i = 0; i < runs.length; i++) {
          var r = runs[i];
          var prev = out[out.length - 1], next = runs[i + 1];
          if (r.end - r.start >= limit || (!prev && !next)) { pushRun(out, r); continue; }
          changed = true;
          if (!prev || (next && (next.end - next.start) > (prev.end - prev.start))) {
            runs[i + 1] = { cam: next.cam, start: r.start, end: next.end };
          } else {
            prev.end = r.end;
          }
        }
        runs = out;
      }
    }
    return runs;
  }

  function pushRun(out, r) {
    var last = out[out.length - 1];
    if (last && last.cam === r.cam) last.end = r.end;
    else out.push({ cam: r.cam, start: r.start, end: r.end });
  }

  // Middle of the longest pause in active[a, b), or -1 if nobody pauses there.
  function quietestPoint(active, a, b) {
    var bestLen = 0, bestMid = -1, i = Math.max(0, a);
    b = Math.min(active.length, b);
    while (i < b) {
      if (active[i].length) { i++; continue; }
      var j = i;
      while (j < b && !active[j].length) j++;
      if (j - i > bestLen) { bestLen = j - i; bestMid = (i + j) >> 1; }
      i = j;
    }
    return bestMid;
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
    var W = o.windowSec;
    var total = n * W;
    if (!n) return [];

    // 1. Desired camera per window: a camera, null (nobody: hold the shot) or OVERLAP.
    var OVERLAP = {};
    var desired = new Array(n);
    for (var i = 0; i < n; i++) {
      var list = active[i];
      if (!list.length) { desired[i] = null; continue; }
      var first = cams[list[0]];
      var same = true;
      for (var j = 1; j < list.length; j++) if (cams[list[j]] !== first) same = false;
      desired[i] = same ? first : OVERLAP;
    }

    // Resolve cross-talk: long enough -> wide; otherwise it's a hand-over, so cut to
    // whoever carries on talking afterwards, right when they started.
    var minOverlap = Math.round(o.minOverlapSec / W);
    for (var a = 0; a < n;) {
      if (desired[a] !== OVERLAP) { a++; continue; }
      var b = a;
      while (b < n && desired[b] === OVERLAP) b++;
      var fill = null;
      if (o.overlapToWide && wide !== null && b - a >= minOverlap) {
        fill = wide;
      } else {
        var after = null;
        for (var q = b; q < n && q < b + Math.round(3 / W); q++) {
          if (desired[q] !== null && desired[q] !== OVERLAP) { after = desired[q]; break; }
        }
        var inOverlap = false;
        for (var p = a; p < b && after !== null && !inOverlap; p++) {
          for (var k = 0; k < active[p].length; k++) if (cams[active[p][k]] === after) inOverlap = true;
        }
        fill = inOverlap ? after : null;
      }
      for (var f2 = a; f2 < b; f2++) desired[f2] = fill;
      a = b;
    }

    // 2. Raw runs of the same desired camera, holding through silence.
    var runs = [];
    var startCam = wide !== null ? wide : cams[0];
    for (var f = 0; f < n; f++) if (desired[f] !== null) { startCam = desired[f]; break; }
    var cur = startCam, runStart = 0;
    for (var w = 0; w < n; w++) {
      var d = desired[w];
      if (d === null || d === cur) continue;
      runs.push({ cam: cur, start: runStart * W, end: w * W });
      cur = d;
      runStart = w;
    }
    runs.push({ cam: cur, start: runStart * W, end: total });
    runs = mergeEqual(runs.filter(function (r) { return r.end > r.start; }));

    // 3. Enforce minimum shot length.
    runs = absorbShort(runs, o.minShotSec);

    // 4. Cut a little before the speaker starts, without starving the prior shot.
    if (o.leadInSec > 0) {
      for (var lb = 1; lb < runs.length; lb++) {
        var shift = Math.min(o.leadInSec, Math.max(0, (runs[lb - 1].end - runs[lb - 1].start) - o.minShotSec));
        runs[lb - 1].end -= shift;
        runs[lb].start -= shift;
      }
    }

    // 5. Break up long holds with wide cutaways, placed on a pause where there is one.
    if (o.maxShotSec > 0 && wide !== null) {
      var out = [];
      for (var ri = 0; ri < runs.length; ri++) {
        var run = runs[ri];
        if (run.cam === wide || run.end - run.start <= o.maxShotSec) { out.push(run); continue; }
        var t0 = run.start;
        while (run.end - t0 > o.maxShotSec) {
          // Latest allowed cut still leaves a proper shot after the wide.
          var ideal = Math.min(t0 + o.maxShotSec, run.end - o.wideShotSec - o.minShotSec);
          if (ideal < t0 + o.minShotSec) break;
          var earliest = Math.max(t0 + o.minShotSec, ideal - o.maxShotSec * 0.4);
          var mid = quietestPoint(active, Math.ceil(earliest / W), Math.floor(ideal / W));
          var cutAt = mid >= 0 ? mid * W : ideal;
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
    _absorbShort: absorbShort,
    _cleanMask: cleanMask,
    _percentile: percentile
  };
});
