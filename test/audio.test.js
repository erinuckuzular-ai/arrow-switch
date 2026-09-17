// Integration test: generates real audio with ffmpeg and runs the full analysis.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('../extension/js/audio.js');
const E = require('../extension/js/engine.js');

const ffmpeg = A.findFfmpeg(path.join(__dirname, '..', 'extension'));

test('end-to-end on synthesized mics', { skip: !ffmpeg && 'ffmpeg not found' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocut-'));
  // Host A talks 0-10s and 20-30s, host B talks 10-20s. Each mic gets quiet bleed of the other.
  const make = (file, loudExpr) => {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      `aevalsrc='0.002*random(0) + (${loudExpr})*sin(2*PI*220*t)':s=48000:d=30`, '-ac', '2', file]);
  };
  const a = path.join(dir, 'hostA.wav');
  const b = path.join(dir, 'hostB.wav');
  make(a, '0.5*(lt(t,10)+gte(t,20)) + 0.04*between(t,10,20)');
  make(b, '0.5*between(t,10,20) + 0.04*(lt(t,10)+gte(t,20))');

  const windowSec = 0.1;
  const total = Math.ceil(30 / windowSec);
  // Host B's clip is placed on the timeline in two pieces to exercise inPoint offsets.
  const tracks = [
    { clips: [{ path: a, start: 0, end: 30, inPoint: 0 }] },
    { clips: [{ path: b, start: 0, end: 15, inPoint: 0 }, { path: b, start: 15, end: 30, inPoint: 15 }] }
  ];
  const levels = await Promise.all(tracks.map((t) => A.trackLevels(ffmpeg, t, total, windowSec)));
  const { active } = E.detectSpeech(levels, { windowSec });
  const segs = E.buildEdit(active, { windowSec, speakerCams: [1, 2], wideCam: null, leadInSec: 0 });
  assert.deepStrictEqual(segs.map((s) => s.cam), [1, 2, 1]);
  assert.ok(Math.abs(segs[1].start - 10) < 0.5);
  assert.ok(Math.abs(segs[2].start - 20) < 0.5);
  fs.rmSync(dir, { recursive: true, force: true });
});
