const fs = require('fs');
const path = 'src/index.js';
let t = fs.readFileSync(path, 'utf8');
if (t.includes('defaultConfig: e.defaultConfig')) {
  console.log('index already patched');
  process.exit(0);
}
const old = `function expSnapshot(e) {\n  return {\n    id: e.id,\n    type: e.type || e.kind || 'user',\n    kind: e.kind || e.type || 'user',\n    label: e.label || null,\n    variationCount:\n      e.variationCount || (e.variations ? Object.keys(e.variations).length : 0) || 0,\n    variations: e.variations || null,\n    fp: expFingerprint(e),\n  };\n}`;
const neu = `function expSnapshot(e) {\n  return {\n    id: e.id,\n    type: e.type || e.kind || 'user',\n    kind: e.kind || e.type || 'user',\n    label: e.label || null,\n    variationCount:\n      e.variationCount || (e.variations ? Object.keys(e.variations).length : 0) || 0,\n    variations: e.variations || null,\n    defaultConfig: e.defaultConfig || null,\n    system: e.system || null,\n    fp: expFingerprint(e),\n  };\n}`;
if (!t.includes(old)) throw new Error('expSnapshot block not found');
t = t.replace(old, neu);
fs.writeFileSync(path, t);
console.log('patched index');
