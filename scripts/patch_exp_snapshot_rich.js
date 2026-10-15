const fs = require('fs');
const path = 'src/index.js';
let t = fs.readFileSync(path, 'utf8');
if (t.includes('defaultConfig: e.defaultConfig')) {
  console.log('index already patched');
  process.exit(0);
}
const re = /function expSnapshot\(e\) \{[\s\S]*?\n\}\n\nfunction buildGap/;
if (!re.test(t)) throw new Error('expSnapshot block not found');
t = t.replace(
  re,
  `function expSnapshot(e) {
  return {
    id: e.id,
    type: e.type || e.kind || 'user',
    kind: e.kind || e.type || 'user',
    label: e.label || null,
    variationCount:
      e.variationCount || (e.variations ? Object.keys(e.variations).length : 0) || 0,
    variations: e.variations || null,
    defaultConfig: e.defaultConfig || null,
    system: e.system || null,
    fp: expFingerprint(e),
  };
}

function buildGap`,
);
fs.writeFileSync(path, t);
console.log('patched index ok');
