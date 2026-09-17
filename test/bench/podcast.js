/*
 * Synthetic podcast generator for accuracy benchmarks.
 *
 * Writes one WAV per mic plus the ground truth (who holds the floor, second by
 * second) so the engine can be scored against a known right answer. The audio is
 * speech-like on purpose: pitched, formant-filtered syllables with word and phrase
 * pauses, mic bleed between seats, backchannels ("yeah"), laughs, hand-overs that
 * overlap, real cross-talk, gain mismatch and low-frequency room rumble.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RATE = 16000;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// ---------------------------------------------------------------- script

/*
 * speakers: [{ weight, turnSec: [min, max], gainDb, voice: { f0 } }]
 * Returns { floor: [{ who, start, end }], vocal: per-speaker [{ start, end, level }] }
 * floor.who is a speaker index or 'wide' for sustained cross-talk.
 */
function writeScript(opts) {
  const r = rng(opts.seed);
  const pick = (weights, exclude) => {
    let total = 0;
    weights.forEach((w, i) => { if (i !== exclude) total += w; });
    let x = r() * total;
    for (let i = 0; i < weights.length; i++) {
      if (i === exclude) continue;
      if ((x -= weights[i]) <= 0) return i;
    }
    return weights.length - 1;
  };
  const sp = opts.speakers;
  const vocal = sp.map(() => []);
  const floor = [];
  let t = 1;
  let who = 0;

  // Fills [a, b] with phrases: runs of speech separated by short word/phrase pauses.
  const talk = (s, a, b, level) => {
    let x = a;
    while (x < b) {
      const phrase = 1 + r() * 4;
      const end = Math.min(b, x + phrase);
      vocal[s].push({ start: x, end, level });
      x = end + (r() < 0.8 ? 0.12 + r() * 0.25 : 0.4 + r() * 0.5);
    }
  };

  while (t < opts.durationSec - 5) {
    const [lo, hi] = sp[who].turnSec;
    const len = Math.min(opts.durationSec - 2 - t, lo + Math.pow(r(), 1.6) * (hi - lo));
    const start = t, end = t + len;

    if (r() < opts.crossTalkRate && len > 4) {
      // Sustained cross-talk with another speaker: the right shot is the wide.
      const other = pick(sp.map((s) => s.weight), who);
      const ct = 2.5 + r() * 3;
      talk(who, start, start + ct, 1);
      talk(other, start + 0.1, start + ct, 1);
      floor.push({ who: 'wide', start, end: start + ct });
      t = start + ct + 0.3;
      who = r() < 0.5 ? who : other;
      continue;
    }

    talk(who, start, end, 1);
    floor.push({ who, start, end });

    // Listeners: backchannels and the odd laugh. These must never steal the shot.
    sp.forEach((_, s) => {
      if (s === who) return;
      for (let x = start + 1 + r() * 6; x < end - 1; x += 3 + r() * opts.backchannelEverySec) {
        const d = 0.25 + r() * 0.5;
        vocal[s].push({ start: x, end: x + d, level: 0.8 });
      }
      if (r() < len / opts.laughEverySec) {
        const x = start + r() * len;
        vocal[s].push({ start: x, end: Math.min(end, x + 0.6 + r() * 0.9), level: 1.1 });
      }
    });

    const next = pick(sp.map((s) => s.weight), who);
    // Hand-over: a gap, or the next person starting just before this one finishes.
    t = r() < opts.overlapRate ? end - (0.2 + r() * 0.8) : end + 0.15 + r() * 0.9;
    who = next;
  }
  vocal.forEach((v) => v.sort((a, b) => a.start - b.start));
  return { floor, vocal };
}

// ---------------------------------------------------------------- synthesis

// Renders one speaker's clean voice at RATE into a Float32Array.
function renderVoice(intervals, durationSec, voice, seed) {
  const n = Math.ceil(durationSec * RATE);
  const out = new Float32Array(n);
  const r = rng(seed);
  let phase = 0;
  // Two resonators (formants), coefficients refreshed per syllable.
  let y1a = 0, y2a = 0, y1b = 0, y2b = 0;
  let ca, cb;
  const reson = (f, bw) => {
    const R = Math.exp(-Math.PI * bw / RATE);
    return { a1: 2 * R * Math.cos(2 * Math.PI * f / RATE), a2: -R * R, g: 1 - R };
  };
  for (const iv of intervals) {
    const a = Math.floor(iv.start * RATE), b = Math.min(n, Math.floor(iv.end * RATE));
    let i = a;
    while (i < b) {
      const syl = Math.floor((0.12 + r() * 0.16) * RATE);
      const e = Math.min(b, i + syl);
      ca = reson(300 + r() * 500, 90);
      cb = reson(900 + r() * 1400, 140);
      const f0 = voice.f0 * (0.85 + r() * 0.3);
      const amp = iv.level * (0.6 + r() * 0.5);
      for (let k = i; k < e; k++) {
        const env = Math.sin(Math.PI * (k - i) / (e - i));
        phase += f0 / RATE;
        if (phase >= 1) phase -= 1;
        const src = (phase < 0.1 ? 1 : -0.11) * 0.8 + (r() - 0.5) * 0.35;
        const fa = ca.g * src + ca.a1 * y1a + ca.a2 * y2a; y2a = y1a; y1a = fa;
        const fb = cb.g * src + cb.a1 * y1b + cb.a2 * y2b; y2b = y1b; y1b = fb;
        out[k] += (fa * 1.0 + fb * 0.6) * env * amp;
      }
      i = e + Math.floor(r() * 0.04 * RATE);
    }
  }
  // Normalise speech to about -20 dBFS RMS over voiced samples.
  let sum = 0, cnt = 0;
  for (let k = 0; k < n; k++) if (out[k] !== 0) { sum += out[k] * out[k]; cnt++; }
  const g = cnt ? 0.1 / Math.sqrt(sum / cnt) : 1;
  for (let k = 0; k < n; k++) out[k] *= g;
  return out;
}

const dbToGain = (db) => Math.pow(10, db / 20);

/*
 * mics: [{ file, sources: [{ voice: index, gainDb, delayMs }], noiseDb, rumbleDb }]
 * A mic with `channels` writes several of these into one multichannel file.
 */
function writeWav(file, channels, n) {
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

function renderMic(voices, mic, n, seed) {
  const out = new Float32Array(n);
  const r = rng(seed);
  for (const src of mic.sources) {
    const g = dbToGain(src.gainDb);
    const d = Math.round((src.delayMs || 0) / 1000 * RATE);
    const v = voices[src.voice];
    for (let i = d; i < n; i++) out[i] += v[i - d] * g;
  }
  const noise = dbToGain(mic.noiseDb == null ? -62 : mic.noiseDb) * 1.7;
  const rumble = mic.rumbleDb == null ? 0 : dbToGain(mic.rumbleDb) * 1.41;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const white = (r() - 0.5) * noise;
    if (rumble) {
      lp += 0.02 * ((r() - 0.5) - lp);
      out[i] += rumble * (0.7 * Math.sin(2 * Math.PI * 60 * i / RATE) + 6 * lp);
    }
    out[i] += white;
  }
  return out;
}

/*
 * Builds a scenario into `dir`. Returns { tracks, truth, durationSec } where tracks
 * match what host.jsx hands the panel: [{ index, clips: [{ path, start, end, inPoint, channel? }] }].
 */
function build(dir, scenario) {
  fs.mkdirSync(dir, { recursive: true });
  const script = writeScript(scenario);
  const n = Math.ceil(scenario.durationSec * RATE);
  const voices = scenario.speakers.map((s, i) => renderVoice(script.vocal[i], scenario.durationSec, s.voice, 100 + i));
  const rendered = scenario.mics.map((m, i) => renderMic(voices, m, n, 900 + i));

  const files = {};
  scenario.mics.forEach((m, i) => { (files[m.file] = files[m.file] || []).push(rendered[i]); });
  Object.keys(files).forEach((f) => writeWav(path.join(dir, f), files[f], n));

  const tracks = scenario.mics.map((m, i) => ({
    index: i,
    clips: (m.clips || [{ start: 0, end: scenario.durationSec, inPoint: 0 }]).map((c) => Object.assign({ path: path.join(dir, m.file) }, c))
  }));
  return { tracks, truth: script.floor, durationSec: scenario.durationSec };
}

// ---------------------------------------------------------------- scenarios

const voice = (f0) => ({ f0 });
const SCENARIOS = {
  // Three seats in one room: loud host, co-host, quiet guest who barely talks,
  // real bleed between mics and air-con rumble on the guest's high-gain mic.
  studio: {
    seed: 11, durationSec: 900, overlapRate: 0.3, crossTalkRate: 0.05, backchannelEverySec: 9, laughEverySec: 90,
    speakers: [
      { weight: 0.5, turnSec: [3, 45], voice: voice(115) },
      { weight: 0.44, turnSec: [3, 35], voice: voice(190) },
      { weight: 0.06, turnSec: [2, 10], voice: voice(140) }
    ],
    mics: [
      { file: 'host.wav', sources: [{ voice: 0, gainDb: 0 }, { voice: 1, gainDb: -16, delayMs: 3 }, { voice: 2, gainDb: -19, delayMs: 4 }] },
      { file: 'cohost.wav', sources: [{ voice: 1, gainDb: -5 }, { voice: 0, gainDb: -17, delayMs: 3 }, { voice: 2, gainDb: -20, delayMs: 3 }] },
      { file: 'guest.wav', sources: [{ voice: 2, gainDb: -13 }, { voice: 0, gainDb: -26, delayMs: 4 }, { voice: 1, gainDb: -27, delayMs: 3 }], noiseDb: -55, rumbleDb: -38 }
    ]
  },
  // Two people close together with heavy bleed and a big gain mismatch; mic 2 is
  // cut into three clips on the timeline with a trimmed gap.
  heavyBleed: {
    seed: 23, durationSec: 600, overlapRate: 0.4, crossTalkRate: 0.04, backchannelEverySec: 6, laughEverySec: 60,
    speakers: [
      { weight: 0.55, turnSec: [2, 30], voice: voice(125) },
      { weight: 0.45, turnSec: [2, 30], voice: voice(210) }
    ],
    mics: [
      { file: 'a.wav', sources: [{ voice: 0, gainDb: -2 }, { voice: 1, gainDb: -10, delayMs: 2 }] },
      { file: 'b.wav', sources: [{ voice: 1, gainDb: -14 }, { voice: 0, gainDb: -21, delayMs: 2 }], noiseDb: -58,
        clips: [{ start: 0, end: 200, inPoint: 0 }, { start: 200, end: 420, inPoint: 200 }, { start: 420, end: 600, inPoint: 420 }] }
    ]
  },
  // Four around one table: strong bleed everywhere, lots of reactions and laughs,
  // and one mic with loud air-con rumble. The hardest case.
  roundtable: {
    seed: 51, durationSec: 900, overlapRate: 0.45, crossTalkRate: 0.08, backchannelEverySec: 5, laughEverySec: 40,
    speakers: [
      { weight: 0.35, turnSec: [2, 30], voice: voice(110) },
      { weight: 0.3, turnSec: [2, 25], voice: voice(200) },
      { weight: 0.2, turnSec: [2, 20], voice: voice(150) },
      { weight: 0.15, turnSec: [2, 15], voice: voice(230) }
    ],
    mics: [0, 1, 2, 3].map((me) => ({
      file: 'seat' + me + '.wav',
      sources: [0, 1, 2, 3].map((v) => ({ voice: v, gainDb: v === me ? [-2, -6, 0, -9][me] : -11 - Math.abs(v - me) * 2, delayMs: v === me ? 0 : 3 + Math.abs(v - me) })),
      noiseDb: -58,
      rumbleDb: me === 2 ? -30 : undefined
    }))
  },
  // A two-channel recorder: host on the left channel, guest on the right, one file
  // placed on A1 and A2. Only works if each track reads its own channel.
  stereoRecorder: {
    seed: 37, durationSec: 600, overlapRate: 0.3, crossTalkRate: 0.03, backchannelEverySec: 8, laughEverySec: 80,
    speakers: [
      { weight: 0.5, turnSec: [3, 40], voice: voice(120) },
      { weight: 0.5, turnSec: [3, 40], voice: voice(180) }
    ],
    mics: [
      { file: 'recorder.wav', sources: [{ voice: 0, gainDb: 0 }, { voice: 1, gainDb: -18, delayMs: 2 }] },
      { file: 'recorder.wav', sources: [{ voice: 1, gainDb: -3 }, { voice: 0, gainDb: -18, delayMs: 2 }] }
    ]
  }
};

module.exports = { build, writeScript, SCENARIOS, RATE };
