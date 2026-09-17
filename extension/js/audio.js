/*
 * Arrow AutoCut — audio loudness extraction.
 *
 * Decodes each clip's source audio with the bundled ffmpeg and turns it into
 * a dB-per-window array laid out on the sequence timeline.
 * Runs in the panel's Node.js context (CEP --enable-nodejs) and in plain Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require);
  else {
    // Outside CEP (e.g. previewing the panel in a browser) there is no Node.
    var nodeRequire = root.cep_node ? root.cep_node.require : root.require;
    root.AutoCutAudio = nodeRequire ? factory(nodeRequire) : null;
  }
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  var childProcess = req('child_process');
  var fs = req('fs');
  var path = req('path');

  var SAMPLE_RATE = 16000;
  var SILENT_DB = -120;

  function findFfmpeg(extensionPath) {
    var candidates = [
      extensionPath && path.join(extensionPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
    }
    return null;
  }

  /*
   * Returns a Promise<Float32Array> of dB levels, one per window, covering
   * `durationSec` of the file starting at `inPointSec`.
   */
  function clipLevels(ffmpeg, mediaPath, inPointSec, durationSec, windowSec) {
    return new Promise(function (resolve, reject) {
      var samplesPerWindow = Math.round(SAMPLE_RATE * windowSec);
      var expected = Math.ceil(durationSec / windowSec);
      var levels = new Float32Array(expected).fill(SILENT_DB);

      var args = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-ss', inPointSec.toFixed(4),
        '-t', durationSec.toFixed(4),
        '-i', mediaPath,
        '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
      ];
      var proc = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      var carry = null, sumSq = 0, count = 0, windowIdx = 0, stderr = '';

      function flushWindow() {
        if (windowIdx < expected) {
          var rms = Math.sqrt(sumSq / count) / 32768;
          levels[windowIdx] = rms > 0 ? Math.max(SILENT_DB, 20 * Math.log10(rms)) : SILENT_DB;
        }
        windowIdx++;
        sumSq = 0;
        count = 0;
      }

      proc.stdout.on('data', function (chunk) {
        if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
        var usable = chunk.length - (chunk.length % 2);
        for (var i = 0; i < usable; i += 2) {
          var v = chunk.readInt16LE(i);
          sumSq += v * v;
          if (++count === samplesPerWindow) flushWindow();
        }
        if (usable < chunk.length) carry = chunk.slice(usable);
      });
      proc.stderr.on('data', function (d) { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (count > 0) flushWindow();
        if (code !== 0 && windowIdx === 0) {
          reject(new Error('ffmpeg could not read ' + path.basename(mediaPath) + ': ' + stderr.trim().split('\n').pop()));
        } else {
          resolve(levels);
        }
      });
    });
  }

  /*
   * track: { clips: [{ path, start, end, inPoint }] } in sequence seconds.
   * Returns Float32Array of length totalWindows on the sequence timeline.
   */
  function trackLevels(ffmpeg, track, totalWindows, windowSec, onClipDone) {
    var timeline = new Float32Array(totalWindows).fill(SILENT_DB);
    var clips = track.clips.slice();
    var done = 0;

    function next() {
      if (!clips.length) return Promise.resolve(timeline);
      var clip = clips.shift();
      var dur = clip.end - clip.start;
      if (!clip.path || dur <= 0) {
        onClipDone && onClipDone(++done, track.clips.length);
        return next();
      }
      return clipLevels(ffmpeg, clip.path, clip.inPoint, dur, windowSec).then(function (lv) {
        var offset = Math.round(clip.start / windowSec);
        for (var i = 0; i < lv.length; i++) {
          var t = offset + i;
          if (t >= 0 && t < totalWindows && lv[i] > timeline[t]) timeline[t] = lv[i];
        }
        onClipDone && onClipDone(++done, track.clips.length);
        return next();
      });
    }
    return next();
  }

  return { findFfmpeg: findFfmpeg, clipLevels: clipLevels, trackLevels: trackLevels, SAMPLE_RATE: SAMPLE_RATE };
});
