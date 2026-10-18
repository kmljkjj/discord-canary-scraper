const fs = require('fs');
const path = require('path');
const dir = __dirname;
const parts = ['qpart0.js','qpart1.js','qpart2.js','qpart3.js'].map(f => {
  const p = path.join(dir, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
});
const out = path.join(dir, '..', 'src', 'quests.js');
fs.writeFileSync(out, parts.join(''));
console.log('wrote', out, 'len', parts.join('').length);
