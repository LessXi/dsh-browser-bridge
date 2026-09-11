import { readFileSync } from 'node:fs';
const src = readFileSync('packages/dsh-browser-bridge/lib/client.js', 'utf8');
const open = src.indexOf('factory: (require) => {');
const close = src.lastIndexOf('},\n})');
if (open === -1 || close === -1) { console.log('FAIL: could not locate the factory body'); process.exit(1); }
const body = src.slice(open + 'factory: (require) => {'.length, close);
try { new Function('require', body); console.log('OK  client.js factory body parses (' + body.length + ' chars)'); }
catch (e) { console.log('FAIL client.js factory body: ' + e.message); process.exit(1); }
