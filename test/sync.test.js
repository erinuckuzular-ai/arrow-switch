const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../extension/js/sync.js');
const A = require('../extension/js/audio.js');

const W = 0.01;

function rng(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Conversation-like "true" loudness: talk spells made of syllables, separated by pauses.
function world(seconds, seed) {
  const r = rng(seed), n = Math.round(seconds / W), out = new Float32Array(n).fill(-120);
  let i = 0;
  while (i < n) {
    i += Math.round((0.1 + r() * 1.2) / W);
    const end = Math.min(n, i + Math.round((0.5 + r() * 4) / W));
    const speaker = -25 - r() * 10;
    while (i < end) {
      const syl = Math.round((0.08 + r() * 0.2) / W), level = speaker + (r() - 0.5) * 12;
      for (let k = 0; k < syl && i < end; k++, i++) out[i] = level;
      i += Math.round(r() * 0.08 / W);
    }
  }
  return out;
}

// What a particular mic records: gain, its own noise floor, and a little measurement jitter.
function mic(src, from, length, gainDb, noiseDb, seed) {
  const r = rng(seed), out = new Float32Array(length).fill(-120);
  for (let i = 0; i < length; i++) {
    const s = src[from + i];
    const p = (s === undefined ? 0 : Math.pow(10, (s + gainDb) / 10)) + Math.pow(10, (noiseDb + (r() - 0.5) * 3) / 10);
    out[i] = 10 * Math.log10(p);
  }
  return out;
}

const near = (actual, expected, tol = 0.02) =>
  assert.ok(Math.abs(actual - expected) <= tol, `offset ${actual.toFixed(4)} s, expected ${expected} s`);

test('finds a positive offset (stem starts after the camera)', () => {
  const w = world(600, 1);
  const cam = mic(w, 0, 50000, 0, -60, 2);
  const stem = mic(w, 1234, 40000, 0, -60, 3);
  const res = S.findOffset(cam, stem);
  near(res.offsetSec, 12.34);
  assert.ok(res.confidence >= S.GOOD_CONFIDENCE, `confidence ${res.confidence}`);
});

test('finds a negative offset (stem starts before the camera)', () => {
  const w = world(600, 4);
  const cam = mic(w, 10000, 40000, 0, -60, 5);
  const stem = mic(w, 10000 - 321, 45000, 0, -60, 6);
  const res = S.findOffset(cam, stem);
  near(res.offsetSec, -3.21);
  assert.ok(res.confidence >= S.GOOD_CONFIDENCE, `confidence ${res.confidence}`);
});

test('ignores gain and noise floor differences between camera mic and lav', () => {
  const w = world(900, 7);
  const cam = mic(w, 5000, 60000, -18, -48, 8);   // far away, noisy room
  const lav = mic(w, 5000 + 2345, 30000, 6, -85, 9);  // close and clean
  const res = S.findOffset(cam, lav);
  near(res.offsetSec, 23.45);
  assert.ok(res.confidence >= S.GOOD_CONFIDENCE, `confidence ${res.confidence}`);
});

test('partial overlap: stem runs past the end of the camera', () => {
  const w = world(900, 10);
  const cam = mic(w, 0, 30000, 0, -55, 11);
  const stem = mic(w, 24000, 40000, -12, -70, 12); // only the first 60 s overlap
  const res = S.findOffset(cam, stem);
  near(res.offsetSec, 240);
  assert.ok(res.confidence >= S.GOOD_CONFIDENCE, `confidence ${res.confidence}`);
});

test('no signal or unrelated audio gives low confidence', () => {
  const silent = new Float32Array(20000).fill(-120);
  const w = world(300, 13);
  const cam = mic(w, 0, 20000, 0, -60, 14);
  assert.strictEqual(S.findOffset(silent, cam).confidence, 0);
  assert.strictEqual(S.findOffset(cam, silent).confidence, 0);
  const other = mic(world(300, 99), 0, 20000, 0, -60, 15);
  const res = S.findOffset(cam, other);
  assert.ok(res.confidence < S.GOOD_CONFIDENCE, `unrelated audio confidence ${res.confidence}`);
});

test('maxLagSec limits the search', () => {
  const w = world(600, 16);
  const cam = mic(w, 0, 50000, 0, -60, 17);
  const stem = mic(w, 30000, 20000, 0, -60, 18);
  near(S.findOffset(cam, stem).offsetSec, 300);
  const limited = S.findOffset(cam, stem, { maxLagSec: 100 });
  assert.ok(Math.abs(limited.offsetSec) <= 100.5);
});

test('planTimeline shifts everything so the earliest file starts at 0', () => {
  const plan = S.planTimeline([
    { id: 'cam', offsetSec: 0, durationSec: 100 },
    { id: 'host', offsetSec: -3.21, durationSec: 90 },
    { id: 'guest', offsetSec: 12.34, durationSec: 95 }
  ]);
  assert.deepStrictEqual(plan.items.map((i) => i.id), ['cam', 'host', 'guest']);
  near(plan.items[0].startSec, 3.21, 1e-9);
  near(plan.items[1].startSec, 0, 1e-9);
  near(plan.items[2].startSec, 15.55, 1e-9);
  near(plan.totalSec, 110.55, 1e-9);
  assert.deepStrictEqual(S.planTimeline([]), { items: [], totalSec: 0 });
});

test('benchmark: 90-minute pair correlates quickly', () => {
  const w = world(95 * 60, 21);
  const cam = mic(w, 0, 540000, -10, -50, 22);
  const stem = mic(w, 12345, 530000, 3, -80, 23);
  const t0 = process.hrtime.bigint();
  const res = S.findOffset(cam, stem);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# sync benchmark: 90 min @ 10 ms correlated in ${ms.toFixed(0)} ms (confidence ${res.confidence.toFixed(2)})`);
  near(res.offsetSec, 123.45);
  assert.ok(ms < 3000, `took ${ms} ms`);
});

// ---------------------------------------------------------------- end to end

const ffmpeg = A.findFfmpeg(path.join(__dirname, '..', 'extension'));

// Bursty "speech": noise gated by an irregular talk/pause pattern and a syllable rhythm.
// `T` is the underlying show clock, so files cut from different points share the same audio.
function showExpr(T, gain, noise) {
  const talk = `gt(sin(2.3*${T})+sin(3.71*${T}+1)+sin(0.53*${T}+2)+0.7*sin(7.13*${T}+0.4),0.6)`;
  const syllable = `gt(sin(2*PI*3.1*${T}+2*sin(0.9*${T}))+0.4*sin(2*PI*5.3*${T}),-0.2)`;
  return `${gain}*${talk}*(0.25+0.75*${syllable})*(2*random(0)-1)+${noise}*(2*random(1)-1)`;
}

test('end-to-end: syncs .wav and .m4a stems to a camera file', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrow-switch-sync-'));
  const gen = (file, start, dur, gain, noise, extra = []) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${showExpr(`(t+${start})`, gain, noise)}':s=48000:d=${dur}`, ...extra, file]);
  const camStart = 20;
  const cam = path.join(dir, 'camera.mov');
  const host = path.join(dir, 'host.wav');
  const guest = path.join(dir, 'guest.m4a');
  const g15 = Math.pow(10, -15 / 20) * 0.5;
  gen(cam, camStart, 150, 0.5, 0.002, ['-c:a', 'aac', '-b:a', '128k']);
  gen(host, camStart + 12.34, 120, g15, 0.004);
  gen(guest, camStart - 3.21, 130, g15, 0.006, ['-c:a', 'aac', '-b:a', '96k']);

  const [camLv, hostLv, guestLv, camDur] = await Promise.all([
    A.fileLevels(ffmpeg, cam, W), A.fileLevels(ffmpeg, host, W), A.fileLevels(ffmpeg, guest, W),
    A.probeDuration(ffmpeg, cam)
  ]);
  assert.ok(Math.abs(camDur - 150) < 0.1, `duration ${camDur}`);
  assert.ok(Math.abs(camLv.length * W - 150) < 0.1, `levels cover ${camLv.length * W} s`);

  const t0 = process.hrtime.bigint();
  const h = S.findOffset(camLv, hostLv);
  const g = S.findOffset(camLv, guestLv);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# e2e sync: host ${h.offsetSec.toFixed(4)} s (conf ${h.confidence.toFixed(2)}), ` +
    `guest ${g.offsetSec.toFixed(4)} s (conf ${g.confidence.toFixed(2)}), correlation ${ms.toFixed(0)} ms`);
  near(h.offsetSec, 12.34);
  near(g.offsetSec, -3.21);
  assert.ok(h.confidence >= S.GOOD_CONFIDENCE && g.confidence >= S.GOOD_CONFIDENCE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fileLevels grows past its initial buffer and probeDuration handles missing files',
  { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrow-switch-sync-'));
  const file = path.join(dir, 'long.wav');
  // 8 kHz mono keeps the file small; 0.5 s windows make 10 min+ exceed the initial buffer.
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=8000:d=700', file]);
  let progressed = 0;
  const lv = await A.fileLevels(ffmpeg, file, 0.5, { onProgress: (s) => { progressed += s; } });
  assert.strictEqual(lv.length, 1400);
  assert.ok(Math.abs(progressed - 700) < 1, `progress ${progressed}`);
  assert.strictEqual(await A.probeDuration(ffmpeg, path.join(dir, 'nope.wav')), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
