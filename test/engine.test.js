// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const E = require('../extension/js/engine.js');

const W = 0.1;
const secs = (s) => Math.round(s / W);

// Build a synthetic mic: noise floor, speech bursts, and bleed from other speakers.
function mic(totalSec, speaking, bleedFrom = [], gain = 0) {
  const n = secs(totalSec);
  const out = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) out[i] = -60 + rnd() * 4 + gain;
  const paint = (ranges, level) => {
    for (const [a, b] of ranges) for (let i = secs(a); i < secs(b); i++) out[i] = Math.max(out[i], level + rnd() * 3 + gain);
  };
  paint(bleedFrom, -38);
  paint(speaking, -20);
  return out;
}

test('cuts to whoever is talking', () => {
  const a = [[0, 10], [20, 30]];
  const b = [[10, 20]];
  const tracks = [mic(30, a, b), mic(30, b, a, -8)];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [1, 2], wideCam: null, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2, 1]);
  assert.ok(Math.abs(segs[1].start - 10) < 0.6, `cut near 10s, got ${segs[1].start}`);
  assert.ok(Math.abs(segs[2].start - 20) < 0.6, `cut near 20s, got ${segs[2].start}`);
});

test('short interjections do not cause a cut', () => {
  const a = [[0, 10], [10.8, 20]];
  const b = [[10, 10.8]]; // "yeah"
  const tracks = [mic(20, a, b), mic(20, b, a)];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [1, 2], wideCam: null, minShotSec: 2.5 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1]);
});

test('cross-talk goes wide', () => {
  const a = [[0, 10], [10, 16]];
  const b = [[10, 16], [16, 26]];
  const tracks = [mic(26, a), mic(26, b)];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [1, 2], wideCam: 0, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 0, 2]);
});

test('long monologues get wide cutaways', () => {
  const tracks = [mic(60, [[0, 60]]), mic(60, [])];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [1, 2], wideCam: 0, maxShotSec: 15, wideShotSec: 3 });
  assert.ok(segs.some((s) => s.cam === 0), 'has a wide shot');
  for (const s of segs) if (s.cam === 1) assert.ok(s.end - s.start <= 15.01);
});

test('segments are contiguous and respect min shot length', () => {
  const pattern = [];
  for (let t = 0; t < 120; t += 1.7) pattern.push([t, t + 0.9]);
  const tracks = [mic(120, pattern.filter((_, i) => i % 2 === 0)), mic(120, pattern.filter((_, i) => i % 2 === 1))];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [1, 2], wideCam: null, minShotSec: 3 });
  assert.strictEqual(segs[0].start, 0);
  assert.ok(Math.abs(segs[segs.length - 1].end - 120) < 1e-6);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].start - segs[i - 1].end) < 1e-9);
  for (const s of segs.slice(0, -1)) assert.ok(s.end - s.start >= 3 - 0.21, `shot too short: ${s.end - s.start}`);
});

test('two speakers sharing one camera never cut between themselves', () => {
  const tracks = [mic(30, [[0, 15]]), mic(30, [[15, 30]])];
  const { active } = E.detectSpeech(tracks, {});
  const segs = E.buildEdit(active, { speakerCams: [3, 3], wideCam: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [3]);
});

test('snapToFrames keeps cuts contiguous', () => {
  const frames = E.snapToFrames([{ cam: 1, start: 0, end: 1.01 }, { cam: 2, start: 1.01, end: 2.5 }, { cam: 2, start: 2.5, end: 3 }], 29.97);
  assert.deepStrictEqual(frames, [{ cam: 1, startFrame: 0, endFrame: 30 }, { cam: 2, startFrame: 30, endFrame: 90 }]);
});
