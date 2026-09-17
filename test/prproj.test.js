const test = require('node:test');
const assert = require('node:assert');
const P = require('../extension/js/prproj.js');

// Shape taken from a real Premiere 2026 project: track items reference SubClips with
// self-closing tags, SubClips point at VideoClips, VideoClips hold the multicam angle.
const xml = `<PremiereData Version="3">
	<ClipTrackItem ObjectID="10"><SubClip ObjectRef="405"/></ClipTrackItem>
	<SubClip ObjectID="405" ClassID="e0c58dc9" Version="6">
		<Clip ObjectRef="543"/>
		<MasterClip ObjectURef="4b0e"/>
		<Name>ASWITCH_1_0</Name>
		<OrigChGrp>0</OrigChGrp>
	</SubClip>
	<ClipTrackItem ObjectID="11"><SubClip ObjectRef="409"/></ClipTrackItem>
	<SubClip ObjectID="409" ClassID="e0c58dc9" Version="6">
		<Clip ObjectRef="545"/>
		<Name>ASWITCH_1_1</Name>
	</SubClip>
	<VideoClip ObjectRef="545"/>
	<VideoClip ObjectID="543" ClassID="9308dbef" Version="11">
		<Clip Version="18"><SelectedTrackIndex>0</SelectedTrackIndex><IsMulticam>true</IsMulticam></Clip>
	</VideoClip>
	<VideoClip ObjectID="545" ClassID="9308dbef" Version="11">
		<Clip Version="18"><SelectedTrackIndex>0</SelectedTrackIndex><IsMulticam>true</IsMulticam></Clip>
	</VideoClip>
	<SubClip ObjectID="500"><Clip ObjectRef="600"/><Name>Chloë &amp; Grace</Name></SubClip>
	<VideoClip ObjectID="600"><Clip><SelectedTrackIndex>0</SelectedTrackIndex></Clip></VideoClip>
</PremiereData>`;

test('sets each tagged multicam piece to its angle and restores the clip name', () => {
  const r = P.setAngles(xml, {
    ASWITCH_1_0: { angle: 2, name: 'EP 143 & friends' },
    ASWITCH_1_1: { angle: 1, name: 'EP 143 & friends' },
    ASWITCH_1_9: { angle: 1, name: 'gone' }
  });
  assert.strictEqual(r.set, 2);
  assert.deepStrictEqual(r.missing, ['ASWITCH_1_9']);
  assert.match(r.xml, /<VideoClip ObjectID="543"[\s\S]*?<SelectedTrackIndex>2<\/SelectedTrackIndex>/);
  assert.match(r.xml, /<VideoClip ObjectID="545" ClassID[\s\S]*?<SelectedTrackIndex>1<\/SelectedTrackIndex>/);
  assert.match(r.xml, /<VideoClip ObjectID="600"><Clip><SelectedTrackIndex>0</, 'untagged clips untouched');
  assert.strictEqual((r.xml.match(/<Name>EP 143 &amp; friends<\/Name>/g) || []).length, 2);
  assert.ok(!/ASWITCH_1_[01]/.test(r.xml), 'tags removed');
  assert.ok(r.xml.includes('<VideoClip ObjectRef="545"/>'), 'references untouched');
});
