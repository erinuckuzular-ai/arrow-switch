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
    out.push({ index: i, name: t.name || '', clipCount: t.clips.numItems });
  }
  return out;
}

function AC_fps(seq) {
  return AC_TICKS_PER_SECOND / Number(seq.timebase);
}

function AC_getSequenceInfo() {
  return AC_run(function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'Open a sequence first.' };
    return {
      ok: true,
      id: seq.sequenceID,
      name: seq.name,
      fps: AC_fps(seq),
      durationSec: Number(seq.end) / AC_TICKS_PER_SECOND,
      videoTracks: AC_trackInfo(seq.videoTracks),
      audioTracks: AC_trackInfo(seq.audioTracks)
    };
  });
}

function AC_getAudioClips(indexesJson) {
  return AC_run(function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'Open a sequence first.' };
    var indexes = AC_parse(indexesJson);
    var tracks = [];
    for (var i = 0; i < indexes.length; i++) {
      var track = seq.audioTracks[indexes[i]];
      if (!track) return { ok: false, error: 'Audio track A' + (indexes[i] + 1) + ' does not exist.' };
      var clips = [];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        if (clip.disabled) continue;   // switched-off audio isn't part of the conversation
        var mediaPath = clip.projectItem ? clip.projectItem.getMediaPath() : '';
        if (!mediaPath) {
          return { ok: false, error: 'Clip "' + clip.name + '" on A' + (indexes[i] + 1) + ' is nested, merged or multicam. Put the raw mic files on the speaker tracks.' };
        }
        clips.push({
          name: clip.name,
          path: mediaPath,
          start: clip.start.seconds,
          end: clip.end.seconds,
          inPoint: clip.inPoint.seconds
        });
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
    var source = app.project.activeSequence;
    if (!source || source.sequenceID !== p.sourceId) {
      return { ok: false, error: 'The active sequence changed since analysis. Re-analyze first.' };
    }

    // Save first, so the original sequence is safely on disk before anything is cut.
    var saved = false;
    try { app.project.save(); saved = true; } catch (e) { /* unsaved new project: carry on, original is still untouched */ }
    var originalPrint = AC_fingerprint(source, p.tracks);

    // Work on a duplicate with its own unique name; the original is never cut.
    var names = {}, before = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      before[app.project.sequences[i].sequenceID] = true;
      names[app.project.sequences[i].name] = true;
    }
    var newName = p.newName, n = 2;
    while (names[newName]) newName = p.newName + ' ' + (n++);

    source.clone();
    var seq = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      if (!before[app.project.sequences[j].sequenceID]) seq = app.project.sequences[j];
    }
    if (!seq || seq.sequenceID === source.sequenceID) return { ok: false, error: 'Could not duplicate the sequence, so nothing was cut. Your original is untouched.' };
    seq.name = newName;
    app.project.openSequence(seq.sequenceID);
    app.project.activeSequence = seq;

    // Razoring goes through QE, which only works on the active sequence: make sure that is the copy.
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq || qeSeq.name !== newName || newName === source.name || app.project.activeSequence.sequenceID !== seq.sequenceID) {
      return { ok: false, error: 'Could not switch to the copy “' + newName + '”, so nothing was cut. Your original is untouched.' };
    }

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
    return { ok: true, name: seq.name, razors: razors, hidden: hidden, shown: shown, saved: saved, originalUntouched: untouched };
  });
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
