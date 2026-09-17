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
  // Real talkers breathe: a 0.3 s pause every 3 s.
  const paint = (ranges, level) => {
    for (const [a, b] of ranges) for (let i = secs(a); i < secs(b); i++) {
      if (i % 30 < 3) continue;
      out[i] = Math.max(out[i], level + rnd() * 3 + gain);
    }
  };
  paint(bleedFrom, -38);
  paint(speaking, -20);
  return out;
}

test('cuts to whoever is talking', () => {
  const a = [[0, 10], [20, 30]];
  const b = [[10, 20]];
  const tracks = [mic(30, a, b), mic(30, b, a, -8)];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: null, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2, 1]);
  assert.ok(Math.abs(segs[1].start - 10) < 0.6, `cut near 10s, got ${segs[1].start}`);
  assert.ok(Math.abs(segs[2].start - 20) < 0.6, `cut near 20s, got ${segs[2].start}`);
});

test('short interjections do not cause a cut', () => {
  const a = [[0, 10], [10.8, 20]];
  const b = [[10, 10.8]]; // "yeah"
  const tracks = [mic(20, a, b), mic(20, b, a)];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: null, minShotSec: 2.5 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1]);
});

test('cross-talk goes wide', () => {
  const a = [[0, 10], [10, 16]];
  const b = [[10, 16], [16, 26]];
  const tracks = [mic(26, a), mic(26, b)];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 0, 2]);
});

test('long monologues get wide cutaways', () => {
  const tracks = [mic(60, [[0, 60]]), mic(60, [])];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, maxShotSec: 15, wideShotSec: 3 });
  assert.ok(segs.some((s) => s.cam === 0), 'has a wide shot');
  for (const s of segs) if (s.cam === 1) assert.ok(s.end - s.start <= 15.01);
});

test('segments are contiguous and respect min shot length', () => {
  const pattern = [];
  for (let t = 0; t < 120; t += 1.7) pattern.push([t, t + 0.9]);
  const tracks = [mic(120, pattern.filter((_, i) => i % 2 === 0)), mic(120, pattern.filter((_, i) => i % 2 === 1))];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: null, minShotSec: 3 });
  assert.strictEqual(segs[0].start, 0);
  assert.ok(Math.abs(segs[segs.length - 1].end - 120) < 1e-6);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].start - segs[i - 1].end) < 1e-9);
  for (const s of segs.slice(0, -1)) assert.ok(s.end - s.start >= 3 - 0.21, `shot too short: ${s.end - s.start}`);
});

test('two speakers sharing one camera never cut between themselves', () => {
  const tracks = [mic(30, [[0, 15]]), mic(30, [[15, 30]])];
  const { active } = E.detectSpeech(tracks, { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [3, 3], wideCam: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [3]);
});

test('snapToFrames keeps cuts contiguous', () => {
  const frames = E.snapToFrames([{ cam: 1, start: 0, end: 1.01 }, { cam: 2, start: 1.01, end: 2.5 }, { cam: 2, start: 2.5, end: 3 }], 29.97);
  assert.deepStrictEqual(frames, [{ cam: 1, startFrame: 0, endFrame: 30 }, { cam: 2, startFrame: 30, endFrame: 90 }]);
});

test('loud bleed from the talker does not put the listener on screen', () => {
  // Host is loud and leaks into the guest mic, which also has 10 dB less gain.
  const host = [[0, 20], [40, 60]];
  const guest = [[20, 40]];
  const hostMic = mic(60, host);
  const guestMic = mic(60, guest, [], -10);
  for (const [a, b] of host) for (let i = secs(a); i < secs(b); i++) guestMic[i] = Math.max(guestMic[i], hostMic[i] - 22);
  const { active } = E.detectSpeech([hostMic, guestMic], { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2, 1]);
});

test('a short hand-over overlap cuts to the new speaker when they start, not to wide', () => {
  const a = [[0, 10.5]];
  const b = [[10, 20]];
  const { active } = E.detectSpeech([mic(20, a), mic(20, b)], { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2]);
  assert.ok(Math.abs(segs[1].start - 10) < 0.35, `cut near 10s, got ${segs[1].start}`);
});

test('wide cutaways land on a pause when there is one', () => {
  // One long monologue with a longer breath at 17.5-18.1 s.
  const { active } = E.detectSpeech([mic(60, [[0, 17.5], [18.1, 60]]), mic(60, [])], { windowSec: W, bridgeGapSec: 0.4 });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, maxShotSec: 20, wideShotSec: 3 });
  const firstWide = segs.find((s) => s.cam === 0);
  assert.ok(firstWide && Math.abs(firstWide.start - 17.8) < 0.4, `wide should start in the pause, got ${firstWide && firstWide.start}`);
});

test('cleanMask bridges short gaps and drops short bursts', () => {
  const m = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0]);
  E._cleanMask(m, 2, 2);
  assert.deepStrictEqual(Array.from(m), [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test('mics that hear each other almost as loud as their own person still split screen time fairly', () => {
  // Real-episode bug: one speaker got 83% of the screen. Mic A is only 5 dB louder for
  // person A than for B; mic B is gained up and hears A just 3 dB below B.
  const a = [[0, 12], [24, 36], [48, 60]];
  const b = [[12, 24], [36, 48]];
  // Real speech has proper pauses: 0.8 s every 4 s here, on both mics at once.
  const n = secs(60);
  const micA = new Float32Array(n), micB = new Float32Array(n);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const inAny = (ranges, t) => ranges.some(([s0, s1]) => t >= s0 && t < s1);
  for (let i = 0; i < n; i++) {
    const t = i * W, pause = (i % 40) < 8;
    const aTalks = !pause && inAny(a, t), bTalks = !pause && inAny(b, t);
    micA[i] = aTalks ? -26 + rnd() * 3 : bTalks ? -31 + rnd() * 3 : -64 + rnd() * 3;
    micB[i] = bTalks ? -20 + rnd() * 3 : aTalks ? -23 + rnd() * 3 : -58 + rnd() * 3;
  }
  const { active } = E.detectSpeech([micA, micB], { windowSec: W });
  const segs = E.buildEdit(active, { windowSec: W, speakerCams: [1, 2], wideCam: 0, leadInSec: 0, overlapToWide: false });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2, 1, 2, 1]);
});
