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
    '<a x="1 &amp; 2 &lt;3&gt; &quot;q&quot;" y=\'it&apos;s\'><![CDATA[<raw> & stuff]]>Chlo&#235; &#x26; Grace &gt; &#128512;<b/><c></c></a></xmeml>';
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
  assert.strictEqual(a.children[1].value, 'Chloë & Grace > \u{1F600}');
  const out = X.serialize(doc);
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<!-- exported -->'));
  assert.ok(out.includes('<![CDATA[<raw> & stuff]]>Chloë &amp; Grace &gt; \u{1F600}<b/><c></c>'));
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
  assert.deepStrictEqual(stats, { clipsIn: 3, clipsOut: 5, cuts: 4, cameras: 3 });

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
  const newName = 'Chloë & Grace <"live"> – ep 12';
  const { xml } = X.rebuild(A, { segments: segsA, camTracks: [0, 1, 2], newName });
  assert.ok(xml.includes('<name>Chloë &amp; Grace &lt;"live"&gt; – ep 12</name>'));
  const doc = X.parse(xml);
  assert.strictEqual(text(kid(seqOf(doc), 'name')), newName);
  assert.strictEqual(X.listClips(doc, 3)[0].name, 'Lower third – Chloë & Grace <guest> "live"');
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
  assert.deepStrictEqual(stats, { clipsIn: 6, clipsOut: 6, cuts: 4, cameras: 3 });

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
  assert.throws(() => X.rebuild(A, { segments: segsA, camTracks: [0], mode: 'disable' }), /mode/);
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
