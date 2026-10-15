const fs = require('fs');
const path = 'src/lib/experiment_state.js';
let t = fs.readFileSync(path, 'utf8');
if (t.includes('stableConfigPayload')) {
  console.log('already patched');
  process.exit(0);
}
const needle = 'function isMeaningfulModification(prev, cur) {';
const idx = t.indexOf(needle);
if (idx < 0) throw new Error('needle not found');
let depth = 0, end = -1;
for (let i = idx; i < t.length; i++) {
  if (t[i] === '{') depth++;
  else if (t[i] === '}') {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
const replacement = `function stableConfigPayload(exp) {
  if (!exp || typeof exp !== 'object') return null;
  const dc = exp.defaultConfig && typeof exp.defaultConfig === 'object' ? exp.defaultConfig : null;
  let vars = null;
  if (exp.variations && typeof exp.variations === 'object' && !Array.isArray(exp.variations)) {
    vars = exp.variations;
  } else if (Array.isArray(exp.treatments)) {
    vars = {};
    exp.treatments.forEach((t, i) => {
      vars[String(i)] = t && typeof t === 'object' ? t : { value: t };
    });
  }
  if (!dc && !vars) return null;
  return stableObject({ defaultConfig: dc, variations: vars });
}

function isMeaningfulModification(prev, cur) {
  if (!prev || !cur) return false;
  const prevKeys = variationKeysOnly(prev).join(',');
  const curKeys = variationKeysOnly(cur).join(',');
  if (prevKeys !== curKeys) return true;
  const pk = String(prev.kind || prev.type || '').toLowerCase();
  const ck = String(cur.kind || cur.type || '').toLowerCase();
  if (pk && ck && pk !== ck) return true;
  const pl = (prev.label || prev.title || '').trim();
  const cl = (cur.label || cur.title || '').trim();
  if (pl !== cl && (pl || cl)) return true;
  const num = (p) => {
    if (!p || p.status === 'unknown' || p.value == null) return null;
    const n = Number(p.value);
    return Number.isFinite(n) ? n : null;
  };
  const pg = num(prev.guildPercentage);
  const cg = num(cur.guildPercentage);
  if (pg != null && cg != null && Math.abs(pg - cg) >= 0.5) return true;
  const pu = num(prev.userPercentage);
  const cu = num(cur.userPercentage);
  if (pu != null && cu != null && Math.abs(pu - cu) >= 0.5) return true;
  const a = stableConfigPayload(prev);
  const b = stableConfigPayload(cur);
  if (a && b && JSON.stringify(a) !== JSON.stringify(b)) return true;
  return false;
}`;
t = t.slice(0, idx) + replacement + t.slice(end);
if (!t.includes('_before: row.before')) {
  t = t.replace(
    `return {\n          ...row.after,\n          _prevKeys:`,
    `return {\n          ...row.after,\n          _before: row.before || null,\n          _prevKeys:`,
  );
}
fs.writeFileSync(path, t);
console.log('patched experiment_state', t.length);
