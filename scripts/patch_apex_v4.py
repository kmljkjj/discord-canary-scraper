#!/usr/bin/env python3
"""Patch restored apex_rollouts.js → v4 (filters, hash map, embeds)."""
from pathlib import Path
import re

p = Path('src/apex_rollouts.js')
src = p.read_text()
if 'Apex rollouts v4' in src and 'formatFilters' in src:
    print('already v4')
    raise SystemExit(0)

src = src.replace(
    'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png',
    'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.svg',
)
src = src.replace(
    'Apex rollouts v3 — live Discord + advaith (2024/2025/2026 %)',
    'Apex rollouts v4 — Discord live % + filters + hash map (2024–2026)',
)

# humanizeId after isRecent
src = src.replace(
    '''function isRecent(id) {
  const m = String(id).match(/^(20\d{2})/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}''',
    '''function isRecent(id) {
  const m = String(id).match(/^(20\d{2})/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}
function humanizeId(id) {
  const s = String(id || '');
  if (s.startsWith('hash:')) return s;
  return s
    .replace(/^(20\d{2})[-_]/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || s;
}''',
)

# formatFilters + parsePopulations enhancement
old_pp = '''function parsePopulations(pops) {
  const byB = new Map(), details = [];
  if (!Array.isArray(pops)) return { treatments: [], details };
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    const filters = pop[1] || [];
    const dt = [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      const iv = toIntervals(ranges);
      const pct = intervalsToPct(iv);
      const label = tLabel(bucket);
      dt.push({ bucket, label, pct });
      if (!byB.has(bucket)) byB.set(bucket, { bucket, label, intervals: [] });
      byB.get(bucket).intervals.push(...iv);
    }
    details.push({ filters: filters.length ? String(filters.length) + ' filter(s)' : null, treatments: dt });
  }'''

new_pp = '''function formatFilters(filters) {
  if (!Array.isArray(filters) || !filters.length) return null;
  const parts = [];
  for (const f of filters) {
    if (!Array.isArray(f) || f.length < 2) continue;
    const body = f[1];
    const flat = JSON.stringify(body);
    const platforms = [...flat.matchAll(/"(android|ios|desktop|web)"/gi)].map((m) => m[1].toLowerCase());
    if (platforms.length) {
      parts.push('Platform must be one of these: ' + [...new Set(platforms)].join(', '));
      continue;
    }
    const nums = [...flat.matchAll(/\b(\d{5,})\b/g)].map((m) => m[1]);
    if (nums.length >= 2 && nums[0] !== nums[1]) {
      parts.push('ID range ' + nums[0] + ' – ' + nums[1]);
      continue;
    }
    if (nums.length === 1) {
      parts.push('ID ' + nums[0]);
      continue;
    }
    parts.push('filter');
  }
  return parts.length ? parts.join(' · ') : String(filters.length) + ' filter(s)';
}

function parsePopulations(pops) {
  const byB = new Map(), details = [];
  if (!Array.isArray(pops)) return { treatments: [], details };
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    const filters = pop[1] || [];
    const dt = [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      const iv = toIntervals(ranges);
      const pct = intervalsToPct(iv);
      const label = tLabel(bucket);
      const rangeTxt = iv.map(([a, b]) => a + ' – ' + b).join(', ');
      dt.push({ bucket, label, pct, ranges: rangeTxt || null });
      if (!byB.has(bucket)) byB.set(bucket, { bucket, label, intervals: [] });
      byB.get(bucket).intervals.push(...iv);
    }
    details.push({ filters: formatFilters(filters), treatments: dt });
  }'''

if old_pp not in src:
    print('parsePopulations block missing')
    raise SystemExit(1)
src = src.replace(old_pp, new_pp, 1)

# fromWire: humanize + filter fingerprint
old_fw = '''  const { treatments, details } = parsePopulations(pops);
  const ov = countOverrides(ovs);
  const fingerprint =
    treatments.map((t) => t.bucket + ':' + t.pct.toFixed(2)).join(',') +
    '|ov:' + ov + '|pops:' + pops.length + '|rev:' + rev;
  return {
    id: String(id),
    type: 'guild',
    title: String(id),
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rev,
    hash: Number(hash),
    recent: isRecent(id),
    source: 'discord',
  };
}'''

new_fw = '''  const { treatments, details } = parsePopulations(pops);
  const ov = countOverrides(ovs);
  const idStr = String(id);
  const title = humanizeId(idStr);
  const filtFp = details.map((d) => d.filters || '').join(';');
  const fingerprint =
    treatments.map((t) => t.bucket + ':' + t.pct.toFixed(2)).join(',') +
    '|ov:' + ov + '|pops:' + pops.length + '|rev:' + rev + '|f:' + filtFp;
  return {
    id: idStr,
    type: 'guild',
    title,
    treatments,
    populations: details,
    overrideIdCount: ov,
    populationCount: pops.length,
    fingerprint,
    revision: rev,
    hash: Number(hash),
    recent: isRecent(idStr),
    source: 'discord',
  };
}'''

if old_fw not in src:
    print('fromWire block missing')
    raise SystemExit(1)
src = src.replace(old_fw, new_fw, 1)

# expand hash map
old_hm = '''async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    const h = murmur3(id);
    map.set(h, id);
    map.set(String(h), id);
  };
  try {
    if (await fs.pathExists(LOCAL_EXP)) {
      const data = await fs.readJson(LOCAL_EXP);
      const list = Array.isArray(data) ? data : data.experiments || [];
      for (const e of list) if (e && e.id) addId(String(e.id));
    }
  } catch (e) {
    console.warn('Hash map experiments.json:', e.message);
  }
  try {
    if (await fs.pathExists(KNOWN_EXP)) {
      const data = await fs.readJson(KNOWN_EXP);
      const list = Array.isArray(data) ? data : data.ids || data.experiments || [];
      for (const x of list) addId(typeof x === 'string' ? x : x && x.id ? String(x.id) : null);
    }
  } catch (e) {
    console.warn('Hash map known:', e.message);
  }
  console.log('Hash map:', map.size / 2, 'ids');
  return map;
}'''

new_hm = '''async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    id = id.trim();
    if (!id || id.startsWith('hash:')) return;
    const h = murmur3(id);
    map.set(h, id);
    map.set(String(h), id);
  };
  const files = [
    LOCAL_EXP,
    KNOWN_EXP,
    path.join(DATA_DIR, 'last_extract_experiments.json'),
    path.join(DATA_DIR, 'mobile_experiments.json'),
    path.join(DATA_DIR, 'findings.json'),
  ];
  for (const fp of files) {
    try {
      if (!(await fs.pathExists(fp))) continue;
      const data = await fs.readJson(fp);
      if (data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
        for (const k of Object.keys(data.data)) addId(k);
      }
      const list = Array.isArray(data)
        ? data
        : data.experiments || data.ids || [];
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && x.id) addId(String(x.id));
      }
    } catch (e) {
      console.warn('Hash map', path.basename(fp) + ':', e.message);
    }
  }
  console.log('Hash map:', map.size / 2, 'ids');
  return map;
}'''

if old_hm not in src:
    print('buildHashMap missing')
    raise SystemExit(1)
src = src.replace(old_hm, new_hm, 1)

# soften recent-only gate for live discord changes
src = src.replace(
    "if (!n.recent && !p.recent && maxAbs < 5) continue;",
    """const live = n.source === 'discord' || n.source === 'advaith' || p.source === 'discord' || p.source === 'advaith';
      if (!n.recent && !p.recent && !live && maxAbs < 5) continue;
      if (!n.recent && !p.recent && live && maxAbs < MIN_DELTA) continue;""",
)

# Variant-style changed embeds
pat = re.compile(
    r"  for \(const c of diff\.changed\.slice\(0, 10\)\) \{.*?\n  \}",
    re.S,
)
new_ch = '''  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const popLines = (e.populations || [])
      .filter((p) => p.filters)
      .slice(0, 4)
      .map((p) => '**Population**\\n' + p.filters);
    const lines = c.deltas.slice(0, 12).map((d) => {
      const b = d.bucket != null ? d.bucket : '?';
      return '**Variant ' + b + '** | `' + d.from + '%` → `' + d.to + '%`';
    });
    if (c.ovDelta) lines.push('Overrides · `' + c.ovDelta.from + '` → `' + c.ovDelta.to + '`');
    for (const t of (e.treatments || []).slice(0, 6)) {
      if (t.ranges) lines.push('`' + t.ranges + '`)');
    }
    embeds.push({
      title: e.title || e.id,
      description: [
        '`' + e.id + '`',
        'Type · `' + e.type + '`' + (e.recent ? ' · récent' : ''),
        popLines.join('\\n\\n'),
        '',
        lines.join('\\n'),
      ]
        .filter(Boolean)
        .join('\\n')
        .slice(0, 4000),
      color: 0xe67e22,
      footer: { text: 'Δ max ' + c.maxAbs + '% · ' + (e.source || '') },
    });
  }'''
# fix double escaping - we want single backslash-n in JS source
new_ch = new_ch.replace('\\n', '\n')
m = pat.search(src)
if not m:
    print('changed embed block missing')
    raise SystemExit(1)
src = src[: m.start()] + new_ch + src[m.end() :]

p.write_text(src)
print('patched v4 ok', len(src))
