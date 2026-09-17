/*
 * Arrow Switch — panel UI.
 * Opened outside Premiere (plain browser), it runs in demo mode with fake data.
 * Demo URLs can start in a given state for screenshots:
 *   ?state=empty|analyzing|result|done|setup|syncing|synced   &theme=dark   &mc=1   &tone=nice
 */
(function () {
  'use strict';

  var Engine = window.ArrowSwitchEngine;
  var Audio = window.ArrowSwitchAudio;
  var Sync = window.ArrowSwitchSync;
  var Xml = window.ArrowSwitchXml;
  var Presets = window.ArrowSwitchPresets;
  var Copy = window.ArrowSwitchCopy;
  var Prproj = window.ArrowSwitchPrproj;
  var IN_PREMIERE = !!window.__adobe_cep__;
  var nodeRequire = (window.cep_node && window.cep_node.require) || null;
  var WINDOW_SEC = Engine.DEFAULTS.windowSec;
  var STORE_KEY = 'arrow-switch-settings';
  var UI_KEY = 'arrow-switch-ui';
  var QUERY = IN_PREMIERE ? '' : location.search;
  var DEMO_STATE = (QUERY.match(/state=(\w+)/) || [])[1];
  var DEMO_MC = /mc=1/.test(QUERY);

  // Panel colour, matching Premiere label (0-15) and marker (0-7) colours.
  var CHANNELS = [
    { color: '#86c9ff', label: 4, marker: 6, labelName: 'Cerulean' },
    { color: '#ff9ec9', label: 6, marker: 1, labelName: 'Rose' },
    { color: '#7fdcb3', label: 2, marker: 0, labelName: 'Caribbean' },
    { color: '#ffd772', label: 15, marker: 4, labelName: 'Yellow' },
    { color: '#b49cff', label: 3, marker: 2, labelName: 'Lavender' },
    { color: '#ffad85', label: 7, marker: 3, labelName: 'Mango' }
  ];
  var WIDE = { color: '#ddd3ea', label: 12, marker: 5, labelName: 'Tan' };

  // Hand-drawn critters, one per speaker. Tap a critter to swap it.
  var CRITTERS = [
    '<path d="M8 34 C4 14 18 4 32 4 C48 4 60 16 56 36 C54 52 44 60 30 60 C14 60 10 50 8 34Z"/>',
    '<rect x="8" y="8" width="48" height="50" rx="10"/><path class="antenna" d="M22 8 L18 0 M42 8 L46 0"/>',
    '<path d="M8 58 V30 C8 12 20 4 32 4 C44 4 56 12 56 30 V58 L48 52 L40 58 L32 52 L24 58 L16 52Z"/>',
    '<path d="M8 58 V22 L14 4 L24 14 H40 L50 4 L56 22 V58Z"/>',
    '<path d="M14 12 C22 0 50 2 54 20 C58 36 44 36 48 50 C50 60 22 64 12 50 C4 38 8 22 14 12Z"/>',
    '<ellipse cx="32" cy="36" rx="24" ry="22"/><path class="antenna" d="M24 15 L18 2 M40 15 L46 2"/>'
  ];

  function critterSvg(index, color) {
    return '<svg class="critter" viewBox="-4 -6 72 72" aria-hidden="true">' +
      '<g style="fill:' + color + '">' + CRITTERS[index % CRITTERS.length] + '</g>' +
      '<ellipse class="shade" cx="42" cy="50" rx="14" ry="8"/><ellipse class="gloss" cx="20" cy="16" rx="7" ry="4" transform="rotate(-30 20 16)"/>' +
      '<circle class="eye" cx="24" cy="30" r="7"/><circle class="eye" cx="40" cy="30" r="7"/>' +
      '<circle class="pupil" cx="25.5" cy="31.5" r="3"/><circle class="pupil" cx="41.5" cy="31.5" r="3"/>' +
      '<path class="smile" d="M26 44 Q32 50 38 44"/><ellipse class="yap" cx="32" cy="46" rx="4" ry="5"/></svg>';
  }

  // The wide shot gets its own critter: a very wide boy with a camera lens for a hat.
  function wideSvg() {
    return '<svg class="critter" viewBox="-6 -8 76 72" aria-hidden="true">' +
      '<rect x="-2" y="14" width="68" height="40" rx="16" style="fill:' + WIDE.color + '"/>' +
      '<rect x="20" y="2" width="24" height="14" rx="5" style="fill:#b7a9cc"/><circle class="lens" cx="32" cy="9" r="5"/><circle class="lens-glint" cx="30.5" cy="7.5" r="1.5"/>' +
      '<ellipse class="shade" cx="50" cy="46" rx="16" ry="6"/><ellipse class="gloss" cx="10" cy="22" rx="8" ry="4" transform="rotate(-20 10 22)"/>' +
      '<circle class="eye" cx="10" cy="32" r="6"/><circle class="eye" cx="54" cy="32" r="6"/>' +
      '<circle class="pupil" cx="11.5" cy="33" r="2.6"/><circle class="pupil" cx="52.5" cy="33" r="2.6"/>' +
      '<path class="smile" d="M12 42 Q32 54 52 42"/><ellipse class="yap" cx="32" cy="46" rx="6" ry="4"/></svg>';
  }

  var SLIDERS = {
    sensitivityDb: function (v) { return v + ' dB'; },
    minTalkSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    minShotSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    maxShotSec: function (v) { return Number(v) === 0 ? 'off' : v + ' s'; },
    wideShotSec: function (v) { return Number(v).toFixed(1) + ' s'; },
    leadInSec: function (v) { return Math.round(v * 1000) + ' ms'; }
  };

  var OUTPUT_DESC = {
    fast: 'Rebuilds the whole edit in one go: real cuts, unused angles gone. Seconds, not minutes.',
    fasthide: 'Rebuilds it in one go with every angle kept, split at each switch and switched off when it’s not on screen.',
    multicam: 'Cuts your multicam clip at every switch and sets the real angle on each piece. Premiere closes and reopens the project for a moment to do it. Pieces stay multicam, so you can re-switch any of them.',
    hide: 'The old way: razors and disables angles inside Premiere. Same result as Fast hide, just much slower.'
  };

  var $ = function (id) { return document.getElementById(id); };

  var ui = { theme: 'auto', tone: 'mean', tab: 'cut' };
  var state = {
    seq: null,
    speakers: [],        // [{ name, audio, video, critter }]
    wideCam: -1,
    preset: 'chatty',
    settings: Object.assign({ overlapToWide: true, output: 'fast' }, Presets.BUILTIN[1].settings),
    levels: {},          // audio track index -> Float32Array
    speech: null,        // last detectSpeech() result, for the lanes and warnings
    segments: null,
    notes: [],
    job: null,
    busy: false,
    listenNote: '',
    pendingMapping: {},  // sequenceId -> mapping from Set up
    setup: { files: [], job: null, busy: false }
  };

  // ---------------------------------------------------------------- talking

  function t(key, vars) { return Copy.line(ui.tone, key, vars); }

  function say(msg, mood) {
    var el = $('status');
    el.innerHTML = msg;
    el.className = mood === 'error' ? 'error' : '';
    void el.offsetWidth;
    el.className += ' pop';
    setMood(mood || 'idle');
  }

  function setMood(mood) { $('mascot').setAttribute('class', 'mascot mood-' + mood); }

  function sayError(err) { say(t('error', { msg: escapeHtml(err && err.message ? err.message : String(err)) }), 'error'); }

  // ---------------------------------------------------------------- host bridge

  function callHost(fn, arg) {
    if (!IN_PREMIERE) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var res = Demo[fn](arg);
          if (!res.ok) reject(new Error(res.error)); else resolve(res);
        }, 30);
      });
    }
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

  function ffmpegPath() {
    if (!Audio) throw new Error('Node.js is off for this panel, so I can’t read audio. Reinstall Arrow Switch and restart Premiere.');
    var extPath = '';
    try { extPath = extensionPath(); } catch (e) { /* fall back to the standard install folders */ }
    var f = Audio.findFfmpeg(extPath);
    if (!f) throw new Error('I can’t find my audio decoder (looked in ' + (extPath || 'the install folder') + '/bin). Reinstall Arrow Switch.');
    return f;
  }

  // ---------------------------------------------------------------- persistence

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* ignore */ } }

  // Presets live in a file when Node is available, so they survive panel reinstalls.
  var presetStore = Presets.createStore((function () {
    if (nodeRequire) {
      var fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os');
      var dir = process.platform === 'win32'
        ? path.join(process.env.APPDATA || os.homedir(), 'Arrow Switch')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Arrow Switch');
      var file = path.join(dir, 'presets.json');
      return {
        read: function () { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } },
        write: function (s) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, s); }
      };
    }
    return { read: function () { return storageGet('arrow-switch-presets'); }, write: function (s) { storageSet('arrow-switch-presets', s); } };
  })());

  function loadSettings() {
    try {
      var saved = JSON.parse(storageGet(STORE_KEY) || storageGet('arrow-autocut-settings') || 'null');
      if (saved) {
        Object.assign(state.settings, saved.settings);
        // Settings from before 1.4 used "hide"/"delete" for the slow razor modes: move them to
        // the fast equivalents once. Later, "hide" means Classic and is left alone.
        if (!saved.v) {
          if (saved.settings && saved.settings.deleteUnused && !saved.settings.output) state.settings.output = 'fast';
          if (state.settings.output === 'delete') state.settings.output = 'fast';
          if (state.settings.output === 'hide') state.settings.output = 'fasthide';
        }
        state.preset = saved.preset || saved.vibe || null;
      }
      Object.assign(ui, JSON.parse(storageGet(UI_KEY) || '{}'));
    } catch (e) { /* defaults are fine */ }
    var qTheme = (QUERY.match(/theme=(\w+)/) || [])[1], qTone = (QUERY.match(/tone=(\w+)/) || [])[1];
    if (qTheme) ui.theme = qTheme;
    if (qTone) ui.tone = qTone;
  }

  function saveSettings() { storageSet(STORE_KEY, JSON.stringify({ v: 2, settings: state.settings, preset: state.preset })); }
  function saveUi() { storageSet(UI_KEY, JSON.stringify(ui)); }

  // ---------------------------------------------------------------- theme + tone + tabs

  function premiereIsDark() {
    try {
      var c = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appSkinInfo.panelBackgroundColor.color;
      return (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;
    } catch (e) {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  }

  function applyTheme() {
    var dark = ui.theme === 'dark' || (ui.theme === 'auto' && premiereIsDark());
    document.body.setAttribute('data-theme', dark ? 'dark' : 'light');
    $('themeBtn').textContent = ui.theme === 'auto' ? '◐' : ui.theme === 'dark' ? '🌙' : '☀️';
    $('themeBtn').title = 'Theme: ' + ui.theme + ' (click to change)';
    if (state.segments && !$('result').hidden) drawPreview(state.segments, state.seq.durationSec);
  }

  function applyTone() {
    $('toneBtn').textContent = ui.tone === 'mean' ? '🍺' : '🧃';
    $('toneBtn').title = ui.tone === 'mean' ? 'Tone: mean (click for nice)' : 'Tone: nice (click for mean)';
  }

  function showTab(tab) {
    ui.tab = tab;
    saveUi();
    $('tabSetup').setAttribute('aria-selected', String(tab === 'setup'));
    $('tabCut').setAttribute('aria-selected', String(tab === 'cut'));
    document.querySelector('.tabs').setAttribute('data-active', tab);
    $('setupPane').hidden = tab !== 'setup';
    $('cutPane').hidden = tab !== 'cut';
    if (tab === 'setup' && !state.setup.busy) say(t('setupHello'));
    if (tab === 'cut' && !state.busy) {
      if (state.seq && state.segments) renderProgram();
      else if (state.seq) say(t('matched'));
      else say(t('hello'));
    }
  }

  // ---------------------------------------------------------------- sequence + matching

  function loadSequence(quiet) {
    return callHost('AC_getSequenceInfo').then(function (seq) {
      var changed = !state.seq || state.seq.id !== seq.id;
      state.seq = seq;
      $('seqLabel').textContent = seq.name;
      $('mcBadge').hidden = !seq.multicam;
      if (changed) {
        state.levels = {};
        state.segments = null;
        state.speech = null;
        state.notes = [];
        state.listenNote = '';
        var pending = state.pendingMapping[seq.id];
        if (pending) {
          state.speakers = pending.speakers;
          state.wideCam = pending.wideCam;
          $('autoTag').hidden = true;
        } else {
          autoMatch(seq);
        }
        if (seq.multicam) {
          // Multicam sequence: real angle switches are almost certainly what you want.
          state.settings.output = 'multicam';
          if (!state.busy) say(t('multicam', { source: escapeHtml(seq.multicam.sourceName) }));
        } else {
          if (state.settings.output === 'multicam') state.settings.output = 'fast';
          if (!state.busy && ui.tab === 'cut') say(t('matched'));
        }
        renderOutputs();
      }
      $('empty').hidden = true;
      $('app').hidden = false;
      renderSpeakers();
      renderProgram();
    }).catch(function (err) {
      state.seq = null;
      $('seqLabel').textContent = 'No sequence';
      $('mcBadge').hidden = true;
      $('empty').hidden = false;
      $('app').hidden = true;
      if (ui.tab !== 'cut') return;
      if (quiet) say(t('hello'));
      else sayError(err);
    });
  }

  function speakerName(track, i) {
    return track.name && !/^Audio \d+$/i.test(track.name) ? track.name : 'Speaker ' + (i + 1);
  }

  // Guess who's who from the tracks. Audio that comes from a camera file (the master or
  // scratch audio) isn't a person's mic. Cameras and mics are paired by name (track name
  // or file name), a track or file called wide/WS/master is the wide, and only what's left
  // falls back to track order.
  function wordsOf(text) {
    return String(text || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[_-]+/g, ' ')
      .replace(CAMERA_WORDS, ' ').split(/[^a-z0-9\u00c0-\u024f]+/).filter(function (w) { return w.length > 1; });
  }
  function trackWords(tr) {
    var custom = tr.name && !/^(audio|video) \d+$/i.test(tr.name) ? tr.name : '';
    return wordsOf(custom + ' ' + (tr.media || []).join(' '));
  }
  function isWideTrack(tr) {
    return WIDE_WORDS.test(tr.name || '') || (tr.media || []).some(function (m) { return WIDE_WORDS.test(m.replace(/[_.-]+/g, ' ')); });
  }

  function autoMatch(seq) {
    var cams = seq.videoTracks.filter(function (tr) { return tr.clipCount > 0; });
    var camMedia = {};
    cams.forEach(function (tr) { (tr.media || []).forEach(function (m) { camMedia[m] = true; }); });
    var fromCamera = function (tr) { return (tr.media || []).length > 0 && tr.media.every(function (m) { return camMedia[m]; }); };

    var mics = seq.audioTracks.filter(function (tr) { return tr.clipCount > 0 && !tr.muted && !fromCamera(tr); });
    if (!mics.length) mics = seq.audioTracks.filter(function (tr) { return tr.clipCount > 0 && !fromCamera(tr); });
    if (!mics.length) mics = seq.audioTracks.filter(function (tr) { return tr.clipCount > 0 && !tr.muted; });
    if (!mics.length) mics = seq.audioTracks.slice(0, 2);
    if (!cams.length) cams = seq.videoTracks.slice(0, 1);

    var taken = {}, camFor = {};
    mics.forEach(function (m) {
      var words = trackWords(m), best = null, bestScore = 0;
      cams.forEach(function (c) {
        if (taken[c.index] || isWideTrack(c)) return;
        var cw = trackWords(c), score = 0;
        words.forEach(function (w) { if (cw.indexOf(w) >= 0) score++; });
        if (score > bestScore) { best = c; bestScore = score; }
      });
      if (best) { camFor[m.index] = best.index; taken[best.index] = true; }
    });

    var wide = cams.filter(isWideTrack)[0];
    if (!wide && cams.length > mics.length && cams.length > 1) wide = cams.filter(function (c) { return !taken[c.index]; })[0];
    state.wideCam = wide ? wide.index : -1;

    var free = cams.filter(function (c) { return !taken[c.index] && c.index !== state.wideCam; });
    state.speakers = mics.map(function (m, i) {
      var video = camFor.hasOwnProperty(m.index) ? camFor[m.index] : null;
      if (video === null) {
        var next = free.shift();
        video = next ? next.index : (cams[Math.min(i, cams.length - 1)] || { index: 0 }).index;
      }
      return { name: speakerName(m, i), audio: m.index, video: video, critter: i };
    });
    $('autoTag').hidden = false;
  }

  // ---------------------------------------------------------------- rendering

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function trackOptions(tracks, prefix, selected, noneLabel) {
    var html = noneLabel ? '<option value="-1">' + noneLabel + '</option>' : '';
    tracks.forEach(function (tr) {
      var custom = tr.name && !/^(Audio|Video) \d+$/i.test(tr.name);
      var label = (state.seq && state.seq.multicam && prefix === 'V' ? 'Angle ' : prefix) + (tr.index + 1) +
        (custom ? '  ' + tr.name : '') + (tr.clipCount ? '' : '  (empty)') + (tr.muted ? '  (muted)' : '');
      html += '<option value="' + tr.index + '"' + (tr.index === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    });
    return html;
  }

  function channel(i) { return CHANNELS[i % CHANNELS.length]; }
  function channelColor(i) { return channel(i).color; }

  function renderSpeakers() {
    var seq = state.seq;
    var box = $('speakers');
    box.innerHTML = '';
    state.speakers.forEach(function (sp, i) {
      var row = document.createElement('div');
      row.className = 'channel';
      row.style.setProperty('--ch', channelColor(i));
      row.style.animationDelay = (i * 0.05) + 's';
      row.innerHTML =
        '<div class="name-row">' +
          '<button class="critter-btn" title="Tap for a different critter" aria-label="Change ' + escapeHtml(sp.name) + '’s critter">' + critterSvg(sp.critter, channelColor(i)) + '</button>' +
          '<input type="text" value="' + escapeHtml(sp.name) + '" aria-label="Speaker name" spellcheck="false">' +
          '<button class="remove" title="Remove speaker" aria-label="Remove ' + escapeHtml(sp.name) + '">×</button>' +
        '</div>' +
        '<label><span class="field-label">Mic</span><select data-kind="audio">' + trackOptions(seq.audioTracks, 'A', sp.audio) + '</select></label>' +
        '<label><span class="field-label">' + (seq.multicam ? 'Angle' : 'Camera') + '</span><select data-kind="video">' + trackOptions(seq.videoTracks, 'V', sp.video) + '</select></label>';

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
        if (state.speakers.length <= 1) return say(t('needSpeaker'), 'error');
        state.speakers.splice(i, 1);
        renderSpeakers();
        mappingChanged();
      });
      box.appendChild(row);
    });
    $('wideCam').innerHTML = trackOptions(seq.videoTracks, 'V', state.wideCam, 'None');
    $('wideIco').innerHTML = wideSvg();
  }

  function renderPresets() {
    var list = presetStore.list();
    var box = $('presets');
    box.innerHTML = list.map(function (p) {
      return '<button class="preset" role="radio" aria-checked="' + (p.id === state.preset) + '" data-id="' + escapeHtml(p.id) + '">' +
        '<b>' + escapeHtml(p.name) + '</b><small>' + escapeHtml(p.blurb || '') + '</small>' +
        (p.builtin ? '' : '<span class="del" role="button" title="Delete preset" data-del="' + escapeHtml(p.id) + '">×</span>') +
        '</button>';
    }).join('') + '<button class="preset add" id="presetAdd" title="Save the current settings as a preset"><b>＋</b><small>save mine</small></button>';

    box.querySelectorAll('.preset[data-id]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var del = e.target.getAttribute('data-del');
        if (del) {
          var gone = presetStore.remove(del);
          if (state.preset === del) state.preset = null;
          renderPresets();
          if (gone) say(t('presetDeleted', { name: escapeHtml(gone.name) }));
          return;
        }
        var p = presetStore.get(b.getAttribute('data-id'));
        if (!p) return;
        state.preset = p.id;
        Object.assign(state.settings, p.settings);
        if (state.seq && state.seq.multicam && state.settings.output === 'hide') state.settings.output = 'multicam';
        if (!(state.seq && state.seq.multicam) && state.settings.output === 'multicam') state.settings.output = 'fast';
        renderSettings();
        renderOutputs();
        saveSettings();
        scheduleRecompute();
      });
    });
    $('presetAdd').addEventListener('click', function () {
      $('savePresetRow').hidden = false;
      $('presetName').value = '';
      $('presetName').focus();
      say(t('presetName'));
    });
  }

  function savePreset() {
    try {
      var p = presetStore.save($('presetName').value, state.settings);
      state.preset = p.id;
      $('savePresetRow').hidden = true;
      renderPresets();
      saveSettings();
      say(t('presetSaved', { name: escapeHtml(p.name) }), 'done');
      setTimeout(function () { if (!state.busy) setMood('idle'); }, 1600);
    } catch (e) {
      say(t('presetName'), 'error');
    }
  }

  function renderSettings() {
    Object.keys(SLIDERS).forEach(function (key) {
      $(key).value = state.settings[key];
      document.querySelector('output[data-for="' + key + '"]').textContent = SLIDERS[key](state.settings[key]);
    });
    $('overlapToWide').checked = state.settings.overlapToWide;
    if (Presets.matching(presetStore.list(), state.settings) !== state.preset) state.preset = Presets.matching(presetStore.list(), state.settings);
    document.querySelectorAll('.preset[data-id]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-id') === state.preset));
    });
    var s = state.settings;
    $('pacingDesc').textContent = 'shots ≥ ' + SLIDERS.minShotSec(s.minShotSec) +
      ' · wide ' + (s.maxShotSec ? 'every ' + s.maxShotSec + ' s' : 'off') +
      ' · ignores blips < ' + SLIDERS.minTalkSec(s.minTalkSec);
  }

  function renderOutputs() {
    var mc = !!(state.seq && state.seq.multicam);
    document.querySelectorAll('#outputs button').forEach(function (b) {
      var o = b.getAttribute('data-output');
      b.disabled = (o === 'multicam' && !mc) || (mc && o === 'hide');
      b.setAttribute('aria-checked', String(state.settings.output === o));
      b.title = b.disabled ? (o === 'multicam' ? 'Needs a multicam or nested sequence clip (Set up can make one)' : 'Not for multicam sequences: use Multicam or a Fast mode') : '';
    });
    $('outputDesc').textContent = OUTPUT_DESC[state.settings.output] || '';
    var o2 = state.settings.output;
    $('apply').textContent = o2 === 'fast' || o2 === 'fasthide' ? '⚡ CUT IT!' : o2 === 'multicam' ? '🎛 SWITCH IT!' : 'CUT IT!';
  }

  function camColor(cam) {
    if (cam === state.wideCam) return WIDE.color;
    for (var i = 0; i < state.speakers.length; i++) if (state.speakers[i].video === cam) return channelColor(i);
    return WIDE.color;
  }

  function speakerIndexForCam(cam) {
    if (cam === state.wideCam) return -1;
    for (var i = 0; i < state.speakers.length; i++) if (state.speakers[i].video === cam) return i;
    return -1;
  }

  function camLabel(cam) {
    var names = state.speakers.filter(function (sp) { return sp.video === cam; }).map(function (sp) { return sp.name; });
    if (cam === state.wideCam) names.unshift('Wide');
    return names.length ? names.join(' / ') : (state.seq && state.seq.multicam ? 'Angle ' : 'V') + (cam + 1);
  }

  function timecode(sec) {
    var s = Math.floor(sec);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function countUp(el, to, suffix) {
    var start = Date.now(), dur = 700;
    (function step() {
      var p = Math.min(1, (Date.now() - start) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + suffix;
      if (p < 1) requestAnimationFrame(step);
    })();
  }

  function renderProgram(reveal) {
    var has = !!state.segments && haveLevelsForAll();
    $('result').hidden = !has;
    $('analyze').hidden = has;
    $('apply').hidden = !has;
    $('reanalyze').hidden = !has;
    $('programMeta').textContent = '';
    $('apply').classList.toggle('ready', has);
    if (!has) return;

    var dur = state.seq.durationSec;
    drawPreview(state.segments, dur);
    if (reveal) {
      var wrap = document.querySelector('.preview-wrap');
      wrap.classList.remove('reveal'); void wrap.offsetWidth; wrap.classList.add('reveal');
    }
    renderWarnings();
    $('rulerMid').textContent = timecode(dur / 2);
    $('rulerEnd').textContent = timecode(dur);

    var perCam = {};
    state.segments.forEach(function (s) { perCam[s.cam] = (perCam[s.cam] || 0) + (s.end - s.start); });
    var cams = Object.keys(perCam).map(Number).sort(function (a, b) { return perCam[b] - perCam[a]; });
    $('legend').innerHTML = cams.map(function (cam, i) {
      var pct = Math.round((perCam[cam] / dur) * 100);
      var who = speakerIndexForCam(cam);
      var icon = who >= 0 ? critterSvg(state.speakers[who].critter, channelColor(who)) : wideSvg();
      return '<div class="legend-row" style="--ch:' + camColor(cam) + ';animation-delay:' + (i * 0.06) + 's">' + icon +
        '<span>' + escapeHtml(camLabel(cam)) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' +
        '<b>' + pct + '%</b></div>';
    }).join('');

    var cuts = Math.max(0, state.segments.length - 1);
    var avg = state.segments.length ? dur / state.segments.length : 0;
    if (reveal) countUp($('programMeta'), cuts, ' cuts!');
    else $('programMeta').textContent = cuts + ' cuts!';
    if (!state.busy) say((state.listenNote || '') + t('result', { cuts: cuts, avg: avg.toFixed(1) }));
  }

  // Top: the cut (one colour per camera). Below: one thin lane per speaker showing
  // when Arrow Switch heard them talking, so a wrong cut is easy to spot and explain.
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
    var dark = document.body.getAttribute('data-theme') === 'dark';
    ctx.clearRect(0, 0, w, cssH);
    segments.forEach(function (s) {
      var x = (s.start / duration) * w;
      var x2 = (s.end / duration) * w;
      ctx.fillStyle = camColor(s.cam);
      ctx.fillRect(Math.floor(x), 0, Math.max(1, Math.ceil(x2) - Math.floor(x)), cutH);
    });
    ctx.fillStyle = 'rgba(59,42,85,0.3)';
    segments.forEach(function (s, i) {
      if (i) ctx.fillRect(Math.round((s.start / duration) * w), 0, 1, cutH);
    });
    if (!lanes) return;
    ctx.fillStyle = dark ? 'rgba(185,163,255,0.35)' : 'rgba(143,113,242,0.35)';
    ctx.fillRect(0, cutH, w, 2);
    state.speech.talking.forEach(function (mask, li) {
      var y = cutH + 4 + li * (LANE_H + LANE_GAP);
      ctx.fillStyle = dark ? 'rgba(185,163,255,0.12)' : 'rgba(143,113,242,0.12)';
      ctx.fillRect(0, y, w, LANE_H);
      ctx.fillStyle = channelColor(li);
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
      callHost('AC_setPlayhead', secAt(e).sec).catch(sayError);
    });
  }

  function renderWarnings() {
    var items = [];
    var sp = state.speech;
    if (sp) {
      var dur = state.seq.durationSec;
      sp.stats.forEach(function (st, i) {
        var who = state.speakers[i];
        if (who && st.talkSec < Math.min(20, dur * 0.01)) items.push(t('barelyHeard', { name: escapeHtml(who.name), track: who.audio + 1 }));
      });
      sp.similar.forEach(function (pair) {
        var a = state.speakers[pair[0]], b = state.speakers[pair[1]];
        if (a && b && a.audio !== b.audio) items.push(t('identical', { a: escapeHtml(a.name), b: escapeHtml(b.name) }));
      });
      var dup = {};
      state.speakers.forEach(function (s, i) {
        if (dup[s.audio] !== undefined) items.push(t('sharedMic', { a: escapeHtml(state.speakers[dup[s.audio]].name), b: escapeHtml(s.name), track: s.audio + 1 }));
        dup[s.audio] = i;
      });
    }
    if (state.patchedGaps) items.push(t('noFootage'));
    state.notes.forEach(function (n) {
      var tracks = n.tracks.map(function (tr) { return 'A' + (tr + 1); }).join(' + ');
      if (n.type === 'splitChannels') items.push(t('splitChannels', { file: escapeHtml(n.file), tracks: tracks }));
      if (n.type === 'sharedMono') items.push(t('sharedMono', { file: escapeHtml(n.file), tracks: tracks, channels: n.channels || 'too few' }));
    });
    $('warnings').innerHTML = items.map(function (h, i) { return '<li style="animation-delay:' + (i * 0.08) + 's">' + h + '</li>'; }).join('');
    $('warnings').hidden = !items.length;
  }

  function renderMeters() {
    $('meters').innerHTML =
      '<div class="meter-crew">' + state.speakers.map(function (sp, i) {
        return '<span class="talking" title="' + escapeHtml(sp.name) + '">' + critterSvg(sp.critter, channelColor(i)) + '</span>';
      }).join('') + '</div>' +
      '<div class="meter"><span class="track"><span class="fill" id="meterFill"></span></span><b id="meterPct">0%</b></div>' +
      '<p class="meter-info" id="meterInfo">Warming up…</p>' +
      '<button id="cancel" class="link">stop listening</button>';
    $('cancel').addEventListener('click', function () { if (state.job) state.job.cancel(); });
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

  function confetti() {
    var box = $('confetti');
    var colors = CHANNELS.map(function (c) { return c.color; }).concat(['#ff7a6b', '#8f71f2']);
    var html = '';
    for (var i = 0; i < 46; i++) {
      var beer = i % 9 === 0;
      html += '<i class="' + (beer ? 'beer' : '') + '" style="left:' + Math.round(Math.random() * 100) + '%;' +
        (beer ? '' : 'background:' + colors[i % colors.length] + ';') +
        '--dx:' + Math.round(Math.random() * 120 - 60) + 'px;--rot:' + Math.round(Math.random() * 720 - 360) + 'deg;' +
        'animation-delay:' + (Math.random() * 0.35).toFixed(2) + 's">' + (beer ? '🍺' : '') + '</i>';
    }
    box.innerHTML = html;
    setTimeout(function () { box.innerHTML = ''; }, 2600);
  }

  // ---------------------------------------------------------------- analysis

  function haveLevelsForAll() {
    return state.speakers.every(function (sp) { return state.levels[sp.audio]; });
  }

  function mappingChanged() {
    if (haveLevelsForAll()) recompute();
    else { state.segments = null; renderProgram(); }
  }

  // Where each camera has footage, on this sequence's timeline (multicam angles are shifted
  // from the source sequence through the multicam clip).
  function coverage() {
    var seq = state.seq, mc = seq.multicam, cover = {};
    seq.videoTracks.forEach(function (tr) {
      if (!tr.cover) return;
      if (!mc) { cover[tr.index] = tr.cover; return; }
      var ranges = [];
      mc.pieces.forEach(function (pc) {
        var shift = pc.start - pc.inPoint;
        tr.cover.forEach(function (r) {
          var a = Math.max(r[0] + shift, pc.start), b = Math.min(r[1] + shift, pc.end);
          if (b > a) ranges.push([a, b]);
        });
      });
      cover[tr.index] = ranges.sort(function (x, y) { return x[0] - y[0]; });
    });
    return cover;
  }

  function decide() {
    var opts = Object.assign({ windowSec: WINDOW_SEC }, state.settings);
    var levels = state.speakers.map(function (sp) { return state.levels[sp.audio]; });
    state.speech = Engine.detectSpeech(levels, opts);
    var segs = Engine.buildEdit(state.speech.active, Object.assign({}, opts, {
      speakerCams: state.speakers.map(function (sp) { return sp.video; }),
      wideCam: state.wideCam >= 0 ? state.wideCam : null
    }));
    var order = [];
    if (state.wideCam >= 0) order.push(state.wideCam);
    state.speakers.forEach(function (sp) { if (order.indexOf(sp.video) < 0) order.push(sp.video); });
    var safe = Engine.avoidEmpty(segs, coverage(), order);
    state.patchedGaps = safe.length !== segs.length || safe.some(function (x, i) { return !segs[i] || x.cam !== segs[i].cam; });
    state.segments = safe;
  }

  function recompute() {
    if (!state.seq || !haveLevelsForAll()) return;
    decide();
    renderProgram();
  }

  function analyze() {
    if (state.busy || !state.seq) return Promise.resolve();
    var needed = [];
    state.speakers.forEach(function (sp) { if (needed.indexOf(sp.audio) < 0) needed.push(sp.audio); });

    setBusy(true);
    say(t('finding'), 'listen');
    $('analyze').hidden = true;

    var ffmpeg;
    return loadSequence(true)
      .then(function () {
        $('analyze').hidden = true;
        if (IN_PREMIERE) ffmpeg = ffmpegPath();
        return callHost('AC_getAudioClips', JSON.stringify(needed));
      })
      .then(function (res) {
        var totalWindows = Math.ceil(state.seq.durationSec / WINDOW_SEC);
        var startedAt = Date.now();
        renderMeters();
        say(t('listening'), 'listen');
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
          res.tracks.forEach(function (tr) { state.levels[tr.index] = out.levels[tr.index]; });
          state.notes = out.notes || [];
          var secs = ((Date.now() - startedAt) / 1000).toFixed(1);
          state.listenNote = out.decodedSec < 1 ? t('cached') : t('listened', { audio: minutes(out.decodedSec + out.cachedSec), secs: secs });
        });
      })
      .then(function () {
        $('meters').hidden = true;
        state.busy = false;
        if (!haveLevelsForAll()) return;
        decide();
        renderProgram(true);
      })
      .catch(function (err) {
        $('meters').hidden = true;
        state.segments = null;
        renderProgram();
        if (err.cancelled) say(t('cancelled'));
        else sayError(err);
      })
      .then(function () { state.job = null; setBusy(false); });
  }

  // ---------------------------------------------------------------- cutting

  function involvedTracks(frames) {
    var tracks = [];
    frames.forEach(function (s) { if (tracks.indexOf(s.cam) < 0) tracks.push(s.cam); });
    state.speakers.forEach(function (sp) { if (tracks.indexOf(sp.video) < 0) tracks.push(sp.video); });
    if (state.wideCam >= 0 && tracks.indexOf(state.wideCam) < 0) tracks.push(state.wideCam);
    return tracks;
  }

  function apply() {
    if (state.busy || !state.segments) return;
    clearTimeout(recomputeTimer);
    recompute();
    var output = state.settings.output;
    var seq = state.seq;
    var frames = Engine.snapToFrames(state.segments, seq.fps);
    var cuts = Math.max(0, frames.length - 1);
    var newName = seq.name + ' – Arrow Switch';
    setBusy(true);
    say(t(output === 'fast' ? 'fastCutting' : 'cutting', { cuts: cuts }), 'cut');
    var started = Date.now();
    var secs = function () { return ((Date.now() - started) / 1000).toFixed(1); };

    // Let the status paint before Premiere blocks the UI thread.
    setTimeout(function () {
      var run;
      if (output === 'multicam') {
        run = multicamCut(frames, newName, secs);
      } else if (output === 'fast' || output === 'fasthide') {
        run = fastCut(frames, newName, output === 'fasthide' ? 'disable' : 'cut').then(function (res) {
          return t(output === 'fasthide' ? 'fastHideDone' : 'fastDone', { name: escapeHtml(res.name), secs: secs() });
        });
      } else {
        run = callHost('AC_applyEdit', JSON.stringify({
          sourceId: seq.id, newName: newName, mode: 'disable', tracks: involvedTracks(frames), segments: frames
        })).then(function (res) {
          if (res.originalUntouched === false) throw new Error(t('changedOriginal', { name: res.name }));
          return t('done', { secs: secs(), name: escapeHtml(res.name) });
        });
      }
      run.then(function (msg) { say(msg, 'done'); confetti(); })
        .catch(sayError)
        .then(function () { setBusy(false); });
    }, 60);
  }

  /*
   * Real multicam angles: razor + tag in Premiere, then close the project, write the angle of
   * every tagged piece into the project file (a backup copy is kept), and reopen it.
   */
  function multicamCut(frames, newName, secs) {
    var seq = state.seq;
    return callHost('AC_applyMulticam', JSON.stringify({
      sourceId: seq.id, newName: newName, trackIndex: seq.multicam.trackIndex, segments: frames
    })).then(function (res) {
      if (!res.count) throw new Error('I cut “' + res.name + '” but found no multicam pieces to switch.');
      if (!res.projectPath) throw new Error('Save the project once first, then try Multicam again.');
      say(t('multicamClosing'), 'cut');
      var names = {};
      Object.keys(res.pieces).forEach(function (tag) { names[tag] = res.pieces[tag].name; });
      return callHost('AC_closeProject').then(function (closed) {
        var outcome = { set: res.count, missing: [] };
        if (IN_PREMIERE) outcome = patchProjectAngles(closed.path, res.pieces);
        return callHost('AC_reopenProject', JSON.stringify({ path: closed.path, sequenceId: res.sequenceId, names: names }))
          .then(function () {
            if (outcome.missing.length) return t('multicamPartial', { count: outcome.set, name: escapeHtml(res.name), missing: outcome.missing.length });
            return t('multicamDone', { count: outcome.set, name: escapeHtml(res.name), secs: secs() });
          });
      });
    });
  }

  function patchProjectAngles(projectPath, pieces) {
    var fs = nodeRequire('fs'), path = nodeRequire('path'), zlib = nodeRequire('zlib');
    var backupDir = path.join(Audio.defaultCacheDir(), 'project-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    var raw = fs.readFileSync(projectPath);
    fs.writeFileSync(path.join(backupDir, path.basename(projectPath, '.prproj') + '-' + Date.now() + '.prproj'), raw);
    var gz = raw[0] === 0x1f && raw[1] === 0x8b;
    var xml = (gz ? zlib.gunzipSync(raw) : raw).toString('utf8');
    var r = Prproj.setAngles(xml, pieces);
    var out = Buffer.from(r.xml, 'utf8');
    fs.writeFileSync(projectPath, gz ? zlib.gzipSync(out) : out);
    return r;
  }

  // Export -> rebuild in JS (real cuts, or every angle kept with the unused parts disabled)
  // -> import. One import instead of thousands of razors.
  function fastCut(frames, newName, mode) {
    var seq = state.seq, mc = seq.multicam;
    var sequenceId = mc ? mc.sourceId : seq.id;
    var shift = 0;
    if (mc) {
      if (mc.pieces.length !== 1) return Promise.reject(new Error('Fast cuts on a multicam needs one continuous multicam clip. Use Multicam mode for this one.'));
      shift = Math.round((mc.pieces[0].inPoint - mc.pieces[0].start) * seq.fps);
    }
    var segments = frames.map(function (s) { return { startFrame: s.startFrame + shift, endFrame: s.endFrame + shift, cam: s.cam }; });
    if (!IN_PREMIERE) return callHost('AC_importXml', JSON.stringify({ name: newName }));
    if (!Xml) return Promise.reject(new Error('The XML module is missing. Reinstall Arrow Switch.'));
    var fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os');
    var dir = path.join(os.tmpdir(), 'arrow-switch');
    fs.mkdirSync(dir, { recursive: true });
    var stamp = Date.now();
    var src = path.join(dir, 'source-' + stamp + '.xml');
    var out = path.join(dir, newName.replace(/[\\/:*?"<>|]/g, '-') + '.xml');
    return callHost('AC_exportXml', JSON.stringify({ sequenceId: sequenceId, path: src })).then(function () {
      var rebuilt = Xml.rebuild(fs.readFileSync(src, 'utf8'), { segments: segments, camTracks: involvedTracks(frames), newName: newName, mode: mode });
      fs.writeFileSync(out, rebuilt.xml);
      return callHost('AC_importXml', JSON.stringify({ path: out, name: newName }));
    });
  }

  // ---------------------------------------------------------------- setup: files

  var fileSeq = 0;

  function addFiles(paths) {
    var known = {};
    state.setup.files.forEach(function (f) { known[f.path] = true; });
    var fresh = paths.filter(function (p) { return p && !known[p]; });
    if (!fresh.length) return Promise.resolve();
    say(t('setupProbing'), 'listen');
    var probe = IN_PREMIERE
      ? function (p) { return Audio.probeMedia(ffmpegPath(), p); }
      : function (p) { return Promise.resolve(Demo.probe(p)); };
    return Promise.all(fresh.map(function (p) {
      return probe(p).then(function (info) {
        return {
          id: ++fileSeq, path: p, name: p.split(/[\\/]/).pop(),
          kind: info.hasVideo ? 'camera' : 'stem', durationSec: info.durationSec, channels: info.channels,
          person: '', cam: null, role: null, status: null
        };
      });
    })).then(function (files) {
      state.setup.files = state.setup.files.concat(files.filter(function (f) { return f.durationSec > 0; }));
      assignSetupRoles();
      renderFiles();
      if (!$('episodeName').value) $('episodeName').value = guessEpisodeName();
      say(t('setupHello'));
    }).catch(sayError);
  }

  function cameras() { return state.setup.files.filter(function (f) { return f.kind === 'camera'; }); }
  function stems() { return state.setup.files.filter(function (f) { return f.kind === 'stem'; }); }

  function prettyName(file) {
    return file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // The folder the files came from is usually the episode ("EP143"); fall back to the first file.
  function guessEpisodeName() {
    var f = cameras()[0] || state.setup.files[0];
    if (!f) return 'New episode';
    var parts = f.path.split(/[\\/]/);
    var folder = parts.length > 1 ? parts[parts.length - 2] : '';
    if (folder && !/^(volumes|users|desktop|downloads|footage|media|video|audio|card|dcim|private|tmp|\d+)$/i.test(folder)) return folder;
    return prettyName(f).replace(/\b(cam(era)?|wide|[a-d])\b.*$/i, '').trim() || 'New episode';
  }

  var WIDE_WORDS = /(^|[^a-z])(wide|ws|master|mastershot|2shot|two ?shot|group|est|establishing|overview)([^a-z]|$)/i;
  var CAMERA_WORDS = /\b(cam(era)?|angle|clip|a|b|c|d|mic|lav|audio|track|take|\d+)\b/gi;

  function nameWords(file) {
    return prettyName(file).toLowerCase().replace(CAMERA_WORDS, ' ').split(/[^a-z0-9\u00c0-\u024f]+/).filter(function (w) { return w.length > 1; });
  }

  // Cameras and mics are matched by name, never by the order files arrived in:
  // "wide/WS/master" is the wide, and a mic goes to the camera that shares its name
  // (Chloe.wav -> CamChloe.mp4). Only what's left over falls back to order.
  function assignSetupRoles() {
    var cams = cameras(), mics = stems();
    var byName = function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; };
    cams.sort(byName);
    mics.sort(byName);
    state.setup.files = cams.concat(mics);

    mics.forEach(function (m) { if (!m.person) m.person = prettyName(m); });
    var taken = {};
    mics.forEach(function (m) {
      if (m.cam !== null && cams.some(function (c) { return c.id === m.cam; })) { taken[m.cam] = true; return; }
      m.cam = null;
      var words = nameWords({ name: m.person });
      var best = null, bestScore = 0;
      cams.forEach(function (c) {
        if (taken[c.id] || WIDE_WORDS.test(prettyName(c))) return;
        var cw = nameWords(c), score = 0;
        words.forEach(function (w) { if (cw.indexOf(w) >= 0 || prettyName(c).toLowerCase().indexOf(w) >= 0) score++; });
        if (score > bestScore) { best = c; bestScore = score; }
      });
      if (best) { m.cam = best.id; taken[best.id] = true; }
    });

    cams.forEach(function (c) {
      if (c.role !== null) return;
      if (WIDE_WORDS.test(prettyName(c))) c.role = 'wide';
    });
    var hasWide = cams.some(function (c) { return c.role === 'wide'; });
    if (!hasWide && cams.length > mics.length && cams.length > 1) {
      var spare = cams.filter(function (c) { return !taken[c.id]; })[0] || cams[0];
      spare.role = 'wide';
    }
    cams.forEach(function (c) { if (c.role === null) c.role = 'close'; });

    var free = cams.filter(function (c) { return c.role === 'close' && !taken[c.id]; });
    mics.forEach(function (m) {
      if (m.cam !== null) return;
      var cam = free.shift() || cams.filter(function (c) { return c.role === 'close'; })[0] || cams[0];
      m.cam = cam ? cam.id : null;
    });
  }

  function durationLabel(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function renderFiles() {
    var cams = cameras(), mics = stems();
    var list = $('fileList');
    list.innerHTML = '';
    cams.concat(mics).forEach(function (f, idx) {
      var li = document.createElement('li');
      li.className = 'file';
      li.style.animationDelay = (idx * 0.04) + 's';
      var meta;
      if (f.kind === 'camera') {
        var shows = mics.filter(function (m) { return m.cam === f.id; }).map(function (m) { return m.person; });
        meta = '<select data-k="role" aria-label="Camera role">' +
            '<option value="wide"' + (f.role === 'wide' ? ' selected' : '') + '>Wide shot</option>' +
            '<option value="close"' + (f.role === 'close' ? ' selected' : '') + '>Close-up</option></select>' +
          '<select data-k="kind" aria-label="File type"><option value="camera" selected>Camera</option><option value="stem">Actually a mic</option></select>' +
          (shows.length ? '<small class="desc" style="grid-column:1/-1;margin:0">shows ' + escapeHtml(shows.join(', ')) + '</small>' : '');
      } else {
        var chan = channel(mics.indexOf(f));
        meta = '<input data-k="person" type="text" value="' + escapeHtml(f.person) + '" aria-label="Who is on this mic" spellcheck="false">' +
          '<select data-k="cam" aria-label="Which camera shows them">' +
          cams.map(function (c) { return '<option value="' + c.id + '"' + (c.id === f.cam ? ' selected' : '') + '>on ' + escapeHtml(prettyName(c)) + '</option>'; }).join('') +
          '<option value="0"' + (f.cam === null ? ' selected' : '') + '>no camera</option></select>';
        li.style.setProperty('--dot', chan.color);
      }
      li.innerHTML = '<i class="ico ' + (f.kind === 'camera' ? 'cam' : 'mic') + '"></i>' +
        '<span class="file-name">' + (f.kind === 'stem' ? '<span class="label-dot" title="Label colour"></span>' : '') + escapeHtml(f.name) + '</span>' +
        '<button class="remove" aria-label="Remove ' + escapeHtml(f.name) + '">×</button>' +
        '<div class="file-meta">' + meta + '</div>';
      li.querySelector('.remove').addEventListener('click', function () {
        li.classList.add('leaving');
        setTimeout(function () {
          state.setup.files = state.setup.files.filter(function (x) { return x.id !== f.id; });
          assignSetupRoles();
          renderFiles();
        }, 220);
      });
      li.querySelectorAll('[data-k]').forEach(function (el) {
        el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function () {
          var k = el.getAttribute('data-k');
          if (k === 'cam') f.cam = Number(el.value) || null;
          else f[k] = el.value;
          if (k === 'kind') { f.role = null; f.cam = null; assignSetupRoles(); }
          if (k !== 'person') renderFiles();
        });
      });
      list.appendChild(li);
    });
    $('syncList').hidden = true;
  }

  function pickFiles() {
    if (!IN_PREMIERE) return addFiles(Demo.fakeFiles());
    var res = window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx
      ? window.cep.fs.showOpenDialogEx(true, false, 'Pick camera files and mic files', '', ['mov', 'mp4', 'mxf', 'm4v', 'avi', 'wav', 'mp3', 'm4a', 'aif', 'aiff', 'flac'])
      : null;
    if (res && res.data && res.data.length) addFiles(res.data);
  }

  // ---------------------------------------------------------------- setup: sync + build

  function renderSyncList(items) {
    $('syncList').hidden = false;
    $('syncList').innerHTML = items.map(function (it, i) {
      return '<li class="sync-item ' + (it.cls || '') + '" style="animation-delay:' + (i * 0.04) + 's"><span class="st">' + it.icon + '</span>' +
        '<span>' + escapeHtml(it.name) + '</span><b>' + (it.note || '') + '</b></li>';
    }).join('');
  }

  function buildEpisode() {
    if (state.setup.busy) return;
    var cams = cameras(), mics = stems();
    if (!cams.length) return say(t('setupNeedCamera'), 'error');
    if (!mics.length) return say(t('setupNeedStem'), 'error');
    var name = $('episodeName').value.trim() || guessEpisodeName();

    // The longest camera is the reference everything else is synced to.
    var ref = cams.slice().sort(function (a, b) { return b.durationSec - a.durationSec; })[0];
    var all = [ref].concat(state.setup.files.filter(function (f) { return f !== ref; }));
    var rows = all.map(function (f) { return { id: f.id, name: f.name, icon: '⏳', note: f === ref ? 'reference' : '' }; });
    renderSyncList(rows);

    setSetupBusy(true);
    say(t('setupSyncing'), 'listen');
    var job = state.setup.job = IN_PREMIERE ? Audio.createJob() : { cancelled: false, cancel: function () { this.cancelled = true; } };
    var ffmpeg = IN_PREMIERE ? ffmpegPath() : null;
    var levels = {}, weak = [];

    function listen(f, row) {
      row.icon = '👂'; row.cls = 'work'; renderSyncList(rows);
      var p = IN_PREMIERE ? Audio.fileLevels(ffmpeg, f.path, 0.01, { job: job }) : Demo.fileLevels(f, job);
      return p.then(function (lv) { levels[f.id] = lv; });
    }

    // Two at a time: fast, without hammering the disk with camera files.
    var queue = all.slice(), i = 0;
    function lane() {
      if (!queue.length) return Promise.resolve();
      var f = queue.shift();
      return listen(f, rows[all.indexOf(f)]).then(function () {
        var row = rows[all.indexOf(f)];
        row.cls = ''; row.icon = '✅'; i++;
        $('buildBtn').textContent = 'LISTENING ' + i + '/' + all.length;
        renderSyncList(rows);
        return lane();
      });
    }

    Promise.all([lane(), lane()]).then(function () {
      var items = [{ id: ref.id, offsetSec: 0, durationSec: ref.durationSec }];
      all.slice(1).forEach(function (f) {
        var row = rows[all.indexOf(f)];
        var r = IN_PREMIERE
          ? Sync.findOffset(levels[ref.id], levels[f.id], { windowSec: 0.01, maxLagSec: Math.max(1800, ref.durationSec) })
          : Demo.offset(f);
        items.push({ id: f.id, offsetSec: r.offsetSec, durationSec: f.durationSec });
        row.note = (r.offsetSec >= 0 ? '+' : '−') + Math.abs(r.offsetSec).toFixed(2) + ' s';
        if (r.confidence < (Sync ? Sync.GOOD_CONFIDENCE : 1.5)) {
          row.icon = '⚠️'; row.cls = 'weak'; weak.push(f.name + ' (match ' + r.confidence.toFixed(1) + ')');
        }
      });
      renderSyncList(rows);
      var plan = Sync ? Sync.planTimeline(items) : Demo.plan(items);
      var startOf = {};
      plan.items.forEach(function (it) { startOf[it.id] = it.startSec; });

      say(t('setupBuilding'), 'cut');
      $('buildBtn').textContent = 'BUILDING…';
      var colour = $('optColour').checked;
      var camOrder = cams.slice().sort(function (a, b) { return (a.role === 'wide' ? 0 : 1) - (b.role === 'wide' ? 0 : 1); });
      var payload = {
        name: name,
        muteCameraAudio: $('optMute').checked,
        multicam: $('optMulticam').checked,
        cameras: camOrder.map(function (c) {
          var who = mics.filter(function (m) { return m.cam === c.id; });
          var label = c.role === 'wide' || !who.length ? WIDE.label : channel(mics.indexOf(who[0])).label;
          return { path: c.path, startSec: startOf[c.id], label: colour ? label : -1, trackName: c.role === 'wide' ? 'Wide' : who.map(function (m) { return m.person; }).join(' + ') || prettyName(c) };
        }),
        stems: mics.map(function (m, j) {
          return { path: m.path, startSec: startOf[m.id], label: colour ? channel(j).label : -1, trackName: m.person };
        })
      };
      return callHost('AC_buildEpisode', JSON.stringify(payload)).then(function (res) {
        var nc = camOrder.length;
        state.pendingMapping[res.sequenceId] = {
          wideCam: camOrder[0].role === 'wide' ? 0 : -1,
          speakers: mics.map(function (m, j) {
            var camIdx = -1;
            camOrder.forEach(function (c, ci) { if (c.id === m.cam) camIdx = ci; });
            return { name: m.person, audio: nc + j, video: camIdx >= 0 ? camIdx : 0, critter: j };
          })
        };
        var msg = res.misplaced && res.misplaced.length
          ? t('setupMisplaced', { name: escapeHtml(res.name), list: escapeHtml(res.misplaced.join(', ')) })
          : t('setupDone', { name: escapeHtml(res.name), files: all.length });
        if (weak.length) msg += ' ' + t('setupWeak', { file: escapeHtml(weak.join(', ')), conf: '' }).replace(' (match )', '');
        confetti();
        state.seq = null;
        showTab('cut');
        return loadSequence(false).then(function () { say(msg, 'done'); });
      });
    }).catch(function (err) {
      if (err && err.cancelled) say(t('cancelled'));
      else sayError(err);
    }).then(function () { setSetupBusy(false); });
  }

  function setSetupBusy(busy) {
    state.setup.busy = busy;
    $('buildBtn').disabled = busy;
    $('buildBtn').classList.toggle('busy-label', busy);
    $('buildBtn').textContent = busy ? 'LISTENING…' : 'SYNC & BUILD';
    $('buildCancel').hidden = !busy;
    $('dropZone').disabled = busy;
  }

  // ---------------------------------------------------------------- UI helpers

  function setBusy(busy) {
    state.busy = busy;
    ['analyze', 'apply', 'reanalyze', 'refresh', 'load', 'addSpeaker'].forEach(function (id) { $(id).disabled = busy; });
    if (!busy && state.segments) $('apply').classList.add('ready');
    else $('apply').classList.remove('ready');
  }

  var recomputeTimer;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 60);
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    $('tabSetup').addEventListener('click', function () { showTab('setup'); });
    $('tabCut').addEventListener('click', function () { showTab('cut'); });
    $('goSetup').addEventListener('click', function () { showTab('setup'); });

    $('themeBtn').addEventListener('click', function () {
      ui.theme = ui.theme === 'auto' ? 'light' : ui.theme === 'light' ? 'dark' : 'auto';
      saveUi(); applyTheme();
    });
    $('toneBtn').addEventListener('click', function () {
      ui.tone = ui.tone === 'mean' ? 'nice' : 'mean';
      saveUi(); applyTone();
      say(ui.tone === 'mean' ? 'Mean mode. Buckle up, buttercup.' : 'Nice mode on. I’ll behave. 🧃');
    });
    if (IN_PREMIERE) {
      try { window.__adobe_cep__.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme); } catch (e) { /* ignore */ }
    }

    // Poke the mascot.
    $('mascot').addEventListener('click', function () {
      if (state.busy || state.setup.busy) return;
      setMood('poke');
      say(ui.tone === 'mean' ? ['Oi. Hands off the beer.', 'Poke me again and I’m cutting to the wide.', 'I’m working. Mostly.'][Math.floor(Math.random() * 3)] : 'Hi there! 👋');
      setTimeout(function () { if (!state.busy) setMood('idle'); }, 700);
    });

    $('load').addEventListener('click', function () { loadSequence(false); });
    $('refresh').addEventListener('click', function () { loadSequence(false); });
    $('analyze').addEventListener('click', analyze);
    $('reanalyze').addEventListener('click', function () { state.levels = {}; state.segments = null; state.speech = null; analyze(); });
    bindPreview();
    $('apply').addEventListener('click', apply);

    $('addSpeaker').addEventListener('click', function () {
      var seq = state.seq;
      var used = state.speakers.map(function (s) { return s.audio; });
      var free = seq.audioTracks.filter(function (tr) { return used.indexOf(tr.index) < 0; })[0] || seq.audioTracks[0];
      state.speakers.push({ name: 'Speaker ' + (state.speakers.length + 1), audio: free.index, video: seq.videoTracks[0].index, critter: state.speakers.length });
      renderSpeakers();
      mappingChanged();
    });

    $('wideCam').addEventListener('change', function () {
      state.wideCam = Number($('wideCam').value);
      $('autoTag').hidden = true;
      mappingChanged();
    });

    Object.keys(SLIDERS).forEach(function (key) {
      $(key).addEventListener('input', function () {
        state.settings[key] = Number($(key).value);
        renderSettings();
        saveSettings();
        scheduleRecompute();
      });
    });
    $('overlapToWide').addEventListener('change', function () {
      state.settings.overlapToWide = $('overlapToWide').checked;
      renderSettings();
      saveSettings();
      scheduleRecompute();
    });

    document.querySelectorAll('#outputs button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        state.settings.output = b.getAttribute('data-output');
        renderOutputs();
        saveSettings();
      });
    });

    $('presetSave').addEventListener('click', savePreset);
    $('presetCancel').addEventListener('click', function () { $('savePresetRow').hidden = true; });
    $('presetName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') savePreset();
      if (e.key === 'Escape') $('savePresetRow').hidden = true;
    });

    // Setup
    $('dropZone').addEventListener('click', pickFiles);
    $('grabSelection').addEventListener('click', function () {
      callHost('AC_getProjectSelection').then(function (res) {
        if (!res.files.length) return say(ui.tone === 'mean' ? 'Nothing selected in the Project panel. Select some clips first, genius.' : 'Select some clips in the Project panel first.', 'error');
        addFiles(res.files.map(function (f) { return f.path; }));
      }).catch(sayError);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ui.tab !== 'setup') showTab('setup');
        $('dropZone').classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        $('dropZone').classList.remove('over');
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files) {
          var paths = [];
          for (var i = 0; i < e.dataTransfer.files.length; i++) paths.push(e.dataTransfer.files[i].path || e.dataTransfer.files[i].name);
          if (IN_PREMIERE) addFiles(paths); else addFiles(Demo.fakeFiles());
        }
      });
    });
    $('buildBtn').addEventListener('click', buildEpisode);
    $('buildCancel').addEventListener('click', function () { if (state.setup.job) state.setup.job.cancel(); });

    // ⌘/Ctrl + Enter does the obvious next thing.
    document.addEventListener('keydown', function (e) {
      if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
      if (ui.tab === 'setup') return buildEpisode();
      if (state.segments && !state.busy) apply(); else analyze();
    });

    window.addEventListener('resize', function () {
      if (state.segments && !$('result').hidden) drawPreview(state.segments, state.seq.durationSec);
    });
  }

  // ---------------------------------------------------------------- demo mode (browser preview)

  var Demo = {
    AC_getSequenceInfo: function () {
      if (DEMO_STATE === 'empty') return { ok: false, error: 'Open a sequence first.' };
      var mc = DEMO_MC ? { sourceId: 'demo-src', sourceName: 'EP 142 Multicam Source', isMulticam: true, trackIndex: 0, pieces: [{ start: 0, end: 3312, inPoint: 0 }] } : null;
      return {
        ok: true, id: 'demo', name: DEMO_MC ? 'EP 142 Edit' : 'EP 142 Multicam', fps: 29.97, durationSec: 3312, multicam: mc,
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
    AC_applyEdit: function () { return { ok: true, name: 'EP 142 Multicam – Arrow Switch', saved: true, originalUntouched: true }; },
    AC_applyMulticam: function () { return { ok: true, name: 'EP 142 Edit – Arrow Switch', sequenceId: 'demo', projectPath: '/demo.prproj', count: 281, razors: 280, pieces: { ASWITCH_1_0: { angle: 1, name: 'EP 142' } } }; },
    AC_closeProject: function () { return { ok: true, path: '/demo.prproj' }; },
    AC_reopenProject: function () { return { ok: true, name: 'EP 142 Edit – Arrow Switch', restored: 0 }; },
    AC_importXml: function () { return { ok: true, name: 'EP 142 Multicam – Arrow Switch' }; },
    AC_setPlayhead: function () { return { ok: true }; },
    AC_getProjectSelection: function () { return { ok: true, files: [] }; },
    AC_buildEpisode: function () { return { ok: true, sequenceId: 'demo', name: 'EP 143 Chloe x Grace', misplaced: [] }; },
    fakeFiles: function () {
      return ['/Volumes/Shoot/EP143/WIDE_A001.mov', '/Volumes/Shoot/EP143/CAM_B_Chloe.mov', '/Volumes/Shoot/EP143/CAM_C_Grace.mov',
        '/Volumes/Shoot/EP143/Chloe.wav', '/Volumes/Shoot/EP143/Grace.wav'];
    },
    probe: function (p) {
      var video = /\.mov$/.test(p);
      return { durationSec: video ? 4012 + p.length : 4100 + p.length * 3, hasVideo: video, channels: video ? 2 : 1 };
    },
    fileLevels: function (f, job) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (job.cancelled) { var e = new Error('cancelled'); e.cancelled = true; return reject(e); }
          resolve(new Float32Array(10));
        }, DEMO_STATE ? 40 : 500 + Math.random() * 700);
      });
    },
    offset: function (f) {
      var seed = f.name.length;
      return { offsetSec: ((seed * 7919) % 2400) / 100 - 6, confidence: /Grace\.wav/.test(f.name) && DEMO_STATE === 'synced' ? 1.2 : 6 + (seed % 5) };
    },
    plan: function (items) {
      var min = Math.min.apply(null, items.map(function (i) { return i.offsetSec; }));
      return { items: items.map(function (i) { return { id: i.id, startSec: i.offsetSec - min }; }) };
    },
    analyze: function (tracks, n, onProgress, job) {
      var total = 3312 * tracks.length, done = 0;
      var parts = tracks.map(function (tr) {
        return Demo.levels(tr, n, function (step, steps) {
          done += 3312 / steps;
          onProgress(done, total);
        }, job);
      });
      return Promise.all(parts).then(function (all) {
        var levels = {};
        tracks.forEach(function (tr, i) { levels[tr.index] = all[i]; });
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
          if (DEMO_STATE === 'analyzing' && step >= 2 + track.index) return clearInterval(tick);
          if (step < steps) return;
          clearInterval(tick);
          var seed = 42;
          var rnd = function () { return (seed = (seed * 16807) % 2147483647) / 2147483647; };
          var out = new Float32Array(n);
          var i = 0, speaker = 0;
          var perSec = 1 / WINDOW_SEC;
          while (i < n) {
            var len = Math.floor((4 + rnd() * 40) * perSec);
            var overlap = rnd() < 0.15 ? Math.floor((2 + rnd() * 3) * perSec) : 0;
            for (var k = i; k < Math.min(n, i + len); k++) {
              var talking = speaker === track.index || k >= i + len - overlap;
              var pause = (k % Math.floor(3 * perSec)) < Math.floor(0.4 * perSec);
              out[k] = talking && !pause ? -22 + rnd() * 6 : (speaker === track.index ? -64 : -40) + rnd() * 4;
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
  bind();
  applyTheme();
  applyTone();
  renderPresets();
  renderSettings();
  renderOutputs();
  var startTab = /setup|syncing|synced/.test(DEMO_STATE || '') ? 'setup' : (IN_PREMIERE ? ui.tab : 'cut');
  loadSequence(true).then(function () {
    showTab(startTab);
    if (!state.seq && startTab === 'cut' && IN_PREMIERE) showTab('cut');
    if (DEMO_STATE === 'analyzing' || DEMO_STATE === 'result') return analyze();
    if (DEMO_STATE === 'done') return analyze().then(apply);
    if (DEMO_STATE === 'setup' || DEMO_STATE === 'syncing' || DEMO_STATE === 'synced') {
      return addFiles(Demo.fakeFiles()).then(function () {
        if (DEMO_STATE === 'syncing') {
          var rows = [cameras()[0]].concat(state.setup.files.slice(1)).map(function (f, i) {
            return { name: f.name, icon: i < 2 ? '✅' : i === 2 ? '👂' : '⏳', cls: i === 2 ? 'work' : '', note: i === 0 ? 'reference' : i === 1 ? '+3.21 s' : '' };
          });
          renderSyncList(rows);
          setSetupBusy(true);
          $('buildBtn').textContent = 'LISTENING 2/5';
          say(t('setupSyncing'), 'listen');
        }
        if (DEMO_STATE === 'synced') buildEpisode();
      });
    }
  });
})();
