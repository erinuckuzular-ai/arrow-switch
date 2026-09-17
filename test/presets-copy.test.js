const test = require('node:test');
const assert = require('node:assert');
const P = require('../extension/js/presets.js');
const C = require('../extension/js/copy.js');

function memory() {
  let data = null;
  return { read: () => data, write: (s) => { data = s; }, peek: () => data };
}

test('presets: built-ins always listed, custom presets saved, overwritten and removed', () => {
  const mem = memory();
  const store = P.createStore(mem);
  assert.deepStrictEqual(store.list().map((p) => p.id), ['sleepy', 'chatty', 'chaotic']);

  const saved = store.save('  Grace   pod  ', { minShotSec: 3, output: 'fast', junk: 1 });
  assert.strictEqual(saved.name, 'Grace pod');
  assert.deepStrictEqual(saved.settings, { minShotSec: 3, output: 'fast' });
  assert.strictEqual(store.list().length, 4);

  store.save('grace pod', { minShotSec: 5 });
  assert.strictEqual(store.list().length, 4, 'same name overwrites');
  assert.strictEqual(store.get(saved.id).settings.minShotSec, 5);

  assert.strictEqual(store.save('Chatty', {}).name, 'Chatty (mine)');
  assert.ok(store.remove(saved.id));
  assert.strictEqual(store.remove('sleepy'), null, 'built-ins cannot be removed');
  assert.deepStrictEqual(store.list().map((p) => p.id), ['sleepy', 'chatty', 'chaotic', 'custom-chatty-mine']);
});

test('presets: corrupt storage falls back to built-ins, empty names rejected', () => {
  const store = P.createStore({ read: () => '{not json', write: () => {} });
  assert.strictEqual(store.list().length, 3);
  assert.throws(() => store.save('   ', {}));
});

test('presets: matching ignores output mode', () => {
  const chatty = P.BUILTIN[1];
  assert.strictEqual(P.matching(P.BUILTIN, Object.assign({ output: 'fast' }, chatty.settings)), 'chatty');
  assert.strictEqual(P.matching(P.BUILTIN, Object.assign({}, chatty.settings, { minShotSec: 99 })), null);
});

test('copy: every mean line has a nice version and placeholders fill in', () => {
  for (const key of Object.keys(C.LINES.mean)) assert.ok(C.LINES.nice[key], `nice.${key} missing`);
  assert.strictEqual(C.line('nice', 'done', { secs: 2.5, name: 'EP 1' }, () => 0), 'Done in 2.5 s! The cuts are in “EP 1”. Your original is untouched.');
  assert.match(C.line('mean', 'result', { cuts: 12, avg: '4.0' }, () => 0), /^12 cuts, a shot every 4\.0 s/);
  assert.strictEqual(C.line('mean', 'nope-not-a-key'), 'nope-not-a-key');
});
