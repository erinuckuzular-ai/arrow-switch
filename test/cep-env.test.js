// Loads the panel scripts the way Premiere does: a browser window that also has
// Node's `module` and `require` globals (CEP --enable-nodejs --mixed-context).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('panel scripts attach to window inside a Node-enabled CEP panel', () => {
  const window = {};
  const context = vm.createContext({ window, self: window, module: { exports: {} }, require, process, Buffer, console });
  window.cep_node = { require };
  for (const file of ['engine.js', 'audio.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'js', file), 'utf8'), context);
  }
  assert.ok(window.AutoCutEngine && typeof window.AutoCutEngine.buildEdit === 'function', 'engine on window');
  assert.ok(window.AutoCutAudio && typeof window.AutoCutAudio.findFfmpeg === 'function', 'audio on window');
});
