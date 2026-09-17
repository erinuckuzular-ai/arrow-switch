/*
 * Arrow Switch — Premiere Pro ExtendScript host.
 * Every entry point returns a JSON string: { ok: true, ... } or { ok: false, error }.
 */

var AC_TICKS_PER_SECOND = 254016000000;

function AC_json(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return String(v);
  if (t === 'string') {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(AC_json(v[i]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) if (v.hasOwnProperty(k)) parts.push(AC_json(k) + ':' + AC_json(v[k]));
  return '{' + parts.join(',') + '}';
}

function AC_parse(s) {
  // Input only ever comes from our own panel.
  return eval('(' + s + ')');
}

function AC_run(fn) {
  try {
    return AC_json(fn());
  } catch (e) {
    return AC_json({ ok: false, error: String(e) + (e.line ? ' (line ' + e.line + ')' : '') });
  }
}

function AC_trackInfo(tracks) {
  var out = [];
  for (var i = 0; i < tracks.numTracks; i++) {
    var t = tracks[i];
    var muted = false;
    try { muted = !!t.isMuted(); } catch (e) { /* video tracks have no mute */ }
    // Where the track actually has (enabled) footage, so the panel never cuts to black.
    var cover = [];
    for (var c = 0; c < t.clips.numItems; c++) {
      var k = t.clips[c];
      if (k.disabled) continue;
      var a = k.start.seconds, b = k.end.seconds, last = cover[cover.length - 1];
      if (last && a <= last[1] + 0.001) last[1] = Math.max(last[1], b);
      else cover.push([a, b]);
    }
    // File names on the track (a few), so the panel can tell camera audio from mics.
    var media = [], seen = {};
    for (var m = 0; m < t.clips.numItems && media.length < 6; m++) {
      var mp = '';
      try { mp = t.clips[m].projectItem ? t.clips[m].projectItem.getMediaPath() : ''; } catch (e2) { /* nested */ }
      var base = mp ? String(mp).replace(/^.*[\\\/]/, '') : t.clips[m].name;
      if (base && !seen[base]) { seen[base] = true; media.push(base); }
    }
    out.push({ index: i, name: t.name || '', clipCount: t.clips.numItems, muted: muted, cover: cover, media: media });
  }
  return out;
}

function AC_sequenceById(id) {
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    if (app.project.sequences[i].sequenceID === id) return app.project.sequences[i];
  }
  return null;
}

// The sequence the panel analysed, made active again (the user may have clicked elsewhere).
function AC_activate(id) {
  var seq = AC_sequenceById(id);
  if (!seq) return null;
  var active = app.project.activeSequence;
  if (!active || active.sequenceID !== id) {
    app.project.openSequence(id);
    app.project.activeSequence = seq;
  }
  return seq;
}

function AC_sequenceForItem(item) {
  if (!item) return null;
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var s = app.project.sequences[i];
    if (s.projectItem && s.projectItem.nodeId === item.nodeId) return s;
  }
  return null;
}

/*
 * Multicam editors cut a sequence whose picture is one multicam (or nested) clip. Then
 * the real angles and mics live inside the source sequence, so that's what we analyse.
 * Returns null unless most of the sequence is pieces of a single source sequence.
 */
function AC_findMulticam(seq) {
  var best = null;
  var total = Number(seq.end) / AC_TICKS_PER_SECOND;
  for (var v = 0; v < seq.videoTracks.numTracks; v++) {
    var clips = seq.videoTracks[v].clips;
    var bySource = {};
    for (var c = 0; c < clips.numItems; c++) {
      var clip = clips[c];
      var item = clip.projectItem;
      if (!item) continue;
      var isSeq = false, isMc = false;
      try { isMc = !!item.isMulticamClip(); } catch (e) { /* older Premiere */ }
      try { isSeq = !!item.isSequence(); } catch (e2) { /* older Premiere */ }
      if (!isMc && !isSeq) continue;
      var src = AC_sequenceForItem(item);
      if (!src) continue;
      var entry = bySource[src.sequenceID] = bySource[src.sequenceID] || { source: src, multicam: isMc, pieces: [], covered: 0 };
      entry.pieces.push({ start: clip.start.seconds, end: clip.end.seconds, inPoint: clip.inPoint.seconds });
      entry.covered += clip.end.seconds - clip.start.seconds;
    }
    for (var k in bySource) {
      if (!bySource.hasOwnProperty(k)) continue;
      if (bySource[k].covered > total * 0.5 && (!best || bySource[k].covered > best.covered)) {
        best = bySource[k];
        best.trackIndex = v;
      }
    }
  }
  return best;
}

function AC_fps(seq) {
  return AC_TICKS_PER_SECOND / Number(seq.timebase);
}

function AC_getSequenceInfo() {
  return AC_run(function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'Open a sequence first.' };
    var info = {
      ok: true,
      id: seq.sequenceID,
      name: seq.name,
      fps: AC_fps(seq),
      durationSec: Number(seq.end) / AC_TICKS_PER_SECOND,
      videoTracks: AC_trackInfo(seq.videoTracks),
      audioTracks: AC_trackInfo(seq.audioTracks),
      multicam: null
    };
    var mc = AC_findMulticam(seq);
    if (mc) {
      // Angles = the source sequence's video tracks (angle 1 = V1), mics = its audio tracks.
      info.multicam = {
        sourceId: mc.source.sequenceID,
        sourceName: mc.source.name,
        isMulticam: mc.multicam,
        trackIndex: mc.trackIndex,
        pieces: mc.pieces
      };
      info.videoTracks = AC_trackInfo(mc.source.videoTracks);
      info.audioTracks = AC_trackInfo(mc.source.audioTracks);
    }
    return info;
  });
}

// Cheap check the panel polls to follow whatever sequence the editor is looking at.
function AC_getActiveSequenceId() {
  return AC_run(function () {
    var seq = app.project && app.project.activeSequence;
    return { ok: true, id: seq ? seq.sequenceID : null, name: seq ? seq.name : null };
  });
}

function AC_openSequence(id) {
  return AC_run(function () {
    var seq = AC_activate(id);
    if (!seq) return { ok: false, error: 'That sequence isn’t in the project any more.' };
    return { ok: true, name: seq.name };
  });
}

// Undo for the panel's last run: only ever called with a sequence Arrow Switch created.
function AC_deleteSequence(id) {
  return AC_run(function () {
    var seq = AC_sequenceById(id);
    if (!seq) return { ok: false, error: 'That sequence is already gone.' };
    var name = seq.name;
    if (!app.project.deleteSequence(seq)) return { ok: false, error: 'Premiere wouldn’t delete “' + name + '”.' };
    return { ok: true, name: name };
  });
}

function AC_getAudioClips(indexesJson) {
  return AC_run(function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'Open a sequence first.' };
    var indexes = AC_parse(indexesJson);
    var mc = AC_findMulticam(seq);
    var from = mc ? mc.source : seq;
    var tracks = [];
    for (var i = 0; i < indexes.length; i++) {
      var track = from.audioTracks[indexes[i]];
      if (!track) return { ok: false, error: 'Audio track A' + (indexes[i] + 1) + ' does not exist.' };
      var clips = [];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        if (clip.disabled) continue;   // switched-off audio isn't part of the conversation
        var mediaPath = clip.projectItem ? clip.projectItem.getMediaPath() : '';
        if (!mediaPath) {
          return { ok: false, error: 'Clip "' + clip.name + '" on A' + (indexes[i] + 1) + ' is nested, merged or multicam. Put the raw mic files on the speaker tracks.' };
        }
        if (!mc) {
          clips.push({ name: clip.name, path: mediaPath, start: clip.start.seconds, end: clip.end.seconds, inPoint: clip.inPoint.seconds });
          continue;
        }
        // Map the source-sequence clip onto the edit timeline through every multicam piece.
        for (var pc = 0; pc < mc.pieces.length; pc++) {
          var piece = mc.pieces[pc];
          var a0 = Math.max(clip.start.seconds, piece.inPoint);
          var a1 = Math.min(clip.end.seconds, piece.inPoint + (piece.end - piece.start));
          if (a1 <= a0) continue;
          clips.push({
            name: clip.name,
            path: mediaPath,
            start: piece.start + (a0 - piece.inPoint),
            end: piece.start + (a1 - piece.inPoint),
            inPoint: clip.inPoint.seconds + (a0 - clip.start.seconds)
          });
        }
      }
      tracks.push({ index: indexes[i], clips: clips });
    }
    return { ok: true, tracks: tracks };
  });
}

// getSettings() is slow in ExtendScript: callers fetch it once and pass it in.
function AC_timecode(seq, settings, frame) {
  var t = new Time();
  t.ticks = String(frame * Number(seq.timebase));
  try {
    return t.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
  } catch (e) {
    var fps = Math.round(AC_fps(seq));
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var f = frame % fps, s = Math.floor(frame / fps);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(f);
  }
}

/*
 * payload: {
 *   sourceId, newName, mode: 'disable' | 'delete',
 *   tracks: [video track indexes involved],
 *   segments: [{ startFrame, endFrame, cam }]   cam = video track index
 * }
 */
function AC_applyEdit(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var source = AC_activate(p.sourceId);
    if (!source) return { ok: false, error: 'I can’t find the sequence I listened to any more. Hit LISTEN again.' };

    var originalPrint = AC_fingerprint(source, p.tracks);
    var copy = AC_saveAndClone(source, p.newName);
    if (copy.error) return { ok: false, error: copy.error };
    var seq = copy.seq, qeSeq = copy.qeSeq, saved = copy.saved;

    var fps = AC_fps(seq);
    var settings = seq.getSettings();
    var segs = p.segments;
    var razors = 0;
    var qeTracks = {}, involved = {};
    for (var t = 0; t < p.tracks.length; t++) {
      qeTracks[p.tracks[t]] = qeSeq.getVideoTrackAt(p.tracks[t]);
      involved[p.tracks[t]] = true;
    }
    // Only the outgoing and incoming angles change at a cut; every other track keeps
    // the same on/off state, so razoring it would just add work and timeline clutter.
    for (var s = 1; s < segs.length; s++) {
      var tc = AC_timecode(seq, settings, segs[s].startFrame);
      var pair = [segs[s - 1].cam, segs[s].cam];
      for (var q = 0; q < pair.length; q++) {
        if (!involved[pair[q]] || (q === 1 && pair[1] === pair[0])) continue;
        qeTracks[pair[q]].razor(tc);
        razors++;
      }
    }

    var hidden = 0, shown = 0;
    for (var k = 0; k < p.tracks.length; k++) {
      var trackIndex = p.tracks[k];
      var clips = seq.videoTracks[trackIndex].clips;
      var toRemove = [];
      for (var c = 0; c < clips.numItems; c++) {
        var clip = clips[c];
        var midFrame = Math.floor(((clip.start.seconds + clip.end.seconds) / 2) * fps);
        var seg = AC_findSegment(segs, midFrame);
        var visible = !seg || seg.cam === trackIndex;
        if (p.mode === 'delete') {
          if (!visible) toRemove.push(clip);
        } else if (clip.disabled !== !visible) {
          clip.disabled = !visible;
        }
        if (visible) shown++; else hidden++;
      }
      for (var r = toRemove.length - 1; r >= 0; r--) toRemove[r].remove(false, false);
    }

    var untouched = AC_fingerprint(source, p.tracks) === originalPrint;
    return { ok: true, name: seq.name, sequenceId: seq.sequenceID, razors: razors, hidden: hidden, shown: shown, saved: saved, originalUntouched: untouched };
  });
}

// Saves the project, then duplicates `source` under a unique name and makes the copy the
// active sequence (QE razors only work on the active one). The original is never cut.
function AC_saveAndClone(source, baseName) {
  var saved = false;
  try { app.project.save(); saved = true; } catch (e) { /* unsaved new project: carry on, original is still untouched */ }
  var newName = AC_uniqueSequenceName(baseName);
  var before = {};
  for (var i = 0; i < app.project.sequences.numSequences; i++) before[app.project.sequences[i].sequenceID] = true;
  source.clone();
  var seq = null;
  for (var j = 0; j < app.project.sequences.numSequences; j++) {
    if (!before[app.project.sequences[j].sequenceID]) seq = app.project.sequences[j];
  }
  if (!seq || seq.sequenceID === source.sequenceID) return { error: 'Could not duplicate the sequence, so nothing was cut. Your original is untouched.' };
  seq.name = newName;
  app.project.openSequence(seq.sequenceID);
  app.project.activeSequence = seq;
  app.enableQE();
  var qeSeq = qe.project.getActiveSequence();
  if (!qeSeq || qeSeq.name !== newName || newName === source.name || app.project.activeSequence.sequenceID !== seq.sequenceID) {
    return { error: 'Could not switch to the copy “' + newName + '”, so nothing was cut. Your original is untouched.' };
  }
  return { seq: seq, qeSeq: qeSeq, saved: saved };
}

function AC_uniqueSequenceName(base, ignoreId) {
  var names = {};
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    if (app.project.sequences[i].sequenceID !== ignoreId) names[app.project.sequences[i].name] = true;
  }
  var name = base, n = 2;
  while (names[name]) name = base + ' ' + (n++);
  return name;
}

function AC_secondsTime(sec) {
  var t = new Time();
  t.ticks = String(Math.round(sec * AC_TICKS_PER_SECOND));
  return t;
}

/*
 * Multicam output with real angles.
 * Scripting can razor a multicam clip but not choose its angle, and the angle only lives
 * in the project file. So: duplicate, razor at every switch, switch Multi-Camera on for
 * each piece, and name each piece with a unique tag. The panel then saves + closes the
 * project, writes each tag's angle into the file (prproj.js) and reopens it.
 * payload: { sourceId, newName, trackIndex, segments: [{ startFrame, endFrame, cam }] }
 *          cam = source video track index (angle - 1)
 * Returns pieces: { tag: { angle, name } } and the project path to patch.
 */
function AC_applyMulticam(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var source = AC_activate(p.sourceId);
    if (!source) return { ok: false, error: 'I can’t find the sequence I listened to any more. Hit LISTEN again.' };
    var copy = AC_saveAndClone(source, p.newName);
    if (copy.error) return { ok: false, error: copy.error };
    var seq = copy.seq, settings = seq.getSettings(), fps = AC_fps(seq);
    var qeTrack = copy.qeSeq.getVideoTrackAt(p.trackIndex);
    var razors = 0;
    for (var s = 1; s < p.segments.length; s++) {
      if (p.segments[s].cam === p.segments[s - 1].cam) continue;
      qeTrack.razor(AC_timecode(seq, settings, p.segments[s].startFrame));
      razors++;
    }

    var run = String(new Date().getTime());
    var clips = seq.videoTracks[p.trackIndex].clips;
    var pieces = {}, count = 0, skipped = 0;
    // QE lists empty gaps as items too; walk both lists in time order and pair real clips.
    var qi = 0, qCount = qeTrack.numItems;
    for (var c = 0; c < clips.numItems; c++) {
      var clip = clips[c], item = null;
      while (qi < qCount) {
        var cand = qeTrack.getItemAt(qi++);
        if (cand && cand.type !== 'Empty') { item = cand; break; }
      }
      if (!item) break;
      var isNest = false;
      try { isNest = clip.projectItem && (clip.projectItem.isSequence() || clip.projectItem.isMulticamClip()); } catch (e) { /* ignore */ }
      if (!isNest) { skipped++; continue; }
      var mid = Math.floor(((clip.start.seconds + clip.end.seconds) / 2) * fps);
      var seg = AC_findSegment(p.segments, mid);
      if (!seg) { skipped++; continue; }
      try { if (!item.multicamEnabled && item.canDoMulticam()) item.setMulticam(true); } catch (e2) { /* already multicam */ }
      var tag = 'ASWITCH_' + run + '_' + c;
      pieces[tag] = { angle: seg.cam, name: clip.name };
      item.setName(tag);
      count++;
    }
    try { app.project.save(); } catch (e3) { /* checked by the panel */ }
    return {
      ok: true, name: seq.name, sequenceId: seq.sequenceID, projectPath: app.project.path,
      razors: razors, pieces: pieces, count: count, skipped: skipped, saved: copy.saved
    };
  });
}

// Save and close the project so the panel can write angles into the file.
function AC_closeProject() {
  return AC_run(function () {
    var path = app.project.path;
    if (!path) return { ok: false, error: 'This project has never been saved, so I can’t set angles in it.' };
    app.project.save();
    app.project.closeDocument(0, 0);
    return { ok: true, path: path };
  });
}

/*
 * Reopen the project after the angle patch and show the new sequence. Any piece the patch
 * missed still carries its tag, so put its original name back here.
 * payload: { path, sequenceId, names: { tag: originalName } }
 */
function AC_reopenProject(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    if (!app.openDocument(p.path, true, true, true, true)) return { ok: false, error: 'Premiere could not reopen ' + p.path };
    var seq = AC_sequenceById(p.sequenceId);
    if (!seq) return { ok: false, error: 'Reopened the project but could not find the new sequence.' };
    app.project.openSequence(seq.sequenceID);
    app.project.activeSequence = seq;
    var restored = 0;
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var qt = qs.getVideoTrackAt(t);
      for (var i = 0; i < qt.numItems; i++) {
        var it = qt.getItemAt(i);
        if (it && it.type !== 'Empty' && p.names.hasOwnProperty(it.name)) { it.setName(p.names[it.name]); restored++; }
      }
    }
    if (restored) { try { app.project.save(); } catch (e) { /* ignore */ } }
    return { ok: true, name: seq.name, restored: restored };
  });
}

// Fast cuts, step 1: export the sequence (or a multicam's source) as FCP XML.
function AC_exportXml(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var seq = AC_sequenceById(p.sequenceId);
    if (!seq) return { ok: false, error: 'Could not find that sequence any more.' };
    try { app.project.save(); } catch (e) { /* not saved yet: exporting doesn't change it */ }
    var ok = seq.exportAsFinalCutProXML(p.path, 1);
    if (!ok) return { ok: false, error: 'Premiere refused to export the sequence as XML.' };
    return { ok: true, path: p.path };
  });
}

// Fast cuts, step 2: import the rebuilt XML as a new sequence and open it.
function AC_importXml(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var before = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) before[app.project.sequences[i].sequenceID] = true;
    if (!app.project.importFiles([p.path], true, app.project.getInsertionBin(), false)) {
      return { ok: false, error: 'Premiere could not import the rebuilt XML.' };
    }
    var seq = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      if (!before[app.project.sequences[j].sequenceID]) seq = app.project.sequences[j];
    }
    if (!seq) return { ok: false, error: 'The XML imported but no new sequence appeared.' };
    seq.name = AC_uniqueSequenceName(p.name, seq.sequenceID);
    app.project.openSequence(seq.sequenceID);
    return { ok: true, name: seq.name, sequenceId: seq.sequenceID };
  });
}

// ---------------------------------------------------------------- episode setup

// Project panel selection as file paths, for "use what I already imported".
function AC_getProjectSelection() {
  return AC_run(function () {
    var sel = null;
    try { sel = app.getCurrentProjectViewSelection(); } catch (e) { /* older Premiere */ }
    var files = [];
    if (sel) {
      for (var i = 0; i < sel.length; i++) {
        var path = '';
        try { path = sel[i].getMediaPath(); } catch (e2) { /* bins, sequences */ }
        if (path) files.push({ path: path, name: sel[i].name });
      }
    }
    return { ok: true, files: files };
  });
}

function AC_findItemByPath(bin, path, depth) {
  var want = String(path).replace(/\\/g, '/').toLowerCase();
  for (var i = 0; i < bin.children.numItems; i++) {
    var item = bin.children[i];
    var mp = '';
    try { mp = item.getMediaPath(); } catch (e) { /* bin */ }
    if (mp && String(mp).replace(/\\/g, '/').toLowerCase() === want) return item;
    if (item.type === ProjectItemType.BIN && depth < 6) {
      var found = AC_findItemByPath(item, path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/*
 * Imports cameras + mic stems, colour-labels them, builds a synced sequence and opens it.
 * payload: {
 *   name,
 *   cameras: [{ path, startSec, label, trackName }],   cameras[0] sets the sequence format
 *   stems:   [{ path, startSec, label, trackName }],
 *   muteCameraAudio: true   keep the first camera's audio as the master, mute the others
 * }
 * Layout: V1..Vn cameras (their scratch audio on A1..An), stems on the audio tracks after that.
 */
function AC_buildEpisode(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var root = app.project.rootItem;
    var bin = root.createBin(p.name);
    var all = p.cameras.concat(p.stems), paths = [];
    for (var i = 0; i < all.length; i++) {
      var existing = AC_findItemByPath(root, all[i].path, 0);
      if (existing) all[i].item = existing;
      else paths.push(all[i].path);
    }
    if (paths.length && !app.project.importFiles(paths, true, bin, false)) {
      return { ok: false, error: 'Premiere could not import the files.' };
    }
    for (var j = 0; j < all.length; j++) {
      if (!all[j].item) all[j].item = AC_findItemByPath(bin, all[j].path, 0) || AC_findItemByPath(root, all[j].path, 0);
      if (!all[j].item) return { ok: false, error: 'Imported, but I could not find ' + all[j].path + ' in the project.' };
      // Label before placing: new timeline clips inherit the project item's label.
      if (all[j].label >= 0) { try { all[j].item.setColorLabel(all[j].label); } catch (e) { /* older Premiere */ } }
    }

    var seqName = AC_uniqueSequenceName(p.name);
    var seq = app.project.createNewSequenceFromClips(seqName, [p.cameras[0].item], bin);
    if (!seq) return { ok: false, error: 'Premiere could not create a sequence from the first camera.' };
    app.project.openSequence(seq.sequenceID);
    AC_clearSequence(seq);

    var nc = p.cameras.length, ns = p.stems.length;
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var needV = nc - seq.videoTracks.numTracks, needA = nc + ns - seq.audioTracks.numTracks;
    if (needV > 0 || needA > 0) {
      try {
        qeSeq.addTracks(Math.max(0, needV), seq.videoTracks.numTracks, Math.max(0, needA), 1, seq.audioTracks.numTracks, 0, 0, 0);
      } catch (e) { /* checked below */ }
    }
    if (seq.videoTracks.numTracks < nc || seq.audioTracks.numTracks < nc + ns) {
      return { ok: false, error: 'I need ' + nc + ' video and ' + (nc + ns) + ' audio tracks in “' + seqName + '”. Add tracks and press Build again.' };
    }

    // Premiere snaps clip starts to frames (upwards). Round to the nearest frame instead so
    // every file lands within half a frame of where the audio sync put it.
    var fr = AC_fps(seq);
    for (var rc = 0; rc < all.length; rc++) all[rc].startSec = Math.round(all[rc].startSec * fr) / fr;

    var placed = [];
    for (var c = 0; c < nc; c++) {
      seq.videoTracks[c].overwriteClip(p.cameras[c].item, AC_secondsTime(p.cameras[c].startSec));
      placed.push({ kind: 'camera', index: c, want: p.cameras[c].startSec, track: c });
    }
    for (var s = 0; s < ns; s++) {
      seq.audioTracks[nc + s].overwriteClip(p.stems[s].item, AC_secondsTime(p.stems[s].startSec));
      placed.push({ kind: 'stem', index: s, want: p.stems[s].startSec, track: nc + s });
    }
    for (var m = 0; m < nc; m++) {
      if (p.muteCameraAudio && m > 0) { try { seq.audioTracks[m].setMute(1); } catch (e) { /* ignore */ } }
      try { seq.videoTracks[m].name = p.cameras[m].trackName; } catch (e) { /* track names are read-only in some versions */ }
    }
    for (var n = 0; n < ns; n++) {
      try { seq.audioTracks[nc + n].name = p.stems[n].trackName; } catch (e) { /* read-only */ }
    }

    // Check every clip landed where the sync said it should (within a frame).
    var frame = 1 / AC_fps(seq), off = [];
    for (var q = 0; q < placed.length; q++) {
      var tr = placed[q].kind === 'camera' ? seq.videoTracks[placed[q].track] : seq.audioTracks[placed[q].track];
      var got = tr.clips.numItems ? tr.clips[0].start.seconds : -1;
      if (Math.abs(got - placed[q].want) > frame) off.push(placed[q].kind + ' ' + (placed[q].index + 1));
    }
    var result = { ok: true, sequenceId: seq.sequenceID, name: seq.name, misplaced: off, syncedId: seq.sequenceID };

    // Optional multicam edit: the synced sequence nested on V1 with Multi-Camera switched on
    // (angle 1 = V1 of the synced sequence, and so on).
    if (p.multicam) {
      var edit = app.project.createNewSequenceFromClips(AC_uniqueSequenceName(p.name + ' – Multicam'), [seq.projectItem], bin);
      if (!edit) return { ok: false, error: 'Built “' + seq.name + '” but could not create the multicam edit.' };
      app.project.openSequence(edit.sequenceID);
      app.project.activeSequence = edit;
      app.enableQE();
      var mcItem = qe.project.getActiveSequence().getVideoTrackAt(0).getItemAt(0);
      if (!mcItem || !mcItem.canDoMulticam() || !mcItem.setMulticam(true)) {
        return { ok: false, error: 'Built “' + seq.name + '” but Premiere would not switch Multi-Camera on for the edit.' };
      }
      result.sequenceId = edit.sequenceID;
      result.name = edit.name;
    }
    try { app.project.save(); } catch (e) { /* unsaved project is fine */ }
    return result;
  });
}

function AC_clearSequence(seq) {
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].numTracks; t++) {
      var clips = groups[g][t].clips;
      for (var c = clips.numItems - 1; c >= 0; c--) clips[c].remove(false, false);
    }
  }
}

// Clip layout of the given video tracks, to prove the original wasn't changed.
function AC_fingerprint(seq, trackIndexes) {
  var parts = [];
  for (var t = 0; t < trackIndexes.length; t++) {
    var track = seq.videoTracks[trackIndexes[t]];
    if (!track) continue;
    var clips = track.clips;
    parts.push(trackIndexes[t] + ':' + clips.numItems);
    for (var c = 0; c < clips.numItems; c++) {
      parts.push(clips[c].start.ticks + '-' + clips[c].end.ticks + (clips[c].disabled ? 'd' : ''));
    }
  }
  return parts.join('|');
}

// Sequence markers (best clips). Markers Arrow Switch added before are replaced, not doubled.
function AC_addMarkers(payloadJson) {
  return AC_run(function () {
    var p = AC_parse(payloadJson);
    var seq = AC_sequenceById(p.sequenceId);
    if (!seq) return { ok: false, error: 'Could not find the new sequence to mark.' };
    var old = [], m = seq.markers.getFirstMarker();
    while (m) {
      if (String(m.comments || '').indexOf('[Arrow Switch]') >= 0) old.push(m);
      m = seq.markers.getNextMarker(m);
    }
    for (var o = 0; o < old.length; o++) seq.markers.deleteMarker(old[o]);
    var added = 0;
    for (var i = 0; i < p.markers.length; i++) {
      var d = p.markers[i];
      var mk = seq.markers.createMarker(d.startSec);
      mk.name = d.name;
      mk.comments = d.comment + ' [Arrow Switch]';
      mk.end = d.endSec;
      try { mk.setColorByIndex(d.color); } catch (e) { /* older Premiere */ }
      added++;
    }
    return { ok: true, added: added };
  });
}

function AC_setPlayhead(seconds) {
  return AC_run(function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'Open a sequence first.' };
    seq.setPlayerPosition(String(Math.round(Number(seconds) * AC_TICKS_PER_SECOND)));
    return { ok: true };
  });
}

function AC_findSegment(segs, frame) {
  var lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (frame < segs[mid].startFrame) hi = mid - 1;
    else if (frame >= segs[mid].endFrame) lo = mid + 1;
    else return segs[mid];
  }
  return null;
}
