/*
 * Arrow AutoCut — panel UI.
 * Opened outside Premiere (plain browser), it runs in demo mode with fake data.
 * Demo URLs can start in a given state for screenshots: ?state=empty|analyzing|result|done
 */
(function () {
  'use strict';

  var Engine = window.AutoCutEngine;
  var Audio = window.AutoCutAudio;
  var IN_PREMIERE = !!window.__adobe_cep__;
  var WINDOW_SEC = Engine.DEFAULTS.windowSec;
  var STORE_KEY = 'arrow-autocut-settings';
  var DEMO_STATE = IN_PREMIERE ? null : (location.search.match(/state=(\w+)/) || [])[1];

  var CHANNEL_COLORS = ['#86c9ff', '#ff9ec9', '#7fdcb3', '#ffd772', '#b49cff', '#ffad85'];
  var WIDE_COLOR = '#ddd3ea';

  // Hand-drawn critters, one per speaker. Tap a critter to swap it.
  var CRITTERS = [
    { name: 'blob',   body: '<path d="M8 34 C4 14 18 4 32 4 C48 4 60 16 56 36 C54 52 44 60 30 60 C14 60 10 50 8 34Z"/>' },
    { name: 'box',    body: '<rect x="8" y="8" width="48" height="50" rx="10"/><path d="M22 8 L18 0 M42 8 L46 0"/>' },
    { name: 'ghost',  body: '<path d="M8 58 V30 C8 12 20 4 32 4 C44 4 56 12 56 30 V58 L48 52 L40 58 L32 52 L24 58 L16 52Z"/>' },
    { name: 'cat',    body: '<path d="M8 58 V22 L14 4 L24 14 H40 L50 4 L56 22 V58Z"/>' },
    { name: 'bean',   body: '<path d="M14 12 C22 0 50 2 54 20 C58 36 44 36 48 50 C50 60 22 64 12 50 C4 38 8 22 14 12Z"/>' },
    { name: 'alien',  body: '<ellipse cx="32" cy="36" rx="24" ry="22"/><path d="M24 15 L18 2 M40 15 L46 2"/><circle cx="18" cy="2" r="2.5"/><circle cx="46" cy="2" r="2.5"/>' }
  ];

  function critterSvg(index, color) {
    var c = CRITTERS[index % CRITTERS.length];
    return '<svg class="critter" viewBox="-4 -6 72 72" aria-hidden="true">' +
      '<g class="critter-body" style="fill:' + color + '">' + c.body + '</g>' +
      // Clay shading: a soft shadow on the lower right, a highlight on the upper left.
      '<ellipse class="shade" cx="42" cy="50" rx="14" ry="8"/><ellipse class="gloss" cx="20" cy="16" rx="7" ry="4" transform="rotate(-30 20 16)"/>' +
      '<g class="critter-face"><circle class="eye" cx="24" cy="30" r="7"/><circle class="eye" cx="40" cy="30" r="7"/>' +
      '<circle class="pupil" cx="25.5" cy="31.5" r="3"/><circle class="pupil" cx="41.5" cy="31.5" r="3"/>' +
      '<path class="smile" d="M26 44 Q32 50 38 44"/><ellipse class="yap" cx="32" cy="46" rx="4" ry="5"/></g></svg>';
  }

  var VIBES = {
    chill:    { sensitivityDb: 12, minShotSec: 4,   maxShotSec: 40, wideShotSec: 4, leadInSec: 0.3, minTalkSec: 1.6 },
    balanced: { sensitivityDb: 10, minShotSec: 2.5, maxShotSec: 25, wideShotSec: 3, leadInSec: 0.2, minTalkSec: 1.2 },
    hype:     { sensitivityDb: 9,  minShotSec: 1.2, maxShotSec: 12, wideShotSec: 2, leadInSec: 0.1, minTalkSec: 0.7 }
  };
  var SLIDERS = {
    sensitivityDb: function (v) { return v + ' dB'; },
    minTalkSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    minShotSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    maxShotSec: function (v) { return Number(v) === 0 ? 'off' : v + ' s'; },
    wideShotSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    leadInSec: function (v) { return Math.round(v * 1000) + ' ms'; }
  };

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    seq: null,
    speakers: [],        // [{ name, audio, video }]
    wideCam: -1,
    vibe: 'balanced',
    settings: Object.assign({ overlapToWide: true, deleteUnused: false }, VIBES.balanced),
    levels: {},          // audio track index -> Float32Array
    speech: null,        // last detectSpeech() result, for the lanes and warnings
    segments: null,
    notes: [],           // from audio analysis (split stereo files etc.)
    job: null,           // running analysis, cancellable
    busy: false
  };

  // ---------------------------------------------------------------- host bridge

  function callHost(fn, arg) {
    if (!IN_PREMIERE) return Promise.resolve(Demo[fn](arg));
    var script = fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
    return new Promise(function (resolve, reject) {
      window.__adobe_cep__.evalScript(script, function (result) {
        var parsed;
        try { parsed = JSON.parse(result); } catch (e) { return reject(new Error('Premiere returned: ' + result)); }
        if (!parsed.ok) return reject(new Error(parsed.error));
        resolve(parsed);
      });
    });
  }

  function extensionPath() {
    var raw = window.__adobe_cep__.getSystemPath('extension');
    return decodeURIComponent(raw.replace(/^file:\/{2,3}/, process.platform === 'win32' ? '' : '/')).replace(/^\/\//, '/');
  }

  // ---------------------------------------------------------------- persistence

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) {
        Object.assign(state.settings, saved.settings);
        state.vibe = saved.vibe;
      }
    } catch (e) { /* storage unavailable; defaults are fine */ }
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, vibe: state.vibe })); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- sequence + matching

  function loadSequence(quiet) {
    return callHost('AC_getSequenceInfo').then(function (seq) {
      var changed = !state.seq || state.seq.id !== seq.id;
      state.seq = seq;
      $('seqLabel').textContent = seq.name;
      if (changed) {
        state.levels = {};
        state.segments = null;
        state.speech = null;
        state.notes = [];
        state.listenNote = '';
        autoMatch(seq);
        say('I matched mics to cameras. Fix any names, pick how cutty, then hit LISTEN!');
      }
      $('empty').hidden = true;
      $('app').hidden = false;
      renderSpeakers();
      renderProgram();
    }).catch(function (err) {
      state.seq = null;
      $('seqLabel').textContent = 'No sequence';
      $('empty').hidden = false;
      $('app').hidden = true;
      if (quiet) say('Hi! Open a podcast sequence in Premiere and I’ll cut it for you.');
      else say(err.message, 'error');
    });
  }

  function speakerName(track, i) {
    return track.name && !/^Audio \d+$/i.test(track.name) ? track.name : 'Speaker ' + (i + 1);
  }

  // Common layouts: V1 = wide + one camera per mic above it, or one camera per mic with no wide.
  function autoMatch(seq) {
    var mics = seq.audioTracks.filter(function (t) { return t.clipCount > 0; });
    var cams = seq.videoTracks.filter(function (t) { return t.clipCount > 0; });
    if (!mics.length) mics = seq.audioTracks.slice(0, 2);
    if (!cams.length) cams = seq.videoTracks.slice(0, 1);

    var hasWide = cams.length > mics.length;
    state.wideCam = hasWide ? cams[0].index : -1;
    var personal = hasWide ? cams.slice(1) : cams;
    state.speakers = mics.map(function (m, i) {
      var cam = personal[Math.min(i, personal.length - 1)];
      return { name: speakerName(m, i), audio: m.index, video: cam ? cam.index : 0, critter: i };
    });
    $('autoTag').hidden = false;
  }

  // ---------------------------------------------------------------- rendering

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function trackOptions(tracks, prefix, selected, noneLabel) {
    var html = noneLabel ? '<option value="-1">' + noneLabel + '</option>' : '';
    tracks.forEach(function (t) {
      var custom = t.name && !/^(Audio|Video) \d+$/i.test(t.name);
      var label = prefix + (t.index + 1) + (custom ? '  ' + t.name : '') + (t.clipCount ? '' : '  (empty)');
      html += '<option value="' + t.index + '"' + (t.index === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    });
    return html;
  }

  function channelColor(i) { return CHANNEL_COLORS[i % CHANNEL_COLORS.length]; }

  function renderSpeakers() {
    var seq = state.seq;
    var box = $('speakers');
    box.innerHTML = '';
    state.speakers.forEach(function (sp, i) {
      var row = document.createElement('div');
      row.className = 'channel';
      row.style.setProperty('--ch', channelColor(i));
      row.innerHTML =
        '<div class="name-row">' +
          '<button class="critter-btn" title="Tap for a different critter" aria-label="Change ' + escapeHtml(sp.name) + '’s critter">' + critterSvg(sp.critter, channelColor(i)) + '</button>' +
          '<input type="text" value="' + escapeHtml(sp.name) + '" aria-label="Speaker name" spellcheck="false">' +
          '<button class="remove" title="Remove speaker" aria-label="Remove ' + escapeHtml(sp.name) + '">×</button>' +
        '</div>' +
        '<label><span class="field-label">Mic</span><select data-kind="audio">' + trackOptions(seq.audioTracks, 'A', sp.audio) + '</select></label>' +
        '<label><span class="field-label">Camera</span><select data-kind="video">' + trackOptions(seq.videoTracks, 'V', sp.video) + '</select></label>';

      row.querySelector('.critter-btn').addEventListener('click', function (e) {
        sp.critter = (sp.critter + 1) % CRITTERS.length;
        var btn = e.currentTarget;
        btn.innerHTML = critterSvg(sp.critter, channelColor(i));
        btn.classList.remove('boing');
        void btn.offsetWidth;
        btn.classList.add('boing');
        if (state.segments) renderProgram();
      });
      row.querySelector('input').addEventListener('input', function (e) {
        sp.name = e.target.value || 'Speaker ' + (i + 1);
        if (state.segments) renderProgram();
      });
      row.querySelectorAll('select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          sp[sel.dataset.kind] = Number(sel.value);
          $('autoTag').hidden = true;
          mappingChanged();
        });
      });
      row.querySelector('.remove').addEventListener('click', function () {
        if (state.speakers.length <= 1) return setStatus('At least one speaker is needed.', 'error');
        state.speakers.splice(i, 1);
        renderSpeakers();
        mappingChanged();
      });
      box.appendChild(row);
    });
    $('wideCam').innerHTML = trackOptions(seq.videoTracks, 'V', state.wideCam, 'None');
  }

  function renderSettings() {
    document.querySelectorAll('.pace button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.vibe === state.vibe));
    });
    Object.keys(SLIDERS).forEach(function (key) {
      $(key).value = state.settings[key];
      document.querySelector('output[data-for="' + key + '"]').textContent = SLIDERS[key](state.settings[key]);
    });
    $('overlapToWide').checked = state.settings.overlapToWide;
    $('deleteUnused').checked = state.settings.deleteUnused;

    var s = state.settings;
    $('pacingDesc').textContent = 'shots ≥ ' + SLIDERS.minShotSec(s.minShotSec) +
      ' · wide ' + (s.maxShotSec ? 'every ' + s.maxShotSec + ' s' : 'off') +
      ' · lead-in ' + SLIDERS.leadInSec(s.leadInSec);
  }

  function camColor(cam) {
    for (var i = 0; i < state.speakers.length; i++) {
      if (state.speakers[i].video === cam) return channelColor(i);
    }
    return WIDE_COLOR;
  }

  function speakerIndexForCam(cam) {
    if (cam === state.wideCam) return -1;
    for (var i = 0; i < state.speakers.length; i++) if (state.speakers[i].video === cam) return i;
    return -1;
  }

  function camLabel(cam) {
    var names = state.speakers.filter(function (sp) { return sp.video === cam; }).map(function (sp) { return sp.name; });
    if (cam === state.wideCam) names.unshift('Wide');
    return names.length ? names.join(' / ') : 'V' + (cam + 1);
  }

  function timecode(sec) {
    var s = Math.floor(sec);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  // Shows whichever of: analyze button, result + cut button.
  function renderProgram() {
    var has = !!state.segments && haveLevelsForAll();
    $('result').hidden = !has;
    $('analyze').hidden = has;
    $('apply').hidden = !has;
    $('reanalyze').hidden = !has;
    $('programMeta').textContent = '';
    if (!has) return;

    var dur = state.seq.durationSec;
    drawPreview(state.segments, dur);
    renderWarnings();
    $('rulerMid').textContent = timecode(dur / 2);
    $('rulerEnd').textContent = timecode(dur);

    var perCam = {};
    state.segments.forEach(function (s) { perCam[s.cam] = (perCam[s.cam] || 0) + (s.end - s.start); });
    var cams = Object.keys(perCam).map(Number).sort(function (a, b) { return perCam[b] - perCam[a]; });
    $('legend').innerHTML = cams.map(function (cam) {
      var pct = Math.round((perCam[cam] / dur) * 100);
      var who = speakerIndexForCam(cam);
      var icon = who >= 0 ? critterSvg(state.speakers[who].critter, channelColor(who)) : '<i></i>';
      return '<div class="legend-row" style="--ch:' + camColor(cam) + '">' + icon +
        '<span>' + escapeHtml(camLabel(cam)) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' +
        '<b>' + pct + '%</b></div>';
    }).join('');

    var cuts = Math.max(0, state.segments.length - 1);
    var avg = state.segments.length ? dur / state.segments.length : 0;
    $('programMeta').textContent = cuts + ' cuts!';
    if (!state.busy) say((state.listenNote || '') + cuts + ' cuts, about ' + avg.toFixed(1) + ' s a shot. Click the strip to check a moment in Premiere, then smash CUT IT!');
  }

  // Top: the cut (one colour per camera). Below: one thin lane per speaker showing
  // when AutoCut heard them talking, so a wrong cut is easy to spot and explain.
  var LANE_H = 6, LANE_GAP = 2;
  function drawPreview(segments, duration) {
    var canvas = $('preview');
    var lanes = state.speech ? state.speech.talking.length : 0;
    var cssH = 34 + lanes * (LANE_H + LANE_GAP) + (lanes ? 4 : 0);
    canvas.style.height = cssH + 'px';
    var ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = cssH * ratio;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    var w = canvas.clientWidth, cutH = 34;
    ctx.clearRect(0, 0, w, cssH);
    segments.forEach(function (s) {
      var x = (s.start / duration) * w;
      var x2 = (s.end / duration) * w;
      ctx.fillStyle = camColor(s.cam);
      ctx.fillRect(Math.floor(x), 0, Math.max(1, Math.ceil(x2) - Math.floor(x)), cutH);
    });
    // Cut marks
    ctx.fillStyle = 'rgba(59,42,85,0.3)';
    segments.forEach(function (s, i) {
      if (i) ctx.fillRect(Math.round((s.start / duration) * w), 0, 1, cutH);
    });
    if (!lanes) return;
    ctx.fillStyle = 'rgba(143,113,242,0.35)';
    ctx.fillRect(0, cutH, w, 2);
    state.speech.talking.forEach(function (mask, li) {
      var y = cutH + 4 + li * (LANE_H + LANE_GAP);
      ctx.fillStyle = 'rgba(143,113,242,0.12)';
      ctx.fillRect(0, y, w, LANE_H);
      ctx.fillStyle = channelColor(li);
      // One pass per pixel column: draw a column if the speaker talks anywhere in it.
      var perPx = mask.length / w;
      for (var px = 0; px < w; px++) {
        var a = Math.floor(px * perPx), b = Math.max(a + 1, Math.floor((px + 1) * perPx));
        for (var i = a; i < b && i < mask.length; i++) {
          if (mask[i]) { ctx.fillRect(px, y, 1, LANE_H); break; }
        }
      }
    });
  }

  function segmentAt(sec) {
    var segs = state.segments || [];
    for (var i = 0; i < segs.length; i++) if (sec < segs[i].end) return segs[i];
    return segs[segs.length - 1];
  }

  function bindPreview() {
    var canvas = $('preview'), tip = $('previewTip');
    function secAt(e) {
      var rect = canvas.getBoundingClientRect();
      var x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      return { sec: (x / rect.width) * state.seq.durationSec, x: x, w: rect.width };
    }
    canvas.addEventListener('mousemove', function (e) {
      if (!state.segments) return;
      var p = secAt(e);
      var seg = segmentAt(p.sec);
      tip.textContent = timecode(p.sec) + ' · ' + (seg ? camLabel(seg.cam) : '');
      tip.hidden = false;
      tip.style.left = Math.max(0, Math.min(p.w - tip.offsetWidth, p.x - tip.offsetWidth / 2)) + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tip.hidden = true; });
    canvas.addEventListener('click', function (e) {
      if (!state.segments) return;
      var sec = secAt(e).sec;
      callHost('AC_setPlayhead', sec).catch(function (err) { setStatus(err.message, 'error'); });
    });
  }

  // Things that usually mean the mapping is wrong, said plainly.
  function renderWarnings() {
    var items = [];
    var sp = state.speech;
    if (sp) {
      var dur = state.seq.durationSec;
      sp.stats.forEach(function (st, i) {
        var who = state.speakers[i];
        if (!who) return;
        if (st.talkSec < Math.min(20, dur * 0.01)) {
          items.push('I barely heard <b>' + escapeHtml(who.name) + '</b> (A' + (who.audio + 1) + '). Right mic track?');
        }
      });
      sp.similar.forEach(function (pair) {
        var a = state.speakers[pair[0]], b = state.speakers[pair[1]];
        if (a && b && a.audio !== b.audio) {
          items.push('<b>' + escapeHtml(a.name) + '</b> and <b>' + escapeHtml(b.name) + '</b> sound identical, so I can’t tell them apart. Use each person’s own mic.');
        }
      });
      var dup = {};
      state.speakers.forEach(function (s) {
        if (dup[s.audio] !== undefined) items.push('<b>' + escapeHtml(state.speakers[dup[s.audio]].name) + '</b> and <b>' + escapeHtml(s.name) + '</b> share mic A' + (s.audio + 1) + '.');
        dup[s.audio] = state.speakers.indexOf(s);
      });
    }
    state.notes.forEach(function (n) {
      var tracks = n.tracks.map(function (t) { return 'A' + (t + 1); }).join(' + ');
      if (n.type === 'splitChannels') items.push('<i>' + escapeHtml(n.file) + '</i> is on ' + tracks + ', so each track hears its own channel.');
      if (n.type === 'sharedMono') items.push('<i>' + escapeHtml(n.file) + '</i> is on ' + tracks + ' but has ' + (n.channels || 'too few') + ' channel(s), so those mics sound the same.');
    });
    $('warnings').innerHTML = items.map(function (h) { return '<li>' + h + '</li>'; }).join('');
    $('warnings').hidden = !items.length;
  }

  function renderMeters() {
    $('meters').innerHTML =
      '<div class="meter-crew">' + state.speakers.map(function (sp, i) {
        return '<span class="talking" style="--ch:' + channelColor(i) + '" title="' + escapeHtml(sp.name) + '">' + critterSvg(sp.critter, channelColor(i)) + '</span>';
      }).join('') + '</div>' +
      '<div class="meter" style="--ch:' + channelColor(0) + '">' +
        '<span class="track"><span class="fill" id="meterFill"></span></span>' +
        '<b id="meterPct">0%</b></div>' +
      '<p class="meter-info" id="meterInfo">Warming up…</p>' +
      '<button id="cancel" class="link">stop listening</button>';
    $('cancel').addEventListener('click', function () {
      if (state.job) state.job.cancel();
    });
    $('meters').hidden = false;
  }

  function minutes(sec) { return sec < 90 ? Math.round(sec) + ' s' : Math.round(sec / 60) + ' min'; }

  function setMeter(done, total, startedAt) {
    var pct = total ? done / total : 0;
    $('meterFill').style.width = Math.round(pct * 100) + '%';
    $('meterPct').textContent = Math.round(pct * 100) + '%';
    var elapsed = (Date.now() - startedAt) / 1000;
    var info = minutes(done) + ' of ' + minutes(total) + ' of audio';
    if (pct > 0.05 && pct < 1 && elapsed > 1) info += ' · about ' + minutes(elapsed * (1 - pct) / pct) + ' left';
    $('meterInfo').textContent = info;
  }

  // ---------------------------------------------------------------- analysis

  function haveLevelsForAll() {
    return state.speakers.every(function (sp) { return state.levels[sp.audio]; });
  }

  function mappingChanged() {
    if (haveLevelsForAll()) recompute();
    else { state.segments = null; renderProgram(); }
  }

  function recompute() {
    if (!state.seq || !haveLevelsForAll()) return;
    var opts = Object.assign({ windowSec: WINDOW_SEC }, state.settings);
    var levels = state.speakers.map(function (sp) { return state.levels[sp.audio]; });
    var speech = state.speech = Engine.detectSpeech(levels, opts);
    state.segments = Engine.buildEdit(speech.active, Object.assign({}, opts, {
      speakerCams: state.speakers.map(function (sp) { return sp.video; }),
      wideCam: state.wideCam >= 0 ? state.wideCam : null
    }));
    renderProgram();
  }

  function analyze() {
    if (state.busy || !state.seq) return;
    var needed = [];
    state.speakers.forEach(function (sp) { if (needed.indexOf(sp.audio) < 0) needed.push(sp.audio); });

    setBusy(true);
    say('Finding the mic files…', 'listen');
    $('analyze').hidden = true;

    var ffmpeg;
    return loadSequence(true)
      .then(function () {
        $('analyze').hidden = true;
        if (IN_PREMIERE) {
          if (!Audio) throw new Error('Node.js is off for this panel, so I can’t read audio. Reinstall AutoCut and restart Premiere.');
          var extPath = '';
          try { extPath = extensionPath(); } catch (e) { /* fall back to the standard install folders */ }
          ffmpeg = Audio.findFfmpeg(extPath);
          if (!ffmpeg) throw new Error('I can’t find my audio decoder (looked in ' + (extPath || 'the install folder') + '/bin). Reinstall AutoCut.');
        }
        return callHost('AC_getAudioClips', JSON.stringify(needed));
      })
      .then(function (res) {
        var totalWindows = Math.ceil(state.seq.durationSec / WINDOW_SEC);
        var startedAt = Date.now();
        renderMeters();
        say('Shhh… I’m listening to everyone’s mic.', 'listen');
        var onProgress = function (done, total) { setMeter(done, total, startedAt); };
        var run;
        if (IN_PREMIERE) {
          state.job = Audio.createJob();
          run = Audio.analyzeTracks(ffmpeg, res.tracks, totalWindows, WINDOW_SEC, { job: state.job, onProgress: onProgress });
        } else {
          state.job = { cancel: function () { this.cancelled = true; } };
          run = Demo.analyze(res.tracks, totalWindows, onProgress, state.job);
        }
        return run.then(function (out) {
          res.tracks.forEach(function (t) { state.levels[t.index] = out.levels[t.index]; });
          state.notes = out.notes || [];
          var secs = ((Date.now() - startedAt) / 1000).toFixed(1);
          state.listenNote = out.decodedSec < 1
            ? 'I remembered this audio from last time. '
            : 'Listened to ' + minutes(out.decodedSec + out.cachedSec) + ' of audio in ' + secs + ' s. ';
        });
      })
      .then(function () {
        $('meters').hidden = true;
        state.busy = false;
        recompute();
      })
      .catch(function (err) {
        $('meters').hidden = true;
        state.segments = null;
        renderProgram();
        if (err.cancelled) say('Okay, I stopped. Hit LISTEN! when you’re ready.');
        else setStatus(err.message, 'error');
      })
      .then(function () { state.job = null; setBusy(false); });
  }

  function apply() {
    if (state.busy || !state.segments) return;
    clearTimeout(recomputeTimer);
    recompute();   // pick up any setting change still waiting on the debounce
    setBusy(true);
    var frames = Engine.snapToFrames(state.segments, state.seq.fps);
    var tracks = [];
    frames.forEach(function (s) { if (tracks.indexOf(s.cam) < 0) tracks.push(s.cam); });
    state.speakers.forEach(function (sp) { if (tracks.indexOf(sp.video) < 0) tracks.push(sp.video); });
    if (state.wideCam >= 0 && tracks.indexOf(state.wideCam) < 0) tracks.push(state.wideCam);

    var payload = {
      sourceId: state.seq.id,
      newName: state.seq.name + ' – AutoCut',
      mode: state.settings.deleteUnused ? 'delete' : 'disable',
      tracks: tracks,
      segments: frames
    };
    say('Snip snip! Making ' + (frames.length - 1) + ' cuts. Premiere might freeze for a sec…', 'cut');
    // Let the status paint before Premiere blocks the UI thread.
    var cutStarted = Date.now();
    setTimeout(function () {
      callHost('AC_applyEdit', JSON.stringify(payload))
        .then(function (res) {
          var secs = ((Date.now() - cutStarted) / 1000).toFixed(1);
          say('Done in ' + secs + ' s! Look for “' + res.name + '” in your project. Your original is untouched.', 'done');
        })
        .catch(function (err) { setStatus(err.message, 'error'); })
        .then(function () { setBusy(false); });
    }, 50);
  }

  // ---------------------------------------------------------------- UI helpers

  function setMood(mood) {
    $('mascot').setAttribute('class', 'mascot mood-' + mood);
  }

  function say(msg, mood) {
    var el = $('status');
    el.textContent = msg;
    el.className = mood === 'error' ? 'error' : '';
    setMood(mood || 'idle');
  }

  function setBusy(busy) {
    state.busy = busy;
    ['analyze', 'apply', 'reanalyze', 'refresh', 'load', 'addSpeaker'].forEach(function (id) { $(id).disabled = busy; });
  }

  function setStatus(msg, kind) {
    say(msg, kind === 'error' ? 'error' : kind === 'ok' ? 'done' : kind);
  }

  var recomputeTimer;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 60);
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    $('load').addEventListener('click', function () { loadSequence(false); });
    $('refresh').addEventListener('click', function () { loadSequence(false); });
    $('analyze').addEventListener('click', analyze);
    $('reanalyze').addEventListener('click', function () { state.levels = {}; state.segments = null; state.speech = null; analyze(); });
    bindPreview();
    $('apply').addEventListener('click', apply);

    $('addSpeaker').addEventListener('click', function () {
      var seq = state.seq;
      var used = state.speakers.map(function (s) { return s.audio; });
      var free = seq.audioTracks.filter(function (t) { return used.indexOf(t.index) < 0; })[0] || seq.audioTracks[0];
      state.speakers.push({ name: 'Speaker ' + (state.speakers.length + 1), audio: free.index, video: seq.videoTracks[0].index, critter: state.speakers.length });
      renderSpeakers();
      mappingChanged();
    });

    $('wideCam').addEventListener('change', function () {
      state.wideCam = Number($('wideCam').value);
      $('autoTag').hidden = true;
      mappingChanged();
    });

    document.querySelectorAll('.pace button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.vibe = b.dataset.vibe;
        Object.assign(state.settings, VIBES[state.vibe]);
        renderSettings();
        saveSettings();
        scheduleRecompute();
      });
    });

    Object.keys(SLIDERS).forEach(function (key) {
      $(key).addEventListener('input', function () {
        state.settings[key] = Number($(key).value);
        state.vibe = null;
        renderSettings();
        saveSettings();
        scheduleRecompute();
      });
    });

    ['overlapToWide', 'deleteUnused'].forEach(function (key) {
      $(key).addEventListener('change', function () {
        state.settings[key] = $(key).checked;
        saveSettings();
        scheduleRecompute();
      });
    });

    window.addEventListener('resize', function () {
      if (state.segments && !$('result').hidden) drawPreview(state.segments, state.seq.durationSec);
    });
  }

  // ---------------------------------------------------------------- demo mode (browser preview)

  var Demo = {
    AC_getSequenceInfo: function () {
      if (DEMO_STATE === 'empty') return { ok: false, error: 'Open a sequence first.' };
      return {
        ok: true, id: 'demo', name: 'EP 142 Multicam', fps: 29.97, durationSec: 3312,
        videoTracks: [
          { index: 0, name: 'Wide', clipCount: 1 },
          { index: 1, name: 'Cam A', clipCount: 1 },
          { index: 2, name: 'Cam B', clipCount: 1 }
        ],
        audioTracks: [
          { index: 0, name: 'Maya', clipCount: 1 },
          { index: 1, name: 'Jordan', clipCount: 1 },
          { index: 2, name: 'Audio 3', clipCount: 0 }
        ]
      };
    },
    AC_getAudioClips: function (json) {
      return { ok: true, tracks: JSON.parse(json).map(function (i) { return { index: i, clips: [{}, {}, {}, {}] }; }) };
    },
    AC_applyEdit: function () {
      return { ok: true, name: 'EP 142 Multicam – AutoCut' };
    },
    analyze: function (tracks, n, onProgress, job) {
      var total = 3312 * tracks.length, done = 0;
      var parts = tracks.map(function (t) {
        return Demo.levels(t, n, function (step, steps) {
          done += 3312 / steps;
          onProgress(done, total);
        }, job);
      });
      return Promise.all(parts).then(function (all) {
        var levels = {};
        tracks.forEach(function (t, i) { levels[t.index] = all[i]; });
        return { levels: levels, notes: [], decodedSec: total, cachedSec: 0 };
      });
    },
    // Fake conversation: alternating turns of random length with occasional cross-talk.
    levels: function (track, n, onDone, job) {
      return new Promise(function (resolve, reject) {
        var steps = 4, step = 0;
        var tick = setInterval(function () {
          if (job && job.cancelled) { clearInterval(tick); var e = new Error('cancelled'); e.cancelled = true; return reject(e); }
          step++;
          onDone(step, steps);
          // In the "analyzing" screenshot state, stop part-way.
          if (DEMO_STATE === 'analyzing' && step >= 2 + track.index) return clearInterval(tick);
          if (step < steps) return;
          clearInterval(tick);
          var seed = 42;
          var rnd = function () { return (seed = (seed * 16807) % 2147483647) / 2147483647; };
          var out = new Float32Array(n);
          var i = 0, speaker = 0;
          while (i < n) {
            var perSec = 1 / WINDOW_SEC;
            var len = Math.floor((4 + rnd() * 40) * perSec);
            var overlap = rnd() < 0.15 ? Math.floor((2 + rnd() * 3) * perSec) : 0;
            for (var k = i; k < Math.min(n, i + len); k++) {
              var talking = speaker === track.index || k >= i + len - overlap;
              out[k] = talking ? -22 + rnd() * 6 : -58 + rnd() * 4;
            }
            i += len;
            speaker = speaker === 0 ? 1 : 0;
          }
          resolve(out);
        }, DEMO_STATE ? 60 : 350 + track.index * 120);
      });
    }
  };

  // ---------------------------------------------------------------- start

  loadSettings();
  if (DEMO_STATE) { state.vibe = 'balanced'; Object.assign(state.settings, VIBES.balanced); }
  bind();
  renderSettings();
  loadSequence(true).then(function () {
    if (DEMO_STATE === 'analyzing' || DEMO_STATE === 'result') return analyze();
    if (DEMO_STATE === 'done') return analyze().then(apply);
  });
})();
