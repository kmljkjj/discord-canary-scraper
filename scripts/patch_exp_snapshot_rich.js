const fs = require('fs');
const path = 'src/index.js';
let t = fs.readFileSync(path, 'utf8');
const marker = 'defaultConfig: e.defaultConfig || null,\n    system: e.system || null,\n    fp: expFingerprint(e)';
if (t.includes(marker)) {
  console.log('index already has snapshot defaultConfig');
  process.exit(0);
}
const from = `    variations: e.variations || null,\n    fp: expFingerprint(e),`;
const to = `    variations: e.variations || null,\n    defaultConfig: e.defaultConfig || null,\n    system: e.system || null,\n    fp: expFingerprint(e),`;
if (!t.includes(from)) {
  console.error('target lines not found');
  process.exit(1);
}
// Only replace inside expSnapshot: first occurrence after function expSnapshot
const snapAt = t.indexOf('function expSnapshot');
if (snapAt < 0) throw new Error('no expSnapshot');
const before = t.slice(0, snapAt);
const after = t.slice(snapAt);
if (!after.includes(from)) throw new Error('lines not in expSnapshot region');
const after2 = after.replace(from, to);
t = before + after2;
fs.writeFileSync(path, t);
console.log('patched index expSnapshot');
