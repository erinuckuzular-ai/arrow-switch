#!/usr/bin/env node
/*
 * Accuracy + speed benchmark on synthetic podcasts with known answers.
 *
 *   node test/bench/accuracy.js                 score the current engine
 *   node test/bench/accuracy.js path/to/js      score another copy of engine.js + audio.js
 *
 * Scores (ignoring 0.6 s either side of each true change, where timing is taste):
 *   on-shot     share of the episode showing the right camera
 *   wrong shots shots that are mostly on the wrong camera
 *   missed      turns of 4 s+ that never got their camera
 *   cut error   median distance from a true hand-over to the cut that serves it
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, SCENARIOS } = require('./podcast.js');

const jsDir = path.resolve((require.main === module && process.argv[2]) || path.join(__dirname, '..', '..', 'extension', 'js'));
const E = require(path.join(jsDir, 'engine.js'));
const A = require(path.join(jsDir, 'audio.js'));
const ffmpeg = A.findFfmpeg(path.join(__dirname, '..', '..', 'extension'));
if (!ffmpeg) { console.error('ffmpeg not found'); process.exit(1); }

const WINDOW = E.DEFAULTS.windowSec;
const BALANCED = { sensitivityDb: 10, minShotSec: 2.5, maxShotSec: 0, wideShotSec: 3, leadInSec: 0.2, overlapToWide: process.env.NO_WIDE ? false : true };

async function levelsFor(tracks, totalWindows, cacheDir) {
  if (A.analyzeTracks) {
    const res = await A.analyzeTracks(ffmpeg, tracks, totalWindows, WINDOW, { cacheDir });
    return tracks.map((t) => res.levels[t.index]);
  }
  return Promise.all(tracks.map((t) => A.trackLevels(ffmpeg, t, totalWindows, WINDOW)));
}

function score(segments, truth, durationSec) {
  const camOf = (who) => (who === 'wide' ? 0 : who + 1);
  const step = 0.05;
  const truthAt = [];
  let fi = 0, current = camOf(truth[0].who);
  for (let t = 0; t < durationSec; t += step) {
    while (fi < truth.length && truth[fi].end <= t) { current = camOf(truth[fi].who); fi++; }
    truthAt.push(fi < truth.length && truth[fi].start <= t ? camOf(truth[fi].who) : current);
  }
  const changes = [];
  for (let i = 1; i < truthAt.length; i++) if (truthAt[i] !== truthAt[i - 1]) changes.push({ t: i * step, cam: truthAt[i] });

  let si = 0;
  const chosenAt = truthAt.map((_, i) => {
    const t = i * step;
    while (si < segments.length - 1 && segments[si].end <= t) si++;
    return segments[si].cam;
  });

  const nearChange = new Uint8Array(truthAt.length);
  for (const c of changes) {
    const a = Math.max(0, Math.floor((c.t - 0.6) / step)), b = Math.min(truthAt.length, Math.ceil((c.t + 0.6) / step));
    for (let i = a; i < b; i++) nearChange[i] = 1;
  }
  let ok = 0, all = 0;
  for (let i = 0; i < truthAt.length; i++) {
    if (nearChange[i]) continue;
    all++;
    if (chosenAt[i] === truthAt[i]) ok++;
  }

  let wrong = 0;
  for (const s of segments) {
    let good = 0, cnt = 0;
    for (let i = Math.floor(s.start / step); i < Math.min(truthAt.length, Math.ceil(s.end / step)); i++) {
      cnt++;
      if (truthAt[i] === s.cam) good++;
    }
    if (cnt && good / cnt < 0.5) wrong++;
  }

  let missed = 0, turns = 0;
  for (let i = 0; i < truthAt.length;) {
    let j = i;
    while (j < truthAt.length && truthAt[j] === truthAt[i]) j++;
    if ((j - i) * step >= 4) {
      turns++;
      let good = 0;
      for (let k = i; k < j; k++) if (chosenAt[k] === truthAt[k]) good++;
      if (good / (j - i) < 0.5) missed++;
    }
    i = j;
  }

  const offsets = [];
  for (const c of changes) {
    let best = Infinity;
    for (let k = 1; k < segments.length; k++) {
      if (segments[k].cam !== c.cam) continue;
      const d = segments[k].start - c.t;
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    if (Math.abs(best) <= 2) offsets.push(Math.abs(best));
  }
  offsets.sort((a, b) => a - b);

  return {
    onShot: ok / all,
    wrong,
    shots: segments.length,
    missed,
    turns,
    cutErr: offsets.length ? offsets[Math.floor(offsets.length / 2)] : NaN
  };
}

function segShare(segs, dur) {
  const t = {};
  for (const x of segs) t[x.cam] = (t[x.cam] || 0) + x.end - x.start;
  return Object.keys(t).sort().map((k) => k + ':' + Math.round((t[k] / dur) * 100)).join(' ');
}

function truthShare(truth) {
  const t = {};
  let total = 0;
  for (const x of truth) { const k = x.who === 'wide' ? 0 : x.who + 1; t[k] = (t[k] || 0) + x.end - x.start; total += x.end - x.start; }
  return Object.keys(t).sort().map((k) => k + ':' + Math.round((t[k] / total) * 100)).join(' ');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arrow-switch-bench-'));
  const only = process.env.SCENARIO;
  const rows = [];
  try {
    for (const name of Object.keys(SCENARIOS)) {
      if (only && only !== name) continue;
      const sc = build(path.join(root, name), SCENARIOS[name]);
      const total = Math.ceil(sc.durationSec / WINDOW);
      const cacheDir = path.join(root, name, 'cache');

      let t0 = Date.now();
      const levels = await levelsFor(sc.tracks, total, cacheDir);
      const listenMs = Date.now() - t0;
      t0 = Date.now();
      await levelsFor(sc.tracks, total, cacheDir);
      const againMs = Date.now() - t0;

      t0 = Date.now();
      const opts = Object.assign({ windowSec: WINDOW }, BALANCED);
      const speech = E.detectSpeech(levels, opts);
      const segs = E.buildEdit(speech.active, Object.assign({}, opts, {
        speakerCams: sc.tracks.map((_, i) => i + 1), wideCam: 0, levels: levels
      }));
      const decideMs = Date.now() - t0;

      const s = score(segs, sc.truth, sc.durationSec);
      rows.push({
        scenario: name,
        'on-shot': (s.onShot * 100).toFixed(1) + '%',
        'wrong shots': s.wrong + '/' + s.shots,
        missed: s.missed + '/' + s.turns,
        'screen %': segShare(segs, sc.durationSec),
        'true %': truthShare(sc.truth),
        'cut error': s.cutErr.toFixed(2) + ' s',
        listen: listenMs + ' ms',
        'listen again': againMs + ' ms',
        decide: decideMs + ' ms'
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.table(rows);
}

module.exports = { score, levelsFor, BALANCED };
if (require.main === module) main();
