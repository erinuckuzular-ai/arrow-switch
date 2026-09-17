/*
 * Arrow Switch — real multicam angles.
 *
 * Premiere's scripting API can razor a multicam clip but can't choose its angle. The
 * angle lives in the project file: every multicam VideoClip has <SelectedTrackIndex>
 * (0 = angle 1). host.jsx names each razored piece with a unique tag, the project is
 * saved and closed, setAngles() rewrites the (gunzipped) project XML, and the project is
 * reopened. The pieces stay live multicam clips, so editors can still re-switch them.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ArrowSwitchPrproj = api;
  else root.ArrowSwitchPrproj = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  /*
   * xml: project XML string.
   * pieces: { tag: { angle: 0-based source video track, name: original clip name } }
   * Returns { xml, set: number of angles written, missing: [tags not found] }.
   */
  function setAngles(xml, pieces) {
    var clipForTag = {};
    // <SubClip ObjectID=".."> ... <Clip ObjectRef="N"/> ... <Name>TAG</Name> ... </SubClip>
    // Skip self-closing references like <SubClip ObjectRef="405"/>: only real definitions.
    xml = xml.replace(/<SubClip\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/SubClip>/g, function (sub) {
      var name = /<Name>([^<]*)<\/Name>/.exec(sub);
      if (!name || !pieces.hasOwnProperty(name[1])) return sub;
      var ref = /<Clip ObjectRef="(\d+)"\/>/.exec(sub);
      if (ref) clipForTag[name[1]] = ref[1];
      return sub.replace(/<Name>[^<]*<\/Name>/, '<Name>' + escapeXml(pieces[name[1]].name) + '</Name>');
    });

    var angleForClip = {};
    Object.keys(clipForTag).forEach(function (tag) { angleForClip[clipForTag[tag]] = pieces[tag].angle; });

    var set = 0;
    xml = xml.replace(/<VideoClip ObjectID="(\d+)"(?![^>]*\/>)[^>]*>[\s\S]*?<\/VideoClip>/g, function (clip, id) {
      if (!angleForClip.hasOwnProperty(id)) return clip;
      if (!/<SelectedTrackIndex>/.test(clip)) return clip;
      set++;
      return clip.replace(/<SelectedTrackIndex>\d+<\/SelectedTrackIndex>/, '<SelectedTrackIndex>' + angleForClip[id] + '</SelectedTrackIndex>');
    });

    var missing = Object.keys(pieces).filter(function (tag) { return !clipForTag[tag]; });
    return { xml: xml, set: set, missing: missing };
  }

  // A tag no editor would ever type as a clip name.
  function makeTag(runId, index) { return 'ASWITCH_' + runId + '_' + index; }

  return { setAngles: setAngles, makeTag: makeTag };
});
