// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const X = require('../extension/js/xmlcut.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const A = fixture('podcast-25fps.xml');
const B = fixture('ntsc-2997-cut-track.xml');
const C = fixture('source-offset.xml');

// --- tiny tree helpers (tests only) ---------------------------------------
const kids = (el, name) => el.children.filter((c) => c.type === 'element' && (!name || c.name === name));
const kid = (el, name) => kids(el, name)[0];
const text = (el) => X._textOf(el).trim();
const seqOf = (doc) => X._findSequence(doc);
const videoTracks = (doc) => kids(kid(kid(seqOf(doc), 'media'), 'video'), 'track');
const audioOf = (doc) => kid(kid(seqOf(doc), 'media'), 'audio');

function walk(node, fn) {
  if (node.type !== 'element' && node.type !== 'document') return;
  for (const c of node.children) {
    if (c.type === 'element') { fn(c); walk(c, fn); }
  }
}

function stripLinks(node) {
  const copy = X.parse(X.serialize(node));
  (function strip(el) {
    const out = [];
    for (const c of el.children) {
      if (c.type === 'element' && c.name === 'link') {
        if (out.length && out[out.length - 1].type === 'text' && !out[out.length - 1].value.trim()) out.pop();
        continue;
      }
      if (c.type === 'element') strip(c);
      out.push(c);
    }
    el.children = out;
  })(copy);
  return X.serialize(copy);
}

// Independent reference maths for one original clip cut by the segments.
function roundDiv(n, d) { return (2n * n + d) / (2n * d); }
function expectedPieces(clips, segments, cam, rate) {
  const num = rate.ntsc ? 254016000000n * 1001n : 254016000000n;
  const den = rate.ntsc ? BigInt(rate.timebase) * 1000n : BigInt(rate.timebase);
  const out = [];
  for (const c of clips) {
    if (c.enabled === false) continue;
    for (const s of segments) {
      if (s.cam !== cam) continue;
      const a = Math.max(c.start, s.startFrame), b = Math.min(c.end, s.endFrame);
      if (b <= a) continue;
      const span = c.end - c.start, src = c.out - c.in;
      const ticks = (f) => (BigInt(c.ticksIn) + roundDiv(BigInt((f - c.start) * src) * num, BigInt(span) * den)).toString();
      out.push({
        start: a, end: b,
        in: c.in + Math.round((a - c.start) * src / span),
        out: c.in + Math.round((b - c.start) * src / span),
        ticksIn: ticks(a), ticksOut: ticks(b)
      });
    }
  }
  // Merge neighbours that continue the same source (adjacent same-camera segments).
  out.sort((p, q) => p.start - q.start);
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.end === p.start && last.out === p.in) { last.end = p.end; last.out = p.out; last.ticksOut = p.ticksOut; }
    else merged.push(p);
  }
  return merged;
}

function actualPieces(doc, trackIndex) {
  return X.listClips(doc, trackIndex)
    .map((c) => ({ start: c.start, end: c.end, in: c.in, out: c.out, ticksIn: c.pproTicksIn, ticksOut: c.pproTicksOut }))
    .sort((p, q) => p.start - q.start);
}

// First occurrence of each file id is the complete original definition; the rest are empty.
function assertFileRule(originalXml, outDoc) {
  const defs = {};
  walk(X.parse(originalXml), (el) => {
    const id = X._getAttr(el, 'id');
    if (el.name === 'file' && !(id in defs) && kids(el).length) defs[id] = X.serialize(el);
  });
  const seen = {};
  walk(outDoc, (el) => {
    if (el.name !== 'file') return;
    const id = X._getAttr(el, 'id');
    if (!seen[id]) {
      seen[id] = true;
      assert.strictEqual(X.serialize(el), defs[id], `first <file id="${id}"> carries the full definition`);
    } else {
      assert.strictEqual(el.children.length, 0, `later <file id="${id}"> is an empty reference`);
    }
  });
  return seen;
}

function assertNoLinks(doc) {
  walk(doc, (el) => assert.notStrictEqual(el.name, 'link', 'no <link> survives'));
}

const segsA = [
  { startFrame: 0, endFrame: 100, cam: 0 },
  { startFrame: 100, endFrame: 400, cam: 1 },
  { startFrame: 400, endFrame: 420, cam: 2 },
  { startFrame: 420, endFrame: 900, cam: 1 },
  { startFrame: 900, endFrame: 1000, cam: 0 },
  { startFrame: 1000, endFrame: 1500, cam: 0 } // same camera again: merges with the previous one
];
const fullClip = { start: 0, end: 1500, in: 0, out: 1500, ticksIn: '0' };

// --- parser / serializer ---------------------------------------------------

test('fixtures round-trip byte for byte and parse -> serialise -> parse is stable', () => {
  for (const xml of [A, B, C]) {
    const once = X.serialize(X.parse(xml));
    assert.strictEqual(once, xml);
    assert.deepStrictEqual(X.parse(once), X.parse(xml));
  }
});

test('parser keeps declaration, doctype, comments, CDATA and decodes entities', () => {
  const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>\n<!-- exported -->\n<xmeml version='4'>" +
    '<a x="1 &amp; 2 &lt;3&gt; &quot;q&quot;" y=\'it&apos;s\'><![CDATA[<raw> & stuff]]>Zo&#235; &#x26; Grace &gt; &#128512;<b/><c></c></a></xmeml>';
  const doc = X.parse(xml);
  assert.deepStrictEqual(doc.children.slice(0, 2), [
    { type: 'pi', value: 'xml version="1.0" encoding="UTF-8"' },
    { type: 'text', value: '\n' }
  ]);
  assert.strictEqual(doc.children[2].type, 'doctype');
  assert.strictEqual(doc.children[4].type, 'comment');
  const a = kid(kid(doc, 'xmeml'), 'a');
  assert.strictEqual(X._getAttr(a, 'x'), '1 & 2 <3> "q"');
  assert.strictEqual(X._getAttr(a, 'y'), "it's");
  assert.deepStrictEqual(a.children[0], { type: 'cdata', value: '<raw> & stuff' });
  assert.strictEqual(a.children[1].value, 'Zoë & Grace > \u{1F600}');
  const out = X.serialize(doc);
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<!-- exported -->'));
  assert.ok(out.includes('<![CDATA[<raw> & stuff]]>Zoë &amp; Grace &gt; \u{1F600}<b/><c></c>'));
  assert.deepStrictEqual(X.parse(out), doc);
});

test('parser rejects broken XML', () => {
  assert.throws(() => X.parse('<a><b></a>'), /parse error/);
  assert.throws(() => X.parse('<a>'), /unclosed/);
  assert.throws(() => X.parse('<a x=1></a>'), /not quoted/);
});

// --- rebuild: 25 fps, one long clip per camera -----------------------------

test('25 fps: camera tracks tile their segments exactly', () => {
  const { xml, stats } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'Episode 12 – Arrow Switch' });
  const doc = X.parse(xml);
  const rate = { timebase: 25, ntsc: false };
  for (const cam of [0, 1, 2]) {
    assert.deepStrictEqual(actualPieces(doc, cam), expectedPieces([fullClip], segsA, cam, rate), `V${cam + 1}`);
  }
  assert.deepStrictEqual(actualPieces(doc, 0).map((p) => [p.start, p.end]), [[0, 100], [900, 1500]]);
  assert.deepStrictEqual(actualPieces(doc, 2), [{ start: 400, end: 420, in: 400, out: 420, ticksIn: '4064256000000', ticksOut: '4267468800000' }]);
  assert.deepStrictEqual(stats, { clipsIn: 3, clipsOut: 5, cuts: 4, cameras: 3, removedFrames: 0, removedRanges: 0 });

  // Copies of a split clip get unique ids.
  const ids = [];
  walk(doc, (el) => { if (el.name === 'clipitem') ids.push(X._getAttr(el, 'id')); });
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.includes('clipitem-2-as1') && ids.includes('clipitem-2-as2'));
  assert.ok(ids.includes('clipitem-3'), 'a clip kept once keeps its id');
});

test('25 fps: graphics, audio, markers and settings are untouched; name and uuid replaced', () => {
  const orig = X.parse(A);
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'Episode 12 – Arrow Switch' });
  const doc = X.parse(xml);
  assert.strictEqual(X.serialize(videoTracks(doc)[3]), X.serialize(videoTracks(orig)[3]), 'V4 graphics');
  assert.strictEqual(X.serialize(audioOf(doc)), stripLinks(audioOf(orig)), 'audio (minus links)');
  const seq = seqOf(doc), oseq = seqOf(orig);
  for (const name of ['duration', 'rate', 'timecode', 'marker', 'labels', 'logginginfo']) {
    assert.strictEqual(X.serialize(kid(seq, name)), X.serialize(kid(oseq, name)), name);
  }
  assert.strictEqual(X.serialize(kid(kid(kid(seq, 'media'), 'video'), 'format')), X.serialize(kid(kid(kid(oseq, 'media'), 'video'), 'format')));
  assert.deepStrictEqual(seq.attrs, oseq.attrs);
  assert.strictEqual(text(kid(seq, 'name')), 'Episode 12 – Arrow Switch');
  assert.match(text(kid(seq, 'uuid')), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notStrictEqual(text(kid(seq, 'uuid')), text(kid(oseq, 'uuid')));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n\t<sequence id="sequence-1"'));
  assertNoLinks(doc);
  assertFileRule(A, doc);
});

test('file definition moves to the new first occurrence when the defining clip is dropped', () => {
  // V1 (file-1 definition) is never picked; audio A1 in fixture C only holds a reference to it.
  const segs = [{ startFrame: 0, endFrame: 250, cam: 1 }];
  const { xml, stats } = X.rebuild(C, { segments: segs, camTracks: [0, 1], newName: 'x' });
  const doc = X.parse(xml);
  assert.strictEqual(X.countClips(doc, 0), 0);
  const seen = assertFileRule(C, doc);
  assert.deepStrictEqual(Object.keys(seen).sort(), ['file-1', 'file-2']);
  const audioFile = kid(kid(kid(audioOf(doc), 'track'), 'clipitem'), 'file');
  assert.strictEqual(text(kid(audioFile, 'pathurl')), 'file://localhost/Volumes/Studio%20RAID/Rolls/LONG_ROLL_WIDE.mxf');
  assert.strictEqual(stats.cameras, 1);
});

test('names with & < " and non-ASCII are escaped correctly', () => {
  const newName = 'Zoë & Grace <"live"> – ep 12';
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName });
  assert.ok(xml.includes('<name>Zoë &amp; Grace &lt;"live"&gt; – ep 12</name>'));
  const doc = X.parse(xml);
  assert.strictEqual(text(kid(seqOf(doc), 'name')), newName);
  assert.strictEqual(X.listClips(doc, 3)[0].name, 'Lower third – Zoë & Grace <guest> "live"');
});

// --- rebuild: 29.97 NTSC, pre-cut camera track with gap + transition -----

const segsB = [
  { startFrame: 0, endFrame: 700, cam: 0 },
  { startFrame: 700, endFrame: 1000, cam: 2 },
  { startFrame: 1000, endFrame: 1250, cam: 1 },
  { startFrame: 1250, endFrame: 1500, cam: 0 },
  { startFrame: 1500, endFrame: 1800, cam: 1 }
];

test('29.97: gaps, transitions (-1 edges) and disabled clips on a user-cut track', () => {
  const { xml, stats } = X.rebuild(B, { segments: segsB, camTracks: [0, 1, 2], newName: 'Ep 40 – Arrow Switch' });
  const doc = X.parse(xml);
  const rate = { timebase: 30, ntsc: true };
  const T = 8475667200n; // ticks per 29.97 frame
  const clipsV1 = [{ start: 0, end: 1800, in: 0, out: 1800, ticksIn: '0' }];
  // Transition 1185-1215 centred: the -1 edges resolve to the cut at 1200.
  const clipsV2 = [
    { start: 0, end: 600, in: 100, out: 700, ticksIn: String(100n * T) },
    { start: 900, end: 1200, in: 1000, out: 1300, ticksIn: String(1000n * T) },
    { start: 1200, end: 1800, in: 5000, out: 5600, ticksIn: String(5000n * T) }
  ];
  const clipsV3 = [
    { start: 0, end: 1200, in: 0, out: 1200, ticksIn: '0' },
    { start: 1200, end: 1800, in: 1200, out: 1800, ticksIn: String(1200n * T), enabled: false }
  ];
  assert.deepStrictEqual(actualPieces(doc, 0), expectedPieces(clipsV1, segsB, 0, rate));
  assert.deepStrictEqual(actualPieces(doc, 1), expectedPieces(clipsV2, segsB, 1, rate));
  assert.deepStrictEqual(actualPieces(doc, 2), expectedPieces(clipsV3, segsB, 2, rate));
  assert.deepStrictEqual(actualPieces(doc, 1), [
    { start: 1000, end: 1200, in: 1100, out: 1300, ticksIn: String(1100n * T), ticksOut: String(1300n * T) },
    { start: 1200, end: 1250, in: 5000, out: 5050, ticksIn: String(5000n * T), ticksOut: String(5050n * T) },
    { start: 1500, end: 1800, in: 5300, out: 5600, ticksIn: String(5300n * T), ticksOut: String(5600n * T) }
  ]);
  assert.deepStrictEqual(actualPieces(doc, 2).map((p) => [p.start, p.end]), [[700, 1000]], 'disabled clip dropped');
  assert.deepStrictEqual(stats, { clipsIn: 6, clipsOut: 6, cuts: 4, cameras: 3, removedFrames: 0, removedRanges: 0 });

  let transitions = 0;
  walk(kid(kid(seqOf(doc), 'media'), 'video'), (el) => { if (el.name === 'transitionitem') transitions++; });
  assert.strictEqual(transitions, 0, 'transitions dropped from rebuilt tracks');
  assertNoLinks(doc);
  // file-2 was defined on clipitem-2 (0-600), which is gone: the next piece must carry it.
  const seen = assertFileRule(B, doc);
  assert.ok(seen['file-2']);
  assert.strictEqual(X.serialize(audioOf(doc)), stripLinks(audioOf(X.parse(B))), 'audio untouched');
  // Output keeps Premiere-style indentation for the copies.
  assert.match(xml, /\n\t\t\t\t\t<clipitem id="clipitem-4-as1">\n\t\t\t\t\t\t<masterclipid>/);
});

test('tracks not listed in camTracks are not rebuilt', () => {
  const { xml } = X.rebuild(B, { segments: segsB, camTracks: [1], newName: 'x' });
  const doc = X.parse(xml), orig = X.parse(B);
  assert.strictEqual(X.serialize(videoTracks(doc)[0]), stripLinks(videoTracks(orig)[0]));
  assert.strictEqual(X.serialize(videoTracks(doc)[2]), stripLinks(videoTracks(orig)[2]));
  assert.strictEqual(X.listClips(doc, 1).filter((c) => c.type === 'transitionitem').length, 0);
});

// --- rebuild: source in-point not 0, huge ticks, 200% speed ---------------

test('source offset beyond 2^53 ticks and speed-changed clips', () => {
  const segs = [
    { startFrame: 0, endFrame: 61, cam: 1 },
    { startFrame: 61, endFrame: 190, cam: 0 },
    { startFrame: 190, endFrame: 250, cam: 1 }
  ];
  const { xml } = X.rebuild(C, { segments: segs, camTracks: [0, 1], newName: 'x' });
  const doc = X.parse(xml);
  const rate = { timebase: 25, ntsc: false };
  const T = 10160640000n;
  assert.deepStrictEqual(actualPieces(doc, 0), [
    { start: 61, end: 190, in: 900061, out: 900190, ticksIn: String(900061n * T), ticksOut: String(900190n * T) }
  ]);
  assert.ok(900061n * T > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepStrictEqual(actualPieces(doc, 1), [
    { start: 0, end: 61, in: 37, out: 159, ticksIn: String(37n * T), ticksOut: String(159n * T) },
    { start: 190, end: 250, in: 417, out: 537, ticksIn: String(417n * T), ticksOut: String(537n * T) }
  ]);
  assert.deepStrictEqual(actualPieces(doc, 1),
    expectedPieces([{ start: 0, end: 250, in: 37, out: 537, ticksIn: String(37n * T) }], segs, 1, rate));
  assertFileRule(C, doc);
  assertNoLinks(doc);
});

test('rejects bad input', () => {
  assert.throws(() => X.rebuild(A, { segments: [], camTracks: [0] }), /segment/);
  assert.throws(() => X.rebuild(A, { segments: segsA, camTracks: [0], mode: 'shuffle' }), /mode/);
  assert.throws(() => X.rebuild('<xmeml version="4"></xmeml>', { segments: segsA, camTracks: [0] }), /sequence/);
});

// --- performance -------------------------------------------------------------

test('2,000 segments over 3 cameras rebuild well under a second', () => {
  const frames = 2000 * 45;
  const xml = A.replace(/<end>1500<\/end>/g, `<end>${frames}</end>`).replace(/<out>1500<\/out>/g, `<out>${frames}</out>`)
    .replace(/<duration>1800<\/duration>/g, `<duration>${frames}</duration>`);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const segments = [];
  let cam = 0;
  for (let i = 0; i < 2000; i++) {
    const next = (cam + 1 + Math.floor(rnd() * 2)) % 3;
    cam = next;
    segments.push({ startFrame: i * 45, endFrame: (i + 1) * 45, cam });
  }
  X.rebuild(xml, { segments, camTracks: [0, 1, 2], newName: 'warm-up' });
  const t0 = process.hrtime.bigint();
  const { xml: out, stats } = X.rebuild(xml, { segments, camTracks: [0, 1, 2], newName: 'perf' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# rebuild: 2000 segments, ${stats.clipsOut} clips, ${(out.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
  assert.strictEqual(stats.clipsOut, 2000);
  assert.strictEqual(stats.cuts, 1999);
  assert.ok(ms < 1000, `took ${ms} ms`);
  const doc = X.parse(out);
  const total = [0, 1, 2].reduce((n, t) => n + actualPieces(doc, t).reduce((m, p) => m + p.end - p.start, 0), 0);
  assert.strictEqual(total, frames, 'pieces tile the whole sequence');
});

test('xmlcut.js attaches to window inside a Node-enabled CEP panel', () => {
  const window = {};
  const context = vm.createContext({ window, self: window, module: { exports: {} }, require, process, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'js', 'xmlcut.js'), 'utf8'), context);
  assert.ok(window.ArrowSwitchXml && typeof window.ArrowSwitchXml.rebuild === 'function');
});

test('disable mode keeps every angle, split at each switch, with off-screen pieces disabled', () => {
  const before = [0, 1, 2].map((t) => X.listClips(A, t));
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'Hide', mode: 'disable' });
  for (const cam of [0, 1, 2]) {
    const clips = X.listClips(xml, cam);
    // Same coverage as the original clip: pieces tile it with no gaps.
    const orig = before[cam].filter((c) => c.enabled);
    assert.strictEqual(clips[0].start, orig[0].start);
    assert.strictEqual(clips[clips.length - 1].end, orig[orig.length - 1].end);
    for (let i = 1; i < clips.length; i++) assert.strictEqual(clips[i].start, clips[i - 1].end, `V${cam + 1} pieces tile`);
    // Enabled exactly where this camera is the shot.
    for (const c of clips) {
      const mid = (c.start + c.end) / 2;
      const seg = segsA.find((s) => mid >= s.startFrame && mid < s.endFrame);
      assert.strictEqual(c.enabled, !!seg && seg.cam === cam, `V${cam + 1} ${c.start}-${c.end}`);
    }
  }
});

// --- trim dead air (ripple delete) -------------------------------------------

const T25 = 10160640000n; // ticks per 25 fps frame

// Every track, video then audio.
function allItems(doc) {
  const out = [];
  const nV = videoTracks(doc).length, nA = kids(audioOf(doc), 'track').length;
  for (let t = 0; t < nV; t++) out.push(X.listClips(doc, t));
  for (let t = 0; t < nA; t++) out.push(X.listClips(doc, t, 'audio'));
  return out;
}

// Reference ripple for 1x-speed clips: split each item around the ranges, shift left.
function expectedTrim(tracks, ranges, T) {
  const sorted = ranges.slice().sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (r.endFrame <= r.startFrame) continue;
    if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame);
    else merged.push({ ...r });
  }
  const map = (f) => {
    let removed = 0;
    for (const r of merged) {
      if (f >= r.endFrame) removed += r.endFrame - r.startFrame;
      else if (f > r.startFrame) return r.startFrame - removed;
    }
    return f - removed;
  };
  return tracks.map((items) => {
    const out = [];
    for (const c of items) {
      if (c.type === 'transitionitem') continue;
      let cursor = c.start;
      const keep = [];
      for (const r of merged) {
        if (r.endFrame <= cursor || r.startFrame >= c.end) continue;
        if (r.startFrame > cursor) keep.push([cursor, r.startFrame]);
        cursor = Math.max(cursor, r.endFrame);
      }
      if (c.end > cursor) keep.push([cursor, c.end]);
      for (const [a, b] of keep) {
        const inF = c.in + (a - c.start), outF = c.in + (b - c.start);
        out.push({
          start: map(a), end: map(b), in: inF, out: outF, enabled: c.enabled,
          ticksIn: String(BigInt(inF) * T), ticksOut: String(BigInt(outF) * T)
        });
      }
    }
    return out;
  });
}

const plain = (tracks) => tracks.map((items) => items.filter((c) => c.type !== 'transitionitem')
  .map((c) => ({ start: c.start, end: c.end, in: c.in, out: c.out, enabled: c.enabled, ticksIn: c.pproTicksIn, ticksOut: c.pproTicksOut })));

function assertUniqueIds(xml) {
  const ids = [];
  walk(X.parse(xml), (el) => { if (el.name === 'clipitem' || el.name === 'generatoritem') ids.push(X._getAttr(el, 'id')); });
  assert.strictEqual(new Set(ids).size, ids.length, 'clip ids stay unique');
  return ids;
}

test('trim: audio clip advances across a removed range', () => {
  const { xml, stats } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', removeRanges: [{ startFrame: 400, endFrame: 500 }] });
  const a1 = X.listClips(xml, 0, 'audio').map((c) => [c.id, c.start, c.end, c.in, c.out, c.pproTicksIn, c.pproTicksOut]);
  assert.deepStrictEqual(a1, [
    ['clipitem-5-t1', 0, 400, 0, 400, '0', String(400n * T25)],
    ['clipitem-5-t2', 400, 1400, 500, 1500, String(500n * T25), String(1500n * T25)]
  ]);
  assert.strictEqual(stats.removedFrames, 100);
  assert.strictEqual(stats.removedRanges, 1);
  assert.strictEqual(text(kid(seqOf(X.parse(xml)), 'duration')), '1400');
  // The 400-420 guest shot sat entirely inside the removed range.
  assert.strictEqual(X.countClips(xml, 2), 0);
});

for (const mode of ['cut', 'disable']) {
  test(`trim (${mode}): every track ripples, split pieces keep source and ticks`, () => {
    const ranges = [{ startFrame: 400, endFrame: 500 }, { startFrame: 600, endFrame: 620 }, { startFrame: 300, endFrame: 360 }];
    const base = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', mode });
    const { xml, stats } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', mode, removeRanges: ranges });
    const doc = X.parse(xml);
    const before = allItems(X.parse(base.xml)), after = plain(allItems(doc));
    assert.deepStrictEqual(after, expectedTrim(before, ranges, T25));
    assert.deepStrictEqual(stats, { ...base.stats, removedFrames: 180, removedRanges: 3 });
    assert.strictEqual(text(kid(seqOf(doc), 'duration')), '1320');

    // No new gaps: tracks that covered 0-1500 now cover 0-1320 end to end (tracks 4, 5 = A1, A2).
    const full = mode === 'disable' ? [0, 1, 2, 4, 5] : [4, 5];
    for (const t of full) {
      const items = after[t];
      assert.strictEqual(items[0].start, 0);
      assert.strictEqual(items[items.length - 1].end, 1320);
      for (let i = 1; i < items.length; i++) assert.strictEqual(items[i].start, items[i - 1].end, `track ${t} tiles`);
    }
    if (mode === 'cut') {
      // Cut-mode camera tracks together still tile the whole (shorter) timeline.
      const cams = [0, 1, 2].flatMap((t) => after[t]).sort((p, q) => p.start - q.start);
      assert.strictEqual(cams[0].start, 0);
      for (let i = 1; i < cams.length; i++) assert.strictEqual(cams[i].start, cams[i - 1].end);
      assert.strictEqual(cams[cams.length - 1].end, 1320);
    }
    // Graphics 250-375 lose 300-360: 250-300 + 300-315.
    assert.deepStrictEqual(after[3].map((c) => [c.start, c.end, c.in, c.out]), [[250, 300, 0, 50], [300, 315, 110, 125]]);

    const ids = assertUniqueIds(xml);
    if (mode === 'cut') assert.ok(ids.includes('clipitem-2-as2-t1') && ids.includes('clipitem-2-as2-t2'), 'a camera piece split again');
    else assert.ok(ids.some((id) => /-as\d+-t\d+$/.test(id)));
    assertFileRule(A, doc);
    assertNoLinks(doc);
  });
}

test('trim: disabled pieces from disable mode stay disabled', () => {
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', mode: 'disable', removeRanges: [{ startFrame: 50, endFrame: 150 }] });
  // V1: on 0-100, off 100-900 -> on 0-50, off 50-800.
  assert.deepStrictEqual(X.listClips(xml, 0).slice(0, 2).map((c) => [c.start, c.end, c.in, c.enabled]), [[0, 50, 0, true], [50, 800, 150, false]]);
});

test('trim: a removed range across a camera cut joins the neighbours', () => {
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', removeRanges: [{ startFrame: 80, endFrame: 130 }] });
  const doc = X.parse(xml);
  assert.deepStrictEqual(actualPieces(doc, 0)[0], { start: 0, end: 80, in: 0, out: 80, ticksIn: '0', ticksOut: String(80n * T25) });
  assert.deepStrictEqual(actualPieces(doc, 1)[0], { start: 80, end: 350, in: 130, out: 400, ticksIn: String(130n * T25), ticksOut: String(400n * T25) });
});

test('trim: ranges merge, and ranges at the very start and end', () => {
  const ranges = [
    { startFrame: 40, endFrame: 60 }, { startFrame: 0, endFrame: 50 }, { startFrame: 60, endFrame: 70 }, // -> 0-70
    { startFrame: 300, endFrame: 300 }, // empty
    { startFrame: 1450, endFrame: 1500 }, { startFrame: 1480, endFrame: 1700 } // -> 1450-1500 (clipped to the end)
  ];
  const { xml, stats } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', removeRanges: ranges });
  assert.strictEqual(stats.removedRanges, 2);
  assert.strictEqual(stats.removedFrames, 120);
  const doc = X.parse(xml);
  assert.strictEqual(text(kid(seqOf(doc), 'duration')), '1380');
  assert.deepStrictEqual(actualPieces(doc, 0), [
    { start: 0, end: 30, in: 70, out: 100, ticksIn: String(70n * T25), ticksOut: String(100n * T25) },
    { start: 830, end: 1380, in: 900, out: 1450, ticksIn: String(900n * T25), ticksOut: String(1450n * T25) }
  ]);
  const a1 = X.listClips(doc, 0, 'audio');
  assert.deepStrictEqual(a1.map((c) => [c.id, c.start, c.end, c.in, c.out]), [['clipitem-5', 0, 1380, 70, 1450]], 'one piece keeps its id');
  // The marker at 250 moves to 180.
  assert.strictEqual(text(kid(kid(seqOf(doc), 'marker'), 'in')), '180');
});

test('trim: transitions are dropped when they touch a removed range, shifted otherwise', () => {
  const T = 8475667200n;
  // V2 is not a camera track here, so its transition (1185-1215) and -1 edges survive the rebuild.
  const kept = X.rebuild(B, { segments: segsB, camTracks: [0], newName: 'x', removeRanges: [{ startFrame: 100, endFrame: 200 }] });
  const v2 = X.listClips(kept.xml, 1);
  assert.deepStrictEqual(v2.map((c) => [c.type, c.id, c.start, c.end, c.in, c.out]), [
    ['clipitem', 'clipitem-2-t1', 0, 100, 100, 200],
    ['clipitem', 'clipitem-2-t2', 100, 500, 300, 700],
    ['clipitem', 'clipitem-3', 800, -1, 1000, 1300],
    ['transitionitem', null, 1085, 1115, null, null],
    ['clipitem', 'clipitem-4', -1, 1700, 5000, 5600]
  ]);
  assert.strictEqual(v2[1].pproTicksIn, String(300n * T));
  const keptDoc = X.parse(kept.xml);
  assert.strictEqual(text(kid(kids(videoTracks(keptDoc)[1], 'transitionitem')[0], 'cutPointTicks')), '127135008000');

  const dropped = X.rebuild(B, { segments: segsB, camTracks: [0], newName: 'x', removeRanges: [{ startFrame: 1190, endFrame: 1200 }] });
  const v2d = X.listClips(dropped.xml, 1);
  assert.deepStrictEqual(v2d.map((c) => [c.type, c.id, c.start, c.end, c.in, c.out]), [
    ['clipitem', 'clipitem-2', 0, 600, 100, 700],
    ['clipitem', 'clipitem-3', 900, 1190, 1000, 1290],
    ['clipitem', 'clipitem-4', 1190, 1790, 5000, 5600]
  ]);
  assert.strictEqual(v2d[1].pproTicksOut, String(1290n * T));
  assert.match(dropped.xml, /\n\t\t\t\t\t<\/clipitem>\n\t\t\t\t\t<clipitem id="clipitem-4">/, 'indentation kept where the transition was');
  // Audio A1 and the disabled V3 clip ripple too.
  assert.deepStrictEqual(X.listClips(dropped.xml, 0, 'audio').map((c) => [c.start, c.end, c.in, c.out]), [[0, 600, 100, 700], [900, 1190, 1000, 1290], [1190, 1790, 5000, 5600]]);
  assert.deepStrictEqual(X.listClips(dropped.xml, 2).map((c) => [c.start, c.end, c.enabled]), [[0, 1190, true], [1190, 1790, false]]);
  assert.strictEqual(text(kid(seqOf(X.parse(dropped.xml)), 'duration')), '1790');
  assertFileRule(B, X.parse(dropped.xml));
});

test('trim: sequence markers inside removed ranges are dropped, later ones shifted', () => {
  const marker = (name, inF, outF) => `<marker>\n\t\t\t<comment></comment>\n\t\t\t<name>${name}</name>\n\t\t\t<in>${inF}</in>\n\t\t\t<out>${outF}</out>\n\t\t</marker>\n\t\t`;
  const xml = A.replace('<marker>', marker('gone', 450, -1) + marker('later', 600, 700) + marker('spans', 380, 450) + '<marker>')
    .replace('\n\t\t\t</audio>\n\t\t</media>', '\n\t\t\t</audio>\n\t\t\t' + marker('media', 1000, -1) + '</media>');
  const { xml: out } = X.rebuild(xml, { segments: segsA, camTracks: [0, 1, 2], newName: 'x', removeRanges: [{ startFrame: 400, endFrame: 500 }] });
  const seq = seqOf(X.parse(out));
  const read = (m) => [text(kid(m, 'name')), Number(text(kid(m, 'in'))), Number(text(kid(m, 'out')))];
  assert.deepStrictEqual(kids(seq, 'marker').map(read), [['later', 500, 600], ['spans', 380, 400], ['Intro', 250, -1]]);
  assert.deepStrictEqual(kids(kid(seq, 'media'), 'marker').map(read), [['media', 900, -1]]);
  assert.ok(!out.includes('<name>gone</name>'));
});

test('mapFrame maps original frames onto the trimmed timeline', () => {
  const ranges = [{ startFrame: 500, endFrame: 600 }, { startFrame: 100, endFrame: 200 }, { startFrame: 150, endFrame: 250 }];
  assert.strictEqual(X.mapFrame(0, ranges), 0);
  assert.strictEqual(X.mapFrame(99, ranges), 99);
  assert.strictEqual(X.mapFrame(100, ranges), 100);
  assert.strictEqual(X.mapFrame(180, ranges), 100, 'inside a range -> its start');
  assert.strictEqual(X.mapFrame(249, ranges), 100);
  assert.strictEqual(X.mapFrame(250, ranges), 100);
  assert.strictEqual(X.mapFrame(300, ranges), 150);
  assert.strictEqual(X.mapFrame(550, ranges), 350);
  assert.strictEqual(X.mapFrame(600, ranges), 350);
  assert.strictEqual(X.mapFrame(1000, ranges), 750);
  assert.strictEqual(X.mapFrame(42, []), 42);
});

test('trim performance: 2,000 segments + 300 removed ranges, 3 cameras + 3 audio tracks', () => {
  const frames = 2000 * 45;
  // A third audio track: a copy of A2 with a fresh clip id.
  const a2Start = A.lastIndexOf('\t\t\t\t<track', A.indexOf('<clipitem id="clipitem-6"'));
  const audioEnd = '\t\t\t</audio>\n\t\t</media>';
  const a2 = A.slice(a2Start, A.indexOf(audioEnd));
  let xml = A.replace(audioEnd, a2.replace(/clipitem-6/g, 'clipitem-7') + audioEnd);
  xml = xml.replace(/<end>1500<\/end>/g, `<end>${frames}</end>`).replace(/<out>1500<\/out>/g, `<out>${frames}</out>`)
    .replace(/<duration>1500<\/duration>/, `<duration>${frames}</duration>`);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const segments = [];
  let cam = 0;
  for (let i = 0; i < 2000; i++) {
    cam = (cam + 1 + Math.floor(rnd() * 2)) % 3;
    segments.push({ startFrame: i * 45, endFrame: (i + 1) * 45, cam });
  }
  const removeRanges = [];
  for (let i = 0; i < 300; i++) {
    const at = Math.floor((i + 0.1 + rnd() * 0.5) * frames / 300);
    removeRanges.push({ startFrame: at, endFrame: at + 20 + Math.floor(rnd() * 60) });
  }
  const opts = { segments, camTracks: [0, 1, 2], newName: 'perf', removeRanges };
  X.rebuild(xml, opts);
  const t0 = process.hrtime.bigint();
  const { xml: out, stats } = X.rebuild(xml, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# trim: 2000 segments, 300 ranges, ${stats.removedFrames} frames removed, ${(out.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
  assert.strictEqual(stats.removedRanges, 300);
  assert.ok(ms < 1500, `took ${ms} ms`);
  const doc = X.parse(out);
  const total = frames - stats.removedFrames;
  const cams = [0, 1, 2].reduce((n, t) => n + actualPieces(doc, t).reduce((m, p) => m + p.end - p.start, 0), 0);
  assert.strictEqual(cams, total, 'camera pieces tile the trimmed sequence');
  for (let t = 0; t < 3; t++) {
    const items = X.listClips(doc, t, 'audio');
    assert.strictEqual(items.length, 301);
    assert.strictEqual(items[items.length - 1].end, total);
    for (let i = 1; i < items.length; i++) assert.strictEqual(items[i].start, items[i - 1].end);
  }
  assert.strictEqual(text(kid(seqOf(doc), 'duration')), String(total));
  assertUniqueIds(out);
});
