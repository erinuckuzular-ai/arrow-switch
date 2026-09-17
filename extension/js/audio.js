/*
 * Arrow AutoCut — audio loudness extraction.
 *
 * Decodes each mic's source audio with the bundled ffmpeg and turns it into
 * a dB-per-window array laid out on the sequence timeline.
 * Runs in the panel's Node.js context (CEP --enable-nodejs) and in plain Node.
 *
 * Speed:    clips that come from the same file are decoded as one range, ranges run
 *           in parallel, and results are cached on disk so listening again is instant.
 * Accuracy: speech band only (rumble and hiss don't count as talking), and when one
 *           multichannel file sits on several speaker tracks each track hears its own channel.
 */
(function (root, factory) {
  var nodeRequire =
    (root.cep_node && root.cep_node.require) ||
    (typeof require === 'function' ? require : null);
  var api = nodeRequire ? factory(nodeRequire) : null;   // null when previewed in a plain browser
  // Premiere panels run with Node enabled, so `module` exists there too: set both.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AutoCutAudio = api;
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  var childProcess = req('child_process');
  var crypto = req('crypto');
  var fs = req('fs');
  var os = req('os');
  var path = req('path');

  var SAMPLE_RATE = 8000;
  var SILENT_DB = -120;
  var CACHE_VERSION = 3;           // bump when the measurement itself changes
  var MERGE_GAP_SEC = 30;          // clips from one file closer than this decode as one range
  var CACHE_MAX_AGE_MS = 60 * 24 * 3600 * 1000;

  // Speech band: drop rumble/handling noise below 150 Hz; 8 kHz sampling caps the top at 4 kHz.
  var SPEECH_FILTER = 'aresample=' + SAMPLE_RATE + ':filter_size=2,highpass=f=150:poles=2,highpass=f=150:poles=2';

  function findFfmpeg(extensionPath) {
    var exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    var home = process.env.HOME || process.env.USERPROFILE || '';
    var candidates = [
      extensionPath && path.join(extensionPath, 'bin', exe),
      '/Library/Application Support/Adobe/CEP/extensions/com.arrow.autocut/bin/ffmpeg',
      home && path.join(home, 'Library/Application Support/Adobe/CEP/extensions/com.arrow.autocut/bin/ffmpeg'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'Adobe/CEP/extensions/com.arrow.autocut/bin/ffmpeg.exe'),
      process.env.ProgramFiles && path.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles, 'Common Files/Adobe/CEP/extensions/com.arrow.autocut/bin/ffmpeg.exe'),
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
    }
    return null;
  }

  function defaultCacheDir() {
    var home = os.homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'Arrow AutoCut');
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || home, 'Arrow AutoCut', 'Cache');
    return path.join(home, '.cache', 'arrow-autocut');
  }

  // A cancellable batch of ffmpeg processes.
  function createJob() {
    var procs = [];
    return {
      cancelled: false,
      track: function (p) { procs.push(p); },
      cancel: function () {
        this.cancelled = true;
        procs.forEach(function (p) { try { p.kill('SIGKILL'); } catch (e) { /* already gone */ } });
      }
    };
  }

  function cancelledError() {
    var e = new Error('Listening cancelled.');
    e.cancelled = true;
    return e;
  }

  var LAYOUT_CHANNELS = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, '4.0': 4, quad: 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };

  // Number of channels in the first audio stream, or 0 if ffmpeg can't tell.
  function probeChannels(ffmpeg, mediaPath) {
    return new Promise(function (resolve) {
      var p = childProcess.spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', mediaPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      var err = '';
      p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', function () { resolve(0); });
      p.on('close', function () {
        var m = err.match(/Audio: [^\n]*?, \d+ Hz, ([^,\n]+)/);
        if (!m) return resolve(0);
        var layout = m[1].trim().replace(/\(.*\)$/, '');
        var n = /^(\d+) channels/.exec(layout);
        resolve(n ? Number(n[1]) : (LAYOUT_CHANNELS[layout] || 0));
      });
    });
  }

  /*
   * Returns a Promise<Float32Array> of dB levels, one per window, covering
   * `durationSec` of the file starting at `inPointSec`.
   * opts: { channel: 0-based channel to read (default: mix all), job, onProgress(seconds) }
   */
  function clipLevels(ffmpeg, mediaPath, inPointSec, durationSec, windowSec, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (opts.job && opts.job.cancelled) return reject(cancelledError());
      var samplesPerWindow = Math.round(SAMPLE_RATE * windowSec);
      var expected = Math.ceil(durationSec / windowSec);
      var levels = new Float32Array(expected).fill(SILENT_DB);

      var pick = opts.channel == null ? 'aformat=channel_layouts=mono' : 'pan=mono|c0=c' + opts.channel;
      var args = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-ss', inPointSec.toFixed(4),
        '-t', durationSec.toFixed(4),
        '-i', mediaPath,
        '-vn', '-sn', '-dn',
        '-af', pick + ',' + SPEECH_FILTER,
        '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'
      ];
      var proc = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (opts.job) opts.job.track(proc);

      var carry = null, sumSq = 0, count = 0, windowIdx = 0, stderr = '';
      var reported = 0;
      var invScale = 1 / (32768 * 32768);

      function flushWindow() {
        if (windowIdx < expected) {
          var ms = (sumSq / count) * invScale;
          levels[windowIdx] = ms > 0 ? Math.max(SILENT_DB, 10 * Math.log10(ms)) : SILENT_DB;
        }
        windowIdx++;
        sumSq = 0;
        count = 0;
      }

      proc.stdout.on('data', function (chunk) {
        if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
        var n = chunk.length >> 1;
        // Copy when the chunk isn't aligned for a zero-copy Int16 view.
        var samples = (chunk.byteOffset % 2 === 0)
          ? new Int16Array(chunk.buffer, chunk.byteOffset, n)
          : new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + n * 2));
        for (var i = 0; i < n; i++) {
          var v = samples[i];
          sumSq += v * v;
          if (++count === samplesPerWindow) flushWindow();
        }
        if (n * 2 < chunk.length) carry = Buffer.from(chunk.slice(n * 2));
        if (opts.onProgress) {
          var sec = windowIdx * windowSec;
          if (sec - reported >= 5) { opts.onProgress(sec - reported); reported = sec; }
        }
      });
      proc.stderr.on('data', function (d) { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (opts.job && opts.job.cancelled) return reject(cancelledError());
        if (count > 0) flushWindow();
        if (opts.onProgress) opts.onProgress(Math.max(0, durationSec - reported));
        if (code !== 0 && windowIdx === 0) {
          reject(new Error('ffmpeg could not read ' + path.basename(mediaPath) + ': ' + stderr.trim().split('\n').pop()));
        } else {
          resolve(levels);
        }
      });
    });
  }

  // ---------------------------------------------------------------- cache

  function cacheKey(stat, range, windowSec) {
    return crypto.createHash('sha1').update(JSON.stringify([
      CACHE_VERSION, range.path, stat.size, Math.round(stat.mtimeMs), Math.round(range.inPoint * 1000),
      Math.round(range.duration * 1000), range.channel, windowSec
    ])).digest('hex');
  }

  function cacheRead(dir, key, length) {
    try {
      var buf = fs.readFileSync(path.join(dir, key + '.f32'));
      if (buf.length !== length * 4) return null;
      var out = new Float32Array(length);
      new Uint8Array(out.buffer).set(buf);
      return out;
    } catch (e) { return null; }
  }

  function cacheWrite(dir, key, levels) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      var tmp = path.join(dir, key + '.tmp' + process.pid);
      fs.writeFileSync(tmp, Buffer.from(levels.buffer, levels.byteOffset, levels.byteLength));
      fs.renameSync(tmp, path.join(dir, key + '.f32'));
    } catch (e) { /* cache is best-effort */ }
  }

  function cachePrune(dir) {
    try {
      var now = Date.now();
      fs.readdirSync(dir).forEach(function (f) {
        var p = path.join(dir, f);
        try { if (now - fs.statSync(p).mtimeMs > CACHE_MAX_AGE_MS) fs.unlinkSync(p); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* no cache yet */ }
  }

  // ---------------------------------------------------------------- planning

  /*
   * When one file feeds several speaker tracks it is almost always a multichannel
   * recorder (host left, guest right). Give each track its own channel, in track order.
   * Explicit clip.channel values win.
   */
  function assignChannels(ffmpeg, tracks) {
    var users = {};
    tracks.forEach(function (t) {
      t.clips.forEach(function (c) {
        if (!c.path || c.channel != null) return;
        var u = users[c.path] = users[c.path] || [];
        if (u.indexOf(t.index) < 0) u.push(t.index);
      });
    });
    var shared = Object.keys(users).filter(function (p) { return users[p].length > 1; });
    var notes = [];
    return Promise.all(shared.map(function (p) {
      return probeChannels(ffmpeg, p).then(function (channels) {
        var order = users[p].slice().sort(function (a, b) { return a - b; });
        if (channels < order.length) {
          notes.push({ type: 'sharedMono', file: path.basename(p), tracks: order, channels: channels });
          return;
        }
        tracks.forEach(function (t) {
          var ch = order.indexOf(t.index);
          if (ch < 0) return;
          t.clips.forEach(function (c) { if (c.path === p && c.channel == null) c.channel = ch; });
        });
        notes.push({ type: 'splitChannels', file: path.basename(p), tracks: order, channels: channels });
      });
    })).then(function () { return notes; });
  }

  // Groups clips by (file, channel) and merges nearby in-point ranges so each is decoded once.
  function planRanges(tracks) {
    var groups = {};
    tracks.forEach(function (t) {
      t.clips.forEach(function (c) {
        var dur = c.end - c.start;
        if (!c.path || dur <= 0) return;
        var k = c.path + ' ' + (c.channel == null ? '' : c.channel);
        (groups[k] = groups[k] || []).push(c);
      });
    });
    var ranges = [];
    Object.keys(groups).forEach(function (k) {
      var clips = groups[k].sort(function (a, b) { return a.inPoint - b.inPoint; });
      var cur = null;
      clips.forEach(function (c) {
        var a = Math.max(0, c.inPoint), b = c.inPoint + (c.end - c.start);
        if (cur && a <= cur.inPoint + cur.duration + MERGE_GAP_SEC) {
          cur.duration = Math.max(cur.duration, b - cur.inPoint);
        } else {
          cur = { path: c.path, channel: c.channel == null ? null : c.channel, inPoint: a, duration: b - a, clips: [] };
          ranges.push(cur);
        }
        cur.clips.push(c);
        c._range = cur;
      });
    });
    return ranges;
  }

  function runPool(items, limit, worker) {
    var i = 0;
    function lane() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      return worker(item).then(lane);
    }
    var lanes = [];
    for (var n = 0; n < Math.min(limit, items.length); n++) lanes.push(lane());
    return Promise.all(lanes);
  }

  /*
   * tracks: [{ index, clips: [{ path, start, end, inPoint, channel? }] }] in sequence seconds.
   * opts: { cacheDir, concurrency, job, onProgress(doneSec, totalSec) }
   * Resolves { levels: { trackIndex: Float32Array }, notes, cachedSec, decodedSec }.
   */
  function analyzeTracks(ffmpeg, tracks, totalWindows, windowSec, opts) {
    opts = opts || {};
    var cacheDir = opts.cacheDir === undefined ? defaultCacheDir() : opts.cacheDir;
    var concurrency = opts.concurrency || Math.max(2, Math.min(6, os.cpus().length - 1));
    var job = opts.job || createJob();
    // Work on copies: channel assignment annotates clips.
    tracks = tracks.map(function (t) {
      return { index: t.index, clips: t.clips.map(function (c) { return Object.assign({}, c); }) };
    });
    if (cacheDir) cachePrune(cacheDir);

    var notes, ranges, totalSec = 0, doneSec = 0, cachedSec = 0;
    var progress = function (sec) {
      doneSec += sec;
      if (opts.onProgress) opts.onProgress(Math.min(doneSec, totalSec), totalSec);
    };

    return assignChannels(ffmpeg, tracks).then(function (n) {
      notes = n;
      ranges = planRanges(tracks);
      ranges.forEach(function (r) { totalSec += r.duration; });

      // Cache hits first, so the progress bar jumps straight past them.
      var todo = [];
      ranges.forEach(function (r) {
        var len = Math.ceil(r.duration / windowSec);
        if (cacheDir) {
          try {
            r.key = cacheKey(fs.statSync(r.path), r, windowSec);
            r.levels = cacheRead(cacheDir, r.key, len);
          } catch (e) { /* missing file: let ffmpeg report it */ }
        }
        if (r.levels) { cachedSec += r.duration; progress(r.duration); }
        else todo.push(r);
      });
      // Longest first keeps the parallel lanes evenly busy.
      todo.sort(function (a, b) { return b.duration - a.duration; });

      return runPool(todo, concurrency, function (r) {
        return clipLevels(ffmpeg, r.path, r.inPoint, r.duration, windowSec, { channel: r.channel, job: job, onProgress: progress })
          .then(function (lv) {
            r.levels = lv;
            if (cacheDir && r.key) cacheWrite(cacheDir, r.key, lv);
          });
      });
    }).then(function () {
      var levels = {};
      tracks.forEach(function (t) {
        var timeline = new Float32Array(totalWindows).fill(SILENT_DB);
        t.clips.forEach(function (c) {
          var r = c._range;
          if (!r || !r.levels) return;
          var from = Math.round((c.inPoint - r.inPoint) / windowSec);
          var offset = Math.round(c.start / windowSec);
          var len = Math.round((c.end - c.start) / windowSec);
          for (var i = 0; i < len; i++) {
            var t2 = offset + i, s = from + i;
            if (t2 < 0 || t2 >= totalWindows || s < 0 || s >= r.levels.length) continue;
            if (r.levels[s] > timeline[t2]) timeline[t2] = r.levels[s];
          }
        });
        levels[t.index] = timeline;
      });
      return { levels: levels, notes: notes, cachedSec: cachedSec, decodedSec: totalSec - cachedSec };
    });
  }

  // Single-track convenience wrapper (kept for older callers and tests).
  function trackLevels(ffmpeg, track, totalWindows, windowSec, onClipDone) {
    var t = { index: 0, clips: track.clips };
    return analyzeTracks(ffmpeg, [t], totalWindows, windowSec, {
      cacheDir: null,
      onProgress: onClipDone && function (done, total) { onClipDone(done, total); }
    }).then(function (res) { return res.levels[0]; });
  }

  return {
    findFfmpeg: findFfmpeg,
    clipLevels: clipLevels,
    trackLevels: trackLevels,
    analyzeTracks: analyzeTracks,
    createJob: createJob,
    probeChannels: probeChannels,
    defaultCacheDir: defaultCacheDir,
    SAMPLE_RATE: SAMPLE_RATE
  };
});
