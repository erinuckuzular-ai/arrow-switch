/*
 * Arrow Switch — automatic audio sync.
 *
 * Pure functions, no Premiere or Node dependencies (see test/sync.test.js).
 * Works on the dB-per-window arrays from audio.js fileLevels(): a camera's
 * scratch audio and a lav stem sound nothing alike sample-for-sample, but
 * people start and stop talking at the same moments in both.
 *
 *   levels (dB per window)
 *     -> envelope()     gain- and noise-floor-independent speech onsets
 *     -> coarse FFT cross-correlation on a decimated envelope
 *     -> exact correlation at full resolution around the coarse peak
 *     -> parabolic interpolation for sub-window accuracy
 */
(function (root, factory) {
  var api = factory();
  // Premiere panels run with Node enabled, so `module` exists there too: set both.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchSync = api;
  else root.ArrowSwitchSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    windowSec: 0.01,
    maxLagSec: 1800,
    coarseSec: 0.04,      // search resolution; keeps a 90 min FFT at 2^19 instead of 2^21
    averageSec: 1,        // moving average removed from the envelope (cancels gain and slow level drift)
    floorAboveNoiseDb: 6, // everything quieter than this above the noise floor counts as silence
    exclusionSec: 0.5     // the runner-up peak must be at least this far from the winner
  };

  // Confidence at or above this is a reliable match (see findOffset).
  var GOOD_CONFIDENCE = 1.5;

  function option(opts, key) {
    return opts && opts[key] != null ? opts[key] : DEFAULTS[key];
  }

  // Approximate percentile via a 0.5 dB histogram: avoids sorting half a million values.
  function percentileDb(levels, p) {
    var lo = -120, bins = 481, hist = new Uint32Array(bins), n = levels.length;
    for (var i = 0; i < n; i++) {
      var b = Math.round((levels[i] - lo) * 2);
      hist[b < 0 ? 0 : (b >= bins ? bins - 1 : b)]++;
    }
    var target = p * n, acc = 0;
    for (var j = 0; j < bins; j++) {
      acc += hist[j];
      if (acc >= target) return lo + j / 2;
    }
    return 0;
  }

  /*
   * Speech activity envelope, zero-mean and unit-variance.
   * Returns null when the track has no usable variation (silence, a steady tone).
   */
  function envelope(levels, windowSec, opts) {
    var n = levels.length;
    if (n < 3) return null;
    // Different mics have different noise floors: clamp each to its own, so hiss
    // fluctuations in the quiet parts don't correlate with anything.
    var floor = percentileDb(levels, 0.1) + option(opts, 'floorAboveNoiseDb');
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) x[i] = levels[i] > floor ? levels[i] : floor;

    // Subtracting a local average makes gain differences (a constant dB offset) vanish.
    var half = Math.max(1, Math.round(option(opts, 'averageSec') / windowSec / 2));
    var prefix = new Float64Array(n + 1);
    for (i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
    var out = new Float64Array(n), sum = 0, sumSq = 0;
    for (i = 0; i < n; i++) {
      var a = i - half < 0 ? 0 : i - half;
      var b = i + half + 1 > n ? n : i + half + 1;
      var v = x[i] - (prefix[b] - prefix[a]) / (b - a);
      if (v < 0) v = 0;
      out[i] = v;
      sum += v;
      sumSq += v * v;
    }
    var mean = sum / n, variance = sumSq / n - mean * mean;
    if (!(variance > 1e-9)) return null;
    var inv = 1 / Math.sqrt(variance);
    for (i = 0; i < n; i++) out[i] = (out[i] - mean) * inv;
    return out;
  }

  function decimate(x, factor) {
    if (factor <= 1) return x;
    var m = Math.floor(x.length / factor), out = new Float64Array(m);
    for (var i = 0; i < m; i++) {
      var s = 0, base = i * factor;
      for (var j = 0; j < factor; j++) s += x[base + j];
      out[i] = s / factor;
    }
    return out;
  }

  // In-place iterative radix-2 FFT. sign = 1 forward, -1 inverse (unscaled).
  function fft(re, im, sign) {
    var n = re.length, i, j, k, t;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = sign * 2 * Math.PI / len, wStepRe = Math.cos(ang), wStepIm = Math.sin(ang), halfLen = len >> 1;
      for (i = 0; i < n; i += len) {
        var wRe = 1, wIm = 0;
        for (k = 0; k < halfLen; k++) {
          var p = i + k, q = p + halfLen;
          var xr = re[q] * wRe - im[q] * wIm;
          var xi = re[q] * wIm + im[q] * wRe;
          re[q] = re[p] - xr; im[q] = im[p] - xi;
          re[p] += xr; im[p] += xi;
          t = wRe * wStepRe - wIm * wStepIm;
          wIm = wRe * wStepIm + wIm * wStepRe;
          wRe = t;
        }
      }
    }
  }

  /*
   * corr[k] = sum_t ref[t + k] * x[t] for k in [minLag, maxLag], via FFT.
   * Returns a Float64Array indexed by k - minLag.
   */
  function crossCorrelate(ref, x, minLag, maxLag) {
    var size = 1;
    while (size < ref.length + x.length) size <<= 1;
    var aRe = new Float64Array(size), aIm = new Float64Array(size);
    var bRe = new Float64Array(size), bIm = new Float64Array(size);
    aRe.set(ref);
    bRe.set(x);
    fft(aRe, aIm, 1);
    fft(bRe, bIm, 1);
    for (var i = 0; i < size; i++) {
      // A * conj(B)
      var r = aRe[i] * bRe[i] + aIm[i] * bIm[i];
      var m = aIm[i] * bRe[i] - aRe[i] * bIm[i];
      aRe[i] = r;
      aIm[i] = m;
    }
    bRe = bIm = null;
    fft(aRe, aIm, -1);
    var out = new Float64Array(maxLag - minLag + 1), scale = 1 / size;
    for (var k = minLag; k <= maxLag; k++) out[k - minLag] = aRe[k < 0 ? size + k : k] * scale;
    return out;
  }

  function dotAtLag(ref, x, k) {
    var from = k < 0 ? -k : 0, to = Math.min(x.length, ref.length - k), s = 0;
    for (var t = from; t < to; t++) s += ref[t + k] * x[t];
    return s;
  }

  /*
   * Where `levels` sample 0 sits on the reference timeline.
   * refLevels, levels: dB per window at opts.windowSec (default 0.01).
   * opts: { windowSec, maxLagSec }
   * Returns { offsetSec, confidence }. offsetSec < 0 means the clip starts before the reference.
   * confidence = correlation peak / best other peak more than 0.5 s away.
   * >= 1.5 is a solid match; ~1.0-1.2 means noise (no shared audio); 0 means one track is silent.
   */
  function findOffset(refLevels, levels, opts) {
    var windowSec = option(opts, 'windowSec');
    var none = { offsetSec: 0, confidence: 0 };
    var ref = envelope(refLevels, windowSec, opts);
    var x = envelope(levels, windowSec, opts);
    if (!ref || !x) return none;

    var factor = Math.max(1, Math.round(option(opts, 'coarseSec') / windowSec));
    var cRef = decimate(ref, factor), cX = decimate(x, factor);
    if (cRef.length < 2 || cX.length < 2) { factor = 1; cRef = ref; cX = x; }
    var coarseSec = windowSec * factor;
    var maxLagWin = Math.round(option(opts, 'maxLagSec') / coarseSec);
    // Lags beyond this have no overlap at all.
    var minLag = Math.max(-maxLagWin, -(cX.length - 1));
    var maxLag = Math.min(maxLagWin, cRef.length - 1);
    if (minLag > maxLag) return none;

    var corr = crossCorrelate(cRef, cX, minLag, maxLag);
    var best = 0;
    for (var i = 1; i < corr.length; i++) if (corr[i] > corr[best]) best = i;
    if (!(corr[best] > 0)) return none;

    var excl = Math.round(option(opts, 'exclusionSec') / coarseSec), runnerUp = 0;
    for (i = 0; i < corr.length; i++) {
      if (Math.abs(i - best) <= excl) continue;
      var isPeak = (i === 0 || corr[i] >= corr[i - 1]) && (i === corr.length - 1 || corr[i] >= corr[i + 1]);
      if (isPeak && corr[i] > runnerUp) runnerUp = corr[i];
    }
    var confidence = runnerUp > 0 ? corr[best] / runnerUp : 100;

    // Refine at full resolution a couple of coarse windows either side.
    var centre = (best + minLag) * factor, span = 2 * factor;
    var fineMin = Math.max(centre - span, -(x.length - 1));
    var fineMax = Math.min(centre + span, ref.length - 1);
    var fine = [], fineBest = 0;
    for (var k = fineMin; k <= fineMax; k++) {
      fine.push(dotAtLag(ref, x, k));
      if (fine[fine.length - 1] > fine[fineBest]) fineBest = fine.length - 1;
    }
    var delta = 0;
    if (fineBest > 0 && fineBest < fine.length - 1) {
      var a = fine[fineBest - 1], b = fine[fineBest], c = fine[fineBest + 1];
      var denom = a - 2 * b + c;
      if (denom < 0) delta = 0.5 * (a - c) / denom;
    }
    return {
      offsetSec: (fineMin + fineBest + delta) * windowSec,
      confidence: Math.min(100, confidence)
    };
  }

  /*
   * results: [{ id, offsetSec, durationSec }] on the reference timeline (reference at 0).
   * Returns { items: [{ id, startSec }], totalSec } shifted so the earliest item starts at 0.
   */
  function planTimeline(results) {
    if (!results.length) return { items: [], totalSec: 0 };
    var earliest = Infinity;
    results.forEach(function (r) { if (r.offsetSec < earliest) earliest = r.offsetSec; });
    var total = 0;
    var items = results.map(function (r) {
      var start = r.offsetSec - earliest;
      if (start + (r.durationSec || 0) > total) total = start + (r.durationSec || 0);
      return { id: r.id, startSec: start };
    });
    return { items: items, totalSec: total };
  }

  return {
    DEFAULTS: DEFAULTS,
    GOOD_CONFIDENCE: GOOD_CONFIDENCE,
    findOffset: findOffset,
    planTimeline: planTimeline,
    _envelope: envelope,
    _fft: fft,
    _crossCorrelate: crossCorrelate
  };
});
