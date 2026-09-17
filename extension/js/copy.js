/*
 * Arrow Switch — what the microphone says.
 *
 * Two tones: "mean" (default, roasts you a bit) and "nice" (for when a client is watching).
 * Each key has a few lines; one is picked at random so it doesn't get stale.
 * {placeholders} are filled from the vars object.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchCopy = api;
  else root.ArrowSwitchCopy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LINES = {
    mean: {
      hello: [
        'Open a sequence. I can’t cut thin air, genius.',
        'Nothing open. Bold strategy for an editor.',
        'I’m a talking microphone. Give me a sequence and I’ll do your job.'
      ],
      matched: [
        'Matched mics to cameras. Check my work, I’ve had a few.',
        'Guessed who’s who. Fix the names unless you want “Speaker 1” going viral.',
        'Mics matched. If it’s wrong, that’s on your track naming, not me.'
      ],
      multicam: [
        'Multicam, fancy. I’ll read the angles inside “{source}”.',
        'Ooh, a multicam. I’ll listen inside “{source}”. Try not to touch anything.'
      ],
      finding: ['Finding the mic files. Hope you didn’t name them “Untitled 7”.'],
      listening: [
        'Shhh. Listening to people talk over each other…',
        'Listening… this better be funnier than last week.',
        'Absorbing every “um”. Every. Single. One.'
      ],
      cached: ['Heard this one before. Instant. You’re welcome. '],
      listened: ['Chewed through {audio} of audio in {secs} s. Try doing that. '],
      result: [
        '{cuts} cuts, a shot every {avg} s. Click the strip to check my homework, then smash CUT IT.',
        '{cuts} cuts. I did in seconds what takes you a whole afternoon and three coffees. Click the strip to check, then CUT IT.'
      ],
      cutting: [
        'Saving your project first because I don’t trust you. Making {cuts} cuts in a copy… Premiere may freeze, it’s fine.',
        'Cutting {cuts} shots into a copy. Hands off the keyboard.'
      ],
      fastCutting: ['Rebuilding {cuts} cuts the fast way. Blink and you’ll miss it.'],
      done: [
        'Done in {secs} s. It’s in “{name}”. Original untouched, unlike your deadline.',
        'Done in {secs} s: “{name}”. Go take the credit, I won’t tell.'
      ],
      fastDone: ['Rebuilt “{name}” in {secs} s. Real cuts, no hidden clips. Absolute cinema.'],
      fastHideDone: ['Rebuilt “{name}” in {secs} s. Every angle’s still there, just switched off. Go wild.'],
      multicamDone: ['{count} shots switched to the right angle in “{name}”, done in {secs} s. Still real multicam, so flip any I got wrong. I won’t.'],
      multicamClosing: ['Closing and reopening your project to set the angles. Don’t touch anything, it’s fine, I’ve done this before (once).'],
      multicamPartial: ['Switched {count} shots in “{name}”, but {missing} kept their old angle. Fix those by hand, champ.'],
      noFootage: ['Some shots had no footage on that camera, so they went to the wide. You’re welcome.'],
      cancelled: ['Fine, I stopped. Coward.', 'Stopped. Commitment issues?'],
      error: ['Nope. {msg}', 'Oof. {msg}', 'Well that broke. {msg}'],
      changedOriginal: ['I cut “{name}”, but your original sequence looks different. Undo (⌘Z) and tell Erin, quick.'],
      barelyHeard: ['I barely heard <b>{name}</b> (A{track}). Wrong track, or are they just shy?'],
      identical: ['<b>{a}</b> and <b>{b}</b> sound identical. Same mic twice? Come on.'],
      sharedMic: ['<b>{a}</b> and <b>{b}</b> share mic A{track}. That’s not how mics work.'],
      splitChannels: ['<i>{file}</i> is on {tracks}, so each track gets its own channel. Clever you.'],
      sharedMono: ['<i>{file}</i> is on {tracks} but only has {channels} channel(s). Those mics will sound the same.'],
      needSpeaker: ['You need at least one person. That’s the whole point of a podcast.'],
      presetSaved: ['Saved “{name}”. Look at you, having preferences.'],
      presetDeleted: ['Deleted “{name}”. It was rubbish anyway.'],
      presetName: ['Name it something better than “final final v2”.'],
      setupHello: [
        'Chuck in the camera files and everyone’s mic files. I’ll sort out which is which.',
        'Throw me the cameras and the mic stems. Syncing by ear so you don’t have to clap.'
      ],
      setupNeedCamera: ['I need at least one camera file. Podcasts are on YouTube now, keep up.'],
      setupNeedStem: ['No mic files? Then there’s nothing to sync, mate.'],
      setupProbing: ['Sniffing your files…'],
      setupListening: ['Listening to {file}…'],
      setupSyncing: ['Lining everything up by ear. Next time, clap.'],
      setupWeak: ['I’m not sure about <b>{file}</b> (match {conf}). Check it’s from this episode.'],
      setupBuilding: ['Importing, colouring and laying it all out. Try not to click anything.'],
      setupDone: ['Built “{name}”: {files} files synced and colour-coded. Now pick how cutty and hit LISTEN.'],
      setupMisplaced: ['Built “{name}”, but {list} didn’t land exactly where I put them. Nudge them and don’t blame me.'],
      demoFiles: ['Pretend these are real files. It’s a demo, calm down.']
    },
    nice: {
      hello: ['Hi! Open a podcast sequence and I’ll cut it for you.'],
      matched: ['I matched mics to cameras. Check the names, pick how cutty, then hit LISTEN!'],
      multicam: ['This is a multicam sequence, so I’ll read the angles inside “{source}”.'],
      finding: ['Finding the mic files…'],
      listening: ['Listening to everyone’s mic…'],
      cached: ['I remembered this audio from last time. '],
      listened: ['Listened to {audio} of audio in {secs} s. '],
      result: ['{cuts} cuts, about {avg} s a shot. Click the strip to check a moment in Premiere, then hit CUT IT!'],
      cutting: ['Saving your project, then making {cuts} cuts in a new copy of the sequence. Premiere might freeze for a moment.'],
      fastCutting: ['Rebuilding {cuts} cuts as a new sequence…'],
      done: ['Done in {secs} s! The cuts are in “{name}”. Your original is untouched.'],
      fastDone: ['Rebuilt “{name}” in {secs} s with real cuts.'],
      fastHideDone: ['Rebuilt “{name}” in {secs} s with unused angles disabled.'],
      multicamDone: ['Switched {count} shots to the right angle in “{name}” in {secs} s. They’re still multicam clips, so you can change any of them.'],
      multicamClosing: ['Closing and reopening your project to set the multicam angles…'],
      multicamPartial: ['Switched {count} shots in “{name}”; {missing} kept their original angle, please check those.'],
      noFootage: ['Some shots had no footage on the chosen camera, so they use the wide instead.'],
      cancelled: ['Okay, I stopped. Hit LISTEN! when you’re ready.'],
      error: ['{msg}'],
      changedOriginal: ['I cut “{name}”, but your original sequence looks changed. Undo in Premiere (⌘Z) and let us know what happened.'],
      barelyHeard: ['I barely heard <b>{name}</b> (A{track}). Is that the right mic track?'],
      identical: ['<b>{a}</b> and <b>{b}</b> sound identical, so I can’t tell them apart. Use each person’s own mic.'],
      sharedMic: ['<b>{a}</b> and <b>{b}</b> share mic A{track}.'],
      splitChannels: ['<i>{file}</i> is on {tracks}, so each track hears its own channel.'],
      sharedMono: ['<i>{file}</i> is on {tracks} but has {channels} channel(s), so those mics sound the same.'],
      needSpeaker: ['At least one speaker is needed.'],
      presetSaved: ['Saved preset “{name}”.'],
      presetDeleted: ['Deleted preset “{name}”.'],
      presetName: ['Give your preset a name.'],
      setupHello: ['Add the camera files and each person’s mic file. I’ll work out which is which and sync them.'],
      setupNeedCamera: ['Add at least one camera file.'],
      setupNeedStem: ['Add at least one mic file to sync.'],
      setupProbing: ['Checking your files…'],
      setupListening: ['Listening to {file}…'],
      setupSyncing: ['Syncing everything by audio…'],
      setupWeak: ['I’m not confident about <b>{file}</b> (match {conf}). Check it’s from this episode.'],
      setupBuilding: ['Importing, colour-coding and building the sequence…'],
      setupDone: ['Built “{name}”: {files} files synced and colour-coded. Pick how cutty and hit LISTEN!'],
      setupMisplaced: ['Built “{name}”, but {list} didn’t land exactly on time. Please check them.'],
      demoFiles: ['These are demo files.']
    }
  };

  function fill(line, vars) {
    return line.replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
    });
  }

  // pick: optional function(n) -> index, so tests can be deterministic.
  function line(tone, key, vars, pick) {
    var set = (LINES[tone] || LINES.mean)[key] || LINES.nice[key] || LINES.mean[key];
    if (!set) return key;
    var i = pick ? pick(set.length) : Math.floor(Math.random() * set.length);
    return fill(set[Math.max(0, Math.min(set.length - 1, i))], vars);
  }

  return { LINES: LINES, line: line, fill: fill };
});
