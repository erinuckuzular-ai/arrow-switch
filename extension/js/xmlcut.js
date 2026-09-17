/*
 * Arrow Switch — "Fast cuts": rebuild a Premiere FCP 7 XML (xmeml) export.
 *
 * Instead of razoring thousands of clips through ExtendScript, the panel exports
 * the source sequence with sequence.exportAsFinalCutProXML(), and this module
 * rewrites it so every camera track only keeps the pieces where that camera is
 * the chosen shot. The result is imported back as a brand new sequence.
 *
 * Pure ES5, no DOMParser: runs in Premiere's CEP panel and in plain Node tests
 * (see test/xmlcut.test.js). BigInt is used through BigInt() calls only
 * (Chromium 67+ / Node 10.4+), never literals, because pproTicks can exceed 2^53.
 */
(function (root, factory) {
  var api = factory();
  // Premiere panels run with Node enabled, so `module` exists there too: set both.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchXml = api;
  else root.ArrowSwitchXml = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TICKS_PER_SECOND = 254016000000;

  // ---------------------------------------------------------------------------
  // XML parser
  //
  // Node shapes:
  //   { type: 'document', children: [] }
  //   { type: 'element', name, attrs: [[name, value], ...], children: [], selfClosing }
  //   { type: 'text', value }        (entities decoded; whitespace kept verbatim)
  //   { type: 'cdata', value }
  //   { type: 'comment', value }
  //   { type: 'pi', value }          (everything between <? and ?>, e.g. 'xml version="1.0"')
  //   { type: 'doctype', value }     (everything between <!DOCTYPE and >, e.g. ' xmeml')
  // ---------------------------------------------------------------------------

  var NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, ent) {
      if (ent.charAt(0) === '#') {
        var code = ent.charAt(1) === 'x' || ent.charAt(1) === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!(code >= 0 && code <= 0x10FFFF)) return m;
        if (code <= 0xFFFF) return String.fromCharCode(code);
        code -= 0x10000;
        return String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
      }
      return NAMED.hasOwnProperty(ent) ? NAMED[ent] : m;
    });
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  }

  function isNameChar(c) {
    // Anything that isn't whitespace or markup punctuation counts (covers non-ASCII names).
    return !(c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62 || c === 61 || c === 60 || c !== c);
  }

  function parseError(msg, pos) {
    return new Error('XML parse error at offset ' + pos + ': ' + msg);
  }

  function parse(xml) {
    if (typeof xml !== 'string') throw new Error('parse() needs a string');
    var s = xml, len = s.length, pos = 0;
    if (s.charCodeAt(0) === 0xFEFF) pos = 1; // BOM
    var doc = { type: 'document', children: [] };
    var stack = [doc];
    var cur = doc;

    while (pos < len) {
      var lt = s.indexOf('<', pos);
      if (lt < 0) lt = len;
      if (lt > pos) {
        cur.children.push({ type: 'text', value: decodeEntities(s.slice(pos, lt)) });
        pos = lt;
        if (pos >= len) break;
      }
      var c1 = s.charCodeAt(pos + 1);
      var end;
      if (c1 === 47) { // </name>
        end = s.indexOf('>', pos + 2);
        if (end < 0) throw parseError('unterminated end tag', pos);
        var closeName = s.slice(pos + 2, end).replace(/\s+$/, '');
        if (cur.type !== 'element' || cur.name !== closeName) {
          throw parseError('unexpected </' + closeName + '>' + (cur.name ? ' (open: <' + cur.name + '>)' : ''), pos);
        }
        stack.pop();
        cur = stack[stack.length - 1];
        pos = end + 1;
      } else if (c1 === 63) { // <? ... ?>
        end = s.indexOf('?>', pos + 2);
        if (end < 0) throw parseError('unterminated processing instruction', pos);
        cur.children.push({ type: 'pi', value: s.slice(pos + 2, end) });
        pos = end + 2;
      } else if (c1 === 33) { // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE >
        if (s.substr(pos, 4) === '<!--') {
          end = s.indexOf('-->', pos + 4);
          if (end < 0) throw parseError('unterminated comment', pos);
          cur.children.push({ type: 'comment', value: s.slice(pos + 4, end) });
          pos = end + 3;
        } else if (s.substr(pos, 9) === '<![CDATA[') {
          end = s.indexOf(']]>', pos + 9);
          if (end < 0) throw parseError('unterminated CDATA', pos);
          cur.children.push({ type: 'cdata', value: s.slice(pos + 9, end) });
          pos = end + 3;
        } else if (s.substr(pos, 9).toUpperCase() === '<!DOCTYPE') {
          var p = pos + 9, depth = 0, q = 0;
          for (; p < len; p++) {
            var ch = s.charCodeAt(p);
            if (q) { if (ch === q) q = 0; }
            else if (ch === 34 || ch === 39) q = ch;
            else if (ch === 91) depth++;
            else if (ch === 93) depth--;
            else if (ch === 62 && depth <= 0) break;
          }
          if (p >= len) throw parseError('unterminated DOCTYPE', pos);
          cur.children.push({ type: 'doctype', value: s.slice(pos + 9, p) });
          pos = p + 1;
        } else {
          throw parseError('unsupported markup declaration', pos);
        }
      } else { // <name attr="v" ...> or <name/>
        var i = pos + 1;
        while (i < len && isNameChar(s.charCodeAt(i))) i++;
        var name = s.slice(pos + 1, i);
        if (!name) throw parseError('empty tag name', pos);
        var el = { type: 'element', name: name, attrs: [], children: [], selfClosing: false };
        for (;;) {
          while (i < len && (s.charCodeAt(i) <= 32)) i++;
          if (i >= len) throw parseError('unterminated start tag <' + name + '>', pos);
          var c = s.charCodeAt(i);
          if (c === 62) { i++; break; }
          if (c === 47 && s.charCodeAt(i + 1) === 62) { el.selfClosing = true; i += 2; break; }
          var an = i;
          while (i < len && isNameChar(s.charCodeAt(i))) i++;
          var attrName = s.slice(an, i);
          if (!attrName) throw parseError('bad attribute in <' + name + '>', i);
          while (i < len && s.charCodeAt(i) <= 32) i++;
          if (s.charCodeAt(i) !== 61) throw parseError('attribute ' + attrName + ' has no value', i);
          i++;
          while (i < len && s.charCodeAt(i) <= 32) i++;
          var quote = s.charAt(i);
          if (quote !== '"' && quote !== "'") throw parseError('attribute ' + attrName + ' is not quoted', i);
          var ve = s.indexOf(quote, i + 1);
          if (ve < 0) throw parseError('unterminated attribute value', i);
          el.attrs.push([attrName, decodeEntities(s.slice(i + 1, ve))]);
          i = ve + 1;
        }
        cur.children.push(el);
        if (!el.selfClosing) { stack.push(el); cur = el; }
        pos = i;
      }
    }
    if (stack.length > 1) throw parseError('unclosed <' + cur.name + '>', len);
    return doc;
  }

  // ---------------------------------------------------------------------------
  // Serializer
  // ---------------------------------------------------------------------------

  function serializeInto(node, out) {
    switch (node.type) {
      case 'document':
        for (var d = 0; d < node.children.length; d++) serializeInto(node.children[d], out);
        break;
      case 'element':
        var open = '<' + node.name;
        for (var a = 0; a < node.attrs.length; a++) open += ' ' + node.attrs[a][0] + '="' + escapeAttr(node.attrs[a][1]) + '"';
        if (!node.children.length && node.selfClosing) { out.push(open + '/>'); break; }
        out.push(open + '>');
        for (var k = 0; k < node.children.length; k++) serializeInto(node.children[k], out);
        out.push('</' + node.name + '>');
        break;
      case 'text': out.push(escapeText(node.value)); break;
      case 'cdata': out.push('<![CDATA[' + node.value + ']]>'); break;
      case 'comment': out.push('<!--' + node.value + '-->'); break;
      case 'pi': out.push('<?' + node.value + '?>'); break;
      case 'doctype': out.push('<!DOCTYPE' + node.value + '>'); break;
      default: throw new Error('Unknown node type ' + node.type);
    }
  }

  function serialize(node) {
    var out = [];
    serializeInto(node, out);
    return out.join('');
  }

  // ---------------------------------------------------------------------------
  // Tree helpers
  // ---------------------------------------------------------------------------

  function clone(node) {
    if (node.type !== 'element' && node.type !== 'document') {
      return { type: node.type, value: node.value };
    }
    var copy = node.type === 'document'
      ? { type: 'document', children: new Array(node.children.length) }
      : { type: 'element', name: node.name, attrs: new Array(node.attrs.length), children: new Array(node.children.length), selfClosing: node.selfClosing };
    if (node.attrs) for (var a = 0; a < node.attrs.length; a++) copy.attrs[a] = [node.attrs[a][0], node.attrs[a][1]];
    for (var i = 0; i < node.children.length; i++) copy.children[i] = clone(node.children[i]);
    return copy;
  }

  function children(el, name) {
    var out = [];
    if (!el) return out;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'element' && (!name || c.name === name)) out.push(c);
    }
    return out;
  }

  function child(el, name) {
    if (!el) return null;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'element' && c.name === name) return c;
    }
    return null;
  }

  function textOf(el) {
    if (!el) return null;
    var t = '';
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'text' || c.type === 'cdata') t += c.value;
      else if (c.type === 'element') t += textOf(c);
    }
    return t;
  }

  function childText(el, name) {
    var c = child(el, name);
    return c ? textOf(c).replace(/^\s+|\s+$/g, '') : null;
  }

  function childInt(el, name) {
    var t = childText(el, name);
    if (t === null || t === '' || !/^-?\d+$/.test(t)) return null;
    return parseInt(t, 10);
  }

  function setChildText(el, name, value) {
    var c = child(el, name);
    if (!c) return false;
    c.children = [{ type: 'text', value: String(value) }];
    c.selfClosing = false;
    return true;
  }

  function getAttr(el, name) {
    for (var i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === name) return el.attrs[i][1];
    return null;
  }

  function setAttr(el, name, value) {
    for (var i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === name) { el.attrs[i][1] = value; return; }
    el.attrs.push([name, value]);
  }

  function isBlank(node) {
    return node && node.type === 'text' && /^\s*$/.test(node.value);
  }

  // Remove matching child elements (and the indentation right before each) from `el`.
  function removeChildren(el, predicate) {
    var kept = [], removed = 0;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'element' && predicate(c)) {
        if (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
        removed++;
      } else {
        kept.push(c);
      }
    }
    el.children = kept;
    return removed;
  }

  // Remove every descendant element named `name`; returns how many were removed.
  function removeDeep(el, name) {
    var n = removeChildren(el, function (c) { return c.name === name; });
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].type === 'element') n += removeDeep(el.children[i], name);
    }
    return n;
  }

  function firstElement(parent) {
    for (var i = 0; i < parent.children.length; i++) if (parent.children[i].type === 'element') return parent.children[i];
    return null;
  }

  // The exported sequence: <xmeml><sequence>. Fall back to the first <sequence>
  // anywhere that isn't nested inside a clip (nested sequences live in clipitems).
  function findSequence(doc) {
    var root = firstElement(doc);
    if (!root) return null;
    var direct = child(root, 'sequence');
    if (direct) return direct;
    var queue = [root];
    while (queue.length) {
      var el = queue.shift();
      if (el.name === 'sequence') return el;
      if (el.name === 'clipitem' || el.name === 'file') continue;
      for (var i = 0; i < el.children.length; i++) if (el.children[i].type === 'element') queue.push(el.children[i]);
    }
    return null;
  }

  function videoTracks(sequence) {
    return children(child(child(sequence, 'media'), 'video'), 'track');
  }

  function readRate(el) {
    var rate = child(el, 'rate');
    var timebase = childInt(rate, 'timebase');
    var ntsc = (childText(rate, 'ntsc') || '').toUpperCase() === 'TRUE';
    return { timebase: timebase, ntsc: ntsc, fps: timebase ? (ntsc ? timebase * 1000 / 1001 : timebase) : null };
  }

  // ---------------------------------------------------------------------------
  // Integer maths for ticks
  // ---------------------------------------------------------------------------

  var HAS_BIGINT = typeof BigInt === 'function';

  // round(a * b / c) for non-negative integers given as numbers or digit strings.
  function mulDivRound(a, b, c) {
    if (HAS_BIGINT) {
      var A = BigInt(a), B = BigInt(b), C = BigInt(c);
      var zero = BigInt(0), two = BigInt(2);
      var num = A * B;
      var neg = (num < zero) !== (C < zero);
      if (num < zero) num = -num;
      if (C < zero) C = -C;
      var q = (num * two + C) / (C * two);
      return neg ? -q : q;
    }
    throw new Error('BigInt is required for pproTicks maths');
  }

  function bigAdd(a, b) { return BigInt(a) + BigInt(b); }

  // ---------------------------------------------------------------------------
  // Rebuild
  // ---------------------------------------------------------------------------

  var TRIMMABLE = { clipitem: true, generatoritem: true };

  function normalizeSegments(segments) {
    if (!segments || !segments.length) throw new Error('rebuild() needs at least one segment');
    var sorted = segments.slice().sort(function (a, b) { return a.startFrame - b.startFrame; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      var a = Math.round(s.startFrame), b = Math.round(s.endFrame);
      if (!(b > a)) continue;
      var last = out[out.length - 1];
      if (last && a < last.endFrame) throw new Error('Segments overlap at frame ' + a);
      if (last && last.cam === s.cam && last.endFrame === a) last.endFrame = b;
      else out.push({ startFrame: a, endFrame: b, cam: s.cam });
    }
    return out;
  }

  // First segment whose endFrame > frame.
  function firstSegmentAfter(segs, frame) {
    var lo = 0, hi = segs.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].endFrame > frame) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  // Where a transition puts its edit point, per FCP 7 <alignment>.
  function transitionCut(tr, fallback) {
    if (!tr || tr.name !== 'transitionitem') return fallback;
    var start = childInt(tr, 'start'), end = childInt(tr, 'end');
    var align = (childText(tr, 'alignment') || 'center').toLowerCase();
    if (start === null || end === null) return fallback;
    if (align === 'start' || align === 'start-black') return start;
    if (align === 'end' || align === 'end-black') return end;
    if ((start + end) % 2 !== 0 && fallback !== null) return fallback; // odd centred transition: trust the clip's own length
    return Math.floor((start + end) / 2);
  }

  function rebuildTrack(track, segs, camIndex, ticks, stats) {
    // Pass 1: resolve every item's timeline range (start/end -1 come from transitions).
    var items = [];
    for (var i = 0; i < track.children.length; i++) {
      var c = track.children[i];
      if (c.type === 'element' && (TRIMMABLE[c.name] || c.name === 'transitionitem')) items.push(c);
    }
    var resolved = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.name === 'transitionitem') continue;
      stats.clipsIn++;
      var start = childInt(it, 'start'), end = childInt(it, 'end');
      var inF = childInt(it, 'in'), outF = childInt(it, 'out');
      var len = inF !== null && outF !== null ? outF - inF : null;
      if (start === -1) start = transitionCut(items[k - 1], end !== null && end >= 0 && len !== null ? end - len : null);
      if (end === -1) end = transitionCut(items[k + 1], start !== null && start >= 0 && len !== null ? start + len : null);
      resolved.push({ el: it, start: start, end: end, inF: inF, outF: outF });
    }

    var copiesFor = [];
    for (var r = 0; r < resolved.length; r++) copiesFor.push(cutItem(resolved[r], segs, camIndex, ticks));

    // Pass 2: rebuild the child list, repeating each item's indentation before every copy.
    var out = [], pending = [], ri = 0;
    for (var j = 0; j < track.children.length; j++) {
      var node = track.children[j];
      if (isBlank(node)) { pending.push(node); continue; }
      if (node.type === 'element' && node.name === 'transitionitem') { pending = []; continue; }
      if (node.type === 'element' && TRIMMABLE[node.name]) {
        var copies = copiesFor[ri++];
        for (var q = 0; q < copies.length; q++) {
          for (var w = 0; w < pending.length; w++) out.push({ type: 'text', value: pending[w].value });
          out.push(copies[q]);
        }
        stats.clipsOut += copies.length;
        pending = [];
        continue;
      }
      for (var p = 0; p < pending.length; p++) out.push(pending[p]);
      pending = [];
      out.push(node);
    }
    for (var z = 0; z < pending.length; z++) out.push(pending[z]);
    track.children = out;
    return copiesFor;
  }

  function cutItem(item, segs, camIndex, ticks) {
    var el = item.el, start = item.start, end = item.end;
    if ((childText(el, 'enabled') || '').toUpperCase() === 'FALSE') return [];
    if (start === null || end === null || start < 0 || !(end > start)) return [];

    var hasInOut = item.inF !== null && item.outF !== null;
    var span = end - start;
    var srcSpan = hasInOut ? item.outF - item.inF : span; // speed = srcSpan / span
    var ticksInText = childText(el, 'pproTicksIn');
    var hasTicks = ticksInText !== null && /^-?\d+$/.test(ticksInText) && child(el, 'pproTicksOut') !== null;

    var pieces = [];
    for (var s = firstSegmentAfter(segs, start); s < segs.length && segs[s].startFrame < end; s++) {
      var seg = segs[s];
      if (seg.cam !== camIndex) continue;
      pieces.push([Math.max(start, seg.startFrame), Math.min(end, seg.endFrame)]);
    }
    var id = getAttr(el, 'id');
    var copies = [];
    for (var p = 0; p < pieces.length; p++) {
      var a = pieces[p][0], b = pieces[p][1];
      var copy = clone(el);
      if (id !== null && pieces.length > 1) setAttr(copy, 'id', id + '-as' + (p + 1));
      setChildText(copy, 'start', a);
      setChildText(copy, 'end', b);
      if (hasInOut) {
        // Offsets are taken from the original clip start so neighbouring pieces tile exactly.
        setChildText(copy, 'in', item.inF + Math.round((a - start) * srcSpan / span));
        setChildText(copy, 'out', item.inF + Math.round((b - start) * srcSpan / span));
      }
      if (hasTicks) {
        // ticks offset = frames * speed * ticksPerFrame, ticksPerFrame = tpfNum / tpfDen.
        var den = span * ticks.den;
        setChildText(copy, 'pproTicksIn', bigAdd(ticksInText, mulDivRound((a - start) * srcSpan, ticks.num, den)).toString());
        setChildText(copy, 'pproTicksOut', bigAdd(ticksInText, mulDivRound((b - start) * srcSpan, ticks.num, den)).toString());
      }
      copies.push(copy);
    }
    return copies;
  }

  // xmeml <file id> rule: first occurrence in document order is the full definition,
  // later ones are empty references.
  function collectFileDefinitions(node, defs) {
    if (node.type !== 'element' && node.type !== 'document') return;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.type !== 'element') continue;
      if (c.name === 'file') {
        var id = getAttr(c, 'id');
        if (id !== null && !defs.hasOwnProperty(id) && children(c).length) defs[id] = clone(c);
      }
      collectFileDefinitions(c, defs);
    }
  }

  function fixFileReferences(node, defs, seen) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.type !== 'element') continue;
      if (c.name === 'file') {
        var id = getAttr(c, 'id');
        if (id !== null) {
          if (!seen[id]) {
            seen[id] = true;
            if (defs.hasOwnProperty(id) && !children(c).length) node.children[i] = clone(defs[id]);
            // A file element that already carries a definition stays as it is.
          } else if (children(c).length || c.children.length) {
            node.children[i] = { type: 'element', name: 'file', attrs: [['id', id]], children: [], selfClosing: true };
          }
          continue; // file definitions never contain other <file>s we need to touch
        }
      }
      fixFileReferences(c, defs, seen);
    }
  }

  function makeUuid() {
    var hex = '0123456789abcdef', out = '';
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
      else if (i === 14) out += '4';
      else if (i === 19) out += hex.charAt(8 + Math.floor(Math.random() * 4));
      else out += hex.charAt(Math.floor(Math.random() * 16));
    }
    return out;
  }

  function rebuild(xmlString, opts) {
    opts = opts || {};
    var mode = opts.mode || 'cut';
    if (mode !== 'cut') throw new Error('Unsupported rebuild mode: ' + mode);
    var camTracks = opts.camTracks || [];
    var segs = normalizeSegments(opts.segments);

    var doc = parse(xmlString);
    var sequence = findSequence(doc);
    if (!sequence) throw new Error('No <sequence> found in the exported XML');

    var rate = readRate(sequence);
    if (!rate.timebase) throw new Error('The sequence has no <rate><timebase>');
    // ticks per sequence frame = 254016000000 / fps, fps = timebase (* 1000/1001 when NTSC), as a fraction.
    var ticks = rate.ntsc
      ? { num: TICKS_PER_SECOND * 1001, den: rate.timebase * 1000 }
      : { num: TICKS_PER_SECOND, den: rate.timebase };

    var defs = {};
    collectFileDefinitions(doc, defs);

    // Rule 1: new identity.
    if (opts.newName !== undefined && opts.newName !== null) {
      if (!setChildText(sequence, 'name', opts.newName)) {
        var at = 0;
        for (var n = 0; n < sequence.children.length; n++) {
          var nm = sequence.children[n].name;
          if (nm === 'uuid' || nm === 'duration' || nm === 'rate') at = n + 1;
        }
        sequence.children.splice(at, 0, { type: 'element', name: 'name', attrs: [], children: [{ type: 'text', value: String(opts.newName) }], selfClosing: false });
      }
    }
    // Premiere keys sequences by uuid: give the import a fresh one so it never matches the source.
    if (child(sequence, 'uuid')) setChildText(sequence, 'uuid', makeUuid());

    // Rule 2: camera tracks keep only their segments.
    var stats = { clipsIn: 0, clipsOut: 0, cuts: Math.max(0, segs.length - 1), cameras: 0 };
    var tracks = videoTracks(sequence);
    var done = {};
    for (var t = 0; t < camTracks.length; t++) {
      var idx = camTracks[t];
      if (done[idx] || !tracks[idx]) continue;
      done[idx] = true;
      var before = stats.clipsOut;
      rebuildTrack(tracks[idx], segs, idx, ticks, stats);
      if (stats.clipsOut > before) stats.cameras++;
    }

    // Rule 3: links no longer describe matching video/audio pairs.
    removeDeep(sequence, 'link');

    // Rule 4: file definitions travel to the new first occurrence.
    fixFileReferences(doc, defs, {});

    return { xml: serialize(doc), stats: stats };
  }

  // Timeline items on a video track (0-based), with numbers parsed. Handy for tests and checks.
  function listClips(xmlOrDoc, trackIndex, kind) {
    var doc = typeof xmlOrDoc === 'string' ? parse(xmlOrDoc) : xmlOrDoc;
    var seq = findSequence(doc);
    var media = child(seq, 'media');
    var track = children(child(media, kind === 'audio' ? 'audio' : 'video'), 'track')[trackIndex];
    if (!track) return [];
    var out = [];
    var items = children(track);
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (!TRIMMABLE[el.name] && el.name !== 'transitionitem') continue;
      var file = child(el, 'file');
      out.push({
        type: el.name,
        id: getAttr(el, 'id'),
        name: childText(el, 'name'),
        enabled: (childText(el, 'enabled') || 'TRUE').toUpperCase() !== 'FALSE',
        start: childInt(el, 'start'),
        end: childInt(el, 'end'),
        in: childInt(el, 'in'),
        out: childInt(el, 'out'),
        pproTicksIn: childText(el, 'pproTicksIn'),
        pproTicksOut: childText(el, 'pproTicksOut'),
        fileId: file ? getAttr(file, 'id') : null
      });
    }
    return out;
  }

  function countClips(xmlOrDoc, trackIndex, kind) {
    var clips = listClips(xmlOrDoc, trackIndex, kind), n = 0;
    for (var i = 0; i < clips.length; i++) if (clips[i].type !== 'transitionitem') n++;
    return n;
  }

  return {
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    parse: parse,
    serialize: serialize,
    rebuild: rebuild,
    listClips: listClips,
    countClips: countClips,
    _findSequence: findSequence,
    _child: child,
    _children: children,
    _getAttr: getAttr,
    _textOf: textOf
  };
});
