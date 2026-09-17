#!/usr/bin/env node
// Dev-only: evaluate ExtendScript (or panel JS with --js) inside Premiere through the harness.
//   node scripts/harness/es.js 'app.version'          ExtendScript, prints the result string
//   node scripts/harness/es.js --file some.jsx
//   node scripts/harness/es.js --js 'await hostEval("app.version")'
const fs = require('fs');
const args = process.argv.slice(2);
let mode = 'es';
if (args[0] === '--js') { mode = 'js'; args.shift(); }
let code = args[0] === '--file' ? fs.readFileSync(args[1], 'utf8') : args.join(' ');

(async () => {
  const list = await (await fetch('http://localhost:8089/json/list')).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const expr = mode === 'js'
    ? `(async () => { ${code.includes('return') ? code : 'return ' + code} })()`
    : `new Promise((r) => window.__adobe_cep__.evalScript(${JSON.stringify(code)}, r))`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 } }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== 1) return;
    const r = msg.result;
    if (r.exceptionDetails) console.error('EXCEPTION', JSON.stringify(r.exceptionDetails).slice(0, 2000));
    else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
    ws.close();
    process.exit(0);
  };
})();
