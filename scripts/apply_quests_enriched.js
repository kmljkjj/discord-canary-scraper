/**
 * One-shot decoder: writes src/quests.js from base64 parts.
 * Run: node scripts/apply_quests_enriched.js
 */
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const p1 = fs.readFileSync(path.join(dir, 'quests_enriched.b64.part1'), 'utf8').trim();
const p2 = fs.readFileSync(path.join(dir, 'quests_enriched.b64.part2'), 'utf8').trim();
const out = path.join(dir, '..', 'src', 'quests.js');
const buf = Buffer.from(p1 + p2, 'base64');
fs.writeFileSync(out, buf);
console.log('Wrote', out, 'bytes', buf.length);
