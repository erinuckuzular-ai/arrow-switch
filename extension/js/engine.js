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
  var OVERLAP_LO = 0.3;     // fingerprint 30-70% of the way between two speakers = both talking

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

    // 2. Who is talking: the mic "fingerprint". While one person talks alone, the level
    //    differences between the mics stay the same however loud they speak or how the mics
    //    are gained, because they come from where that person sits relative to each mic.
    //    Each speaker gets a fingerprint (a centroid of per-mic level differences), learned
    //    from the clearest moments and refined k-means style. This keeps working when mics
    //    hear each other almost as loud as their own person, which plain loudness can't.
    var nearFloor = new Float32Array(S);
    for (var nf = 0; nf < S; nf++) nearFloor[nf] = stats[nf].floor;
    var sig = new Float32Array(n * S);        // per-window fingerprint, row-major
    var strength = new Float32Array(n);       // best margin over any mic's threshold
    for (var w = 0; w < n; w++) {
      var mean = 0, best = -Infinity;
      for (var k = 0; k < S; k++) {
        var lv = Math.max(sm[k][w], nearFloor[k]);
        sig[w * S + k] = lv;
        mean += lv;
        if (sm[k][w] - stats[k].threshold > best) best = sm[k][w] - stats[k].threshold;
      }
      mean /= S;
      for (var k2 = 0; k2 < S; k2++) sig[w * S + k2] -= mean;
      strength[w] = best;
    }

    // Clear speech only for learning: well above the threshold on some mic.
    var fit = [];
    for (var fw = 0; fw < n; fw++) if (strength[fw] >= 6) fit.push(fw);
    var stride = Math.max(1, Math.floor(fit.length / 40000));

    var cent = [];
    for (var ck = 0; ck < S; ck++) {
      // Start from the moments where this speaker's own mic stands out most.
      var hk = new Histogram(), cVec = new Float64Array(S), cnt0 = 0;
      for (var fi = 0; fi < fit.length; fi += stride) hk.add(sig[fit[fi] * S + ck]);
      var cut = hk.percentile(0.95, 0);
      for (var fj = 0; fj < fit.length; fj += stride) {
        var ww = fit[fj];
        if (sig[ww * S + ck] < cut) continue;
        for (var m = 0; m < S; m++) cVec[m] += sig[ww * S + m];
        cnt0++;
      }
      if (cnt0) for (var m2 = 0; m2 < S; m2++) cVec[m2] /= cnt0;
      else for (var m3 = 0; m3 < S; m3++) cVec[m3] = m3 === ck ? 10 : -10 / Math.max(1, S - 1);
      cent.push(cVec);
    }

    function nearest(w, out) {
      var b1 = -1, d1 = Infinity, b2 = -1, d2 = Infinity;
      for (var c = 0; c < S; c++) {
        var d = 0;
        for (var m = 0; m < S; m++) { var e = sig[w * S + m] - cent[c][m]; d += e * e; }
        if (d < d1) { b2 = b1; d2 = d1; b1 = c; d1 = d; }
        else if (d < d2) { b2 = c; d2 = d; }
      }
      out[0] = b1; out[1] = b2;
    }

    // Position of window w along the line from speaker a's fingerprint to speaker b's
    // (0 = pure a, 1 = pure b); talking over each other lands in between.
    function between(w, a, b) {
      var num = 0, den = 0;
      for (var m = 0; m < S; m++) {
        var seg = cent[b][m] - cent[a][m];
        num += (sig[w * S + m] - cent[a][m]) * seg;
        den += seg * seg;
      }
      return den > 0 ? num / den : 0.5;
    }

    var pair = [0, 0];
    if (S > 1) {
      for (var it = 0; it < 8; it++) {
        var sums = [], counts = new Float64Array(S);
        for (var z0 = 0; z0 < S; z0++) sums.push(new Float64Array(S));
        for (var fk = 0; fk < fit.length; fk += stride) {
          var wk = fit[fk];
          nearest(wk, pair);
          // Learn only from windows that clearly belong to one speaker.
          if (pair[1] >= 0) {
            var tt = between(wk, pair[0], pair[1]);
            if (tt > OVERLAP_LO) continue;
          }
          for (var mz = 0; mz < S; mz++) sums[pair[0]][mz] += sig[wk * S + mz];
          counts[pair[0]]++;
        }
        for (var cz = 0; cz < S; cz++) {
          if (counts[cz] < 20) continue;
          for (var mc = 0; mc < S; mc++) cent[cz][mc] = sums[cz][mc] / counts[cz];
        }
      }
    }

    // Fingerprints closer than this can't be told apart (same mic on two tracks).
    var same = [];
    for (var sa = 0; sa < S; sa++) {
      same.push(new Uint8Array(S));
      for (var sb = 0; sb < S; sb++) {
        var dd = 0;
        for (var md = 0; md < S; md++) { var ee = cent[sa][md] - cent[sb][md]; dd += ee * ee; }
        if (sa !== sb && Math.sqrt(dd) < 2) same[sa][sb] = 1;
      }
    }

    // What each mic hears of each speaker, relative to that speaker's own mic.
    for (var bi = 0; bi < S; bi++) {
      stats[bi].bleed = [];
      for (var bj = 0; bj < S; bj++) stats[bi].bleed.push(bi === bj ? null : Math.round((cent[bi][bj] - cent[bi][bi]) * 10) / 10);
    }

    // 3. Per-speaker talk masks: someone is talking (a mic is over its threshold, with
    //    hysteresis) and the fingerprint says who, or two people when it sits between theirs.
    var masks = [];
    for (var mm = 0; mm < S; mm++) masks.push(new Uint8Array(n));
    var voiced = false;
    for (var v = 0; v < n; v++) {
      voiced = strength[v] > (voiced ? -o.hysteresisDb : 0);
      if (!voiced) continue;
      if (S === 1) { masks[0][v] = 1; continue; }
      nearest(v, pair);
      var who = [pair[0]];
      var t2 = between(v, pair[0], pair[1]);
      if (t2 > OVERLAP_LO && t2 < 1 - OVERLAP_LO) who.push(pair[1]);
      for (var wi = 0; wi < who.length; wi++) {
        masks[who[wi]][v] = 1;
        for (var sx = 0; sx < S; sx++) if (same[who[wi]][sx]) masks[sx][v] = 1;
      }
    }

    var gap = Math.round(o.bridgeGapSec / o.windowSec);
    var minRun = Math.round(o.minTalkSec / o.windowSec);
    // Short bursts (laughs, "no way", "mm") never move the main edit, but they're exactly
    // what reaction shots want, so remember them before they're cleaned away.
    var bursts = [];
    for (var e0 = 0; e0 < S; e0++) {
      cleanMask(masks[e0], gap, 0);
      bursts.push([]);
      for (var b0 = 0; b0 < n;) {
        if (!masks[e0][b0]) { b0++; continue; }
        var b1 = b0, peak = -Infinity;
        while (b1 < n && masks[e0][b1]) { peak = Math.max(peak, sm[e0][b1] - stats[e0].speech); b1++; }
        if (b1 - b0 < minRun) bursts[e0].push({ start: b0 * o.windowSec, end: b1 * o.windowSec, peakDb: peak });
        b0 = b1;
      }
    }
    for (var e = 0; e < S; e++) {
      cleanMask(masks[e], 0, minRun);
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
        if ((diff.count > 50 && diff.percentile(0.1, -99) > -1) || same[p1][p2]) similar.push([p1, p2]);
      }
    }

    // Per window: how far the loudest mic is above its own speaking level (for highlights),
    // and whether anyone at all is over their threshold (for dead air).
    var energy = new Float32Array(n), quiet = new Uint8Array(n);
    for (var q0 = 0; q0 < n; q0++) {
      var top0 = -60;
      for (var q1 = 0; q1 < S; q1++) top0 = Math.max(top0, sm[q1][q0] - stats[q1].speech);
      energy[q0] = top0;
      quiet[q0] = strength[q0] < 0 && !active[q0].length ? 1 : 0;
    }

    return { active: active, talking: masks, stats: stats, similar: similar, bursts: bursts, energy: energy, quiet: quiet, windowSec: o.windowSec };
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

  /*
   * Never cut to a camera that has no footage (cameras that start late or stop early).
   * cover: { cam: [[startSec, endSec], ...] }; cams missing from cover are assumed covered.
   * Each gap is filled from fallbackOrder (usually the wide first), piece by piece, using
   * whatever part of the gap each camera does cover. Only time no camera covers keeps
   * the original shot.
   */
  function avoidEmpty(segments, cover, fallbackOrder) {
    if (!cover) return segments;
    function covered(cam, a, b) {
      if (!cover.hasOwnProperty(cam)) return [[a, b]];
      var out = [];
      cover[cam].forEach(function (r) {
        var x = Math.max(a, r[0]), y = Math.min(b, r[1]);
        if (y > x) out.push([x, y]);
      });
      return out;
    }
    // Pieces of [a, b] not covered by any of the given ranges.
    function holes(ranges, a, b) {
      var out = [], cursor = a;
      ranges.slice().sort(function (x, y) { return x[0] - y[0]; }).forEach(function (r) {
        if (r[0] > cursor + 1e-6) out.push([cursor, r[0]]);
        cursor = Math.max(cursor, r[1]);
      });
      if (b > cursor + 1e-6) out.push([cursor, b]);
      return out;
    }
    var pieces = [];
    function fill(cam, a, b, order) {
      if (!(b > a + 1e-6)) return;
      if (!order.length) { pieces.push({ cam: cam, start: a, end: b }); return; }
      var alt = order[0], got = covered(alt, a, b);
      got.forEach(function (r) { pieces.push({ cam: alt, start: r[0], end: r[1] }); });
      holes(got, a, b).forEach(function (h) { fill(cam, h[0], h[1], order.slice(1)); });
    }
    segments.forEach(function (seg) {
      var own = covered(seg.cam, seg.start, seg.end);
      own.forEach(function (r) { pieces.push({ cam: seg.cam, start: r[0], end: r[1] }); });
      var order = (fallbackOrder || []).filter(function (c) { return c !== seg.cam; });
      holes(own, seg.start, seg.end).forEach(function (h) { fill(seg.cam, h[0], h[1], order); });
    });
    pieces.sort(function (x, y) { return x.start - y.start; });
    return mergeEqual(pieces);
  }

  /*
   * Reaction shots: while one person holds the floor, briefly cut to a listener who laughs or
   * reacts, then back. speech = detectSpeech() result; segments = the edit so far.
   * cfg: { speakerCams, wideCam, reactionEverySec (min gap between reactions, default 20),
   *        reactionSec (shot length, default 1.4), minShotSec }
   * Returns { segments, reactions: [{ start, end, speaker, cam }] }.
   */
  function addReactions(segments, speech, cfg) {
    var every = cfg.reactionEverySec || 20, len = cfg.reactionSec || 1.4;
    var guard = Math.max(1.5, (cfg.minShotSec || 2.5) * 0.6);
    var cams = cfg.speakerCams || [], W = speech.windowSec;
    var candidates = [];
    speech.bursts.forEach(function (list, sp) {
      list.forEach(function (b) {
        var dur = b.end - b.start;
        if (dur < 0.25 || dur > 1.6 || b.peakDb < -9) return;
        candidates.push({ speaker: sp, start: b.start, end: b.end, score: b.peakDb + dur * 4 });
      });
    });
    // Strongest reactions first, then keep the ones that fit the spacing rules.
    candidates.sort(function (a, b) { return b.score - a.score; });
    var chosen = [];
    candidates.forEach(function (c) {
      var cam = cams[c.speaker];
      if (cam === undefined || cam === cfg.wideCam) return;
      var mid = Math.floor(((c.start + c.end) / 2) / W);
      var holders = speech.active[mid] || [];
      // Someone else must be holding the floor, alone, on a different camera.
      var holder = holders.length === 1 ? holders[0] : -1;
      if (holder < 0 || holder === c.speaker) {
        for (var k = Math.floor(c.start / W); k >= 0 && k > Math.floor((c.start - 1) / W); k--) {
          if (speech.active[k] && speech.active[k].length === 1 && speech.active[k][0] !== c.speaker) { holder = speech.active[k][0]; break; }
        }
      }
      if (holder < 0 || holder === c.speaker || cams[holder] === cam) return;
      var start = Math.max(0, c.start - 0.15), end = Math.max(c.end + 0.5, start + len);
      var seg = segmentAtTime(segments, (start + end) / 2);
      if (!seg || seg.cam !== cams[holder]) return;
      if (start - seg.start < guard || seg.end - end < guard) return;
      for (var i = 0; i < chosen.length; i++) if (Math.abs(chosen[i].start - start) < every) return;
      chosen.push({ start: start, end: end, speaker: c.speaker, cam: cam });
    });
    chosen.sort(function (a, b) { return a.start - b.start; });
    if (!chosen.length) return { segments: segments, reactions: [] };

    var out = [], ci = 0;
    segments.forEach(function (seg) {
      var cursor = seg.start;
      while (ci < chosen.length && chosen[ci].start < seg.end) {
        var r = chosen[ci];
        if (r.start >= seg.start && r.end <= seg.end) {
          if (r.start > cursor) out.push({ cam: seg.cam, start: cursor, end: r.start });
          out.push({ cam: r.cam, start: r.start, end: r.end, reaction: true });
          cursor = r.end;
        }
        ci++;
      }
      if (seg.end > cursor) out.push({ cam: seg.cam, start: cursor, end: seg.end });
    });
    return { segments: out, reactions: chosen };
  }

  function segmentAtTime(segments, t) {
    var lo = 0, hi = segments.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (t < segments[mid].start) hi = mid - 1;
      else if (t >= segments[mid].end) lo = mid + 1;
      else return segments[mid];
    }
    return null;
  }

  /*
   * Dead air: stretches where nobody is talking for at least minSec. Each keeps padSec of
   * pause on both sides so the edit still breathes. Returns [{ start, end }] to remove.
   */
  function findDeadAir(speech, opts) {
    var min = (opts && opts.minSec) || 2, pad = opts && opts.padSec !== undefined ? opts.padSec : 0.4;
    var W = speech.windowSec, q = speech.quiet, out = [];
    for (var i = 0; i < q.length;) {
      if (!q[i]) { i++; continue; }
      var j = i;
      while (j < q.length && q[j]) j++;
      var a = i * W + pad, b = j * W - pad;
      // Never trim the head or tail of the episode: that's the editor's call.
      if (i > 0 && j < q.length && (j - i) * W >= min && b > a) out.push({ start: a, end: b });
      i = j;
    }
    return out;
  }

  // Position of t after the ranges are removed (inside a range maps to its start).
  function mapTime(t, ranges) {
    var shift = 0;
    for (var i = 0; i < ranges.length; i++) {
      if (t >= ranges[i].end) shift += ranges[i].end - ranges[i].start;
      else if (t > ranges[i].start) return ranges[i].start - shift;
    }
    return t - shift;
  }

  /*
   * Best clips: the most alive 30-90 s stretches, for social posts. Scores laughs and
   * reactions, quick back-and-forth, loudness and overlap, then snaps each clip to start and
   * end on a pause so it doesn't begin mid-word.
   * Returns [{ start, end, score, reasons: [...] }] best first, non-overlapping.
   */
  function findHighlights(speech, opts) {
    opts = opts || {};
    var count = opts.count || 5, minLen = opts.minSec || 30, maxLen = opts.maxSec || 75;
    var W = speech.windowSec, n = speech.active.length, total = n * W;
    if (total < minLen) return [];
    var step = 5, len = Math.min(maxLen, Math.max(minLen, 45));
    var bins = Math.ceil(total / step);
    var laughs = new Float32Array(bins), turns = new Float32Array(bins), loud = new Float32Array(bins), overlap = new Float32Array(bins);
    speech.bursts.forEach(function (list) {
      list.forEach(function (b) { if (b.peakDb > -9) laughs[Math.min(bins - 1, Math.floor(b.start / step))] += 1; });
    });
    var last = -1;
    for (var i = 0; i < n; i++) {
      var bin = Math.floor((i * W) / step), a = speech.active[i];
      if (a.length === 1 && a[0] !== last) { if (last >= 0) turns[bin] += 1; last = a[0]; }
      if (a.length > 1) overlap[bin] += W;
      loud[bin] += Math.max(0, speech.energy[i] + 6) * W;
    }
    var span = Math.round(len / step), scored = [];
    for (var s0 = 0; s0 + span <= bins; s0++) {
      var L = 0, T = 0, E = 0, O = 0;
      for (var k = s0; k < s0 + span; k++) { L += laughs[k]; T += turns[k]; E += loud[k]; O += overlap[k]; }
      var score = L * 3 + T * 1.5 + E * 0.15 + O * 0.5;
      var reasons = [];
      if (L >= 2) reasons.push(L + ' reactions');
      if (T >= span * 0.5) reasons.push('fast back-and-forth');
      if (O >= 3) reasons.push('talking over each other');
      if (!reasons.length) reasons.push('high energy');
      scored.push({ start: s0 * step, end: (s0 + span) * step, score: score, reasons: reasons });
    }
    scored.sort(function (x, y) { return y.score - x.score; });
    var picked = [];
    for (var p = 0; p < scored.length && picked.length < count; p++) {
      var c = scored[p];
      if (picked.some(function (q) { return c.start < q.end && c.end > q.start; })) continue;
      picked.push(c);
    }
    // Snap edges outward to the nearest pause within 4 s so clips start and end cleanly.
    function snap(t, dir) {
      for (var d = 0; d <= 4 / W; d++) {
        var w = Math.round(t / W) + dir * d;
        if (w <= 0 || w >= n) break;
        if (!speech.active[w].length) return w * W;
      }
      return Math.max(0, Math.min(total, t));
    }
    picked.forEach(function (c) { c.start = snap(c.start, -1); c.end = snap(c.end, 1); c.score = Math.round(c.score); });
    return picked;
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
    avoidEmpty: avoidEmpty,
    addReactions: addReactions,
    findDeadAir: findDeadAir,
    findHighlights: findHighlights,
    mapTime: mapTime,
    summarize: summarize,
    _smoothDb: smoothDb,
    _absorbShort: absorbShort,
    _cleanMask: cleanMask,
    _percentile: percentile
  };
});
