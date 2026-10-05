#!/usr/bin/env python3
"""Add country flags to quest Discord messages."""
from pathlib import Path

p = Path('src/quests.js')
t = p.read_text()
if 'countryToFlag' in t and 'countriesFlags' in t:
    print('already patched')
    raise SystemExit(0)

marker = 'function normalizeQuest(raw) {'
if marker not in t:
    raise SystemExit('normalizeQuest not found')

helpers = r'''
/** ISO 3166-1 alpha-2 \u2192 flag emoji (regional indicators). */
function countryToFlag(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (c.length !== 2) return null;
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + (c.charCodeAt(0) - 65),
    A + (c.charCodeAt(1) - 65),
  );
}

function extractCountryCodes(root, raw) {
  const codes = new Set();
  const add = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) add(x);
      return;
    }
    if (typeof v === 'object') {
      if (v.code) add(v.code);
      else if (v.country) add(v.country);
      else if (v.country_code) add(v.country_code);
      else {
        for (const [k, val] of Object.entries(v)) {
          if (val === true || val === 1) add(k);
          else add(val);
        }
      }
      return;
    }
    const s = String(v).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) codes.add(s);
  };

  const sources = [root, raw, root && root.config, raw && raw.config].filter(Boolean);
  const keys = [
    'countries',
    'country_codes',
    'available_countries',
    'eligible_countries',
    'geo_countries',
    'regions',
    'region_codes',
    'available_regions',
    'geo_regions',
  ];
  for (const obj of sources) {
    if (!obj || typeof obj !== 'object') continue;
    for (const k of keys) {
      if (obj[k] != null) add(obj[k]);
    }
    for (const nest of ['eligibility', 'geo', 'targeting', 'availability', 'restrictions']) {
      const n = obj[nest];
      if (!n || typeof n !== 'object') continue;
      for (const k of keys) {
        if (n[k] != null) add(n[k]);
      }
    }
  }
  return [...codes].sort();
}

function countriesFlagsLine(codes) {
  if (!codes || !codes.length) return '';
  const flags = [];
  const seen = new Set();
  for (const c of codes) {
    const f = countryToFlag(c);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    flags.push(f);
  }
  return flags.length ? flags.join(' ') : '';
}

'''

t = t.replace(marker, helpers + marker, 1)

old_ret = """    tasksText: formatTasks(root),
    preview: !!(raw.preview || root.preview),
  };
}"""
new_ret = """    tasksText: formatTasks(root),
    preview: !!(raw.preview || root.preview),
    countries: extractCountryCodes(root, raw),
    countriesFlags: countriesFlagsLine(extractCountryCodes(root, raw)),
  };
}"""
if old_ret not in t:
    raise SystemExit('normalizeQuest return not found')
t = t.replace(old_ret, new_ret, 1)

old_v2 = """  if (quest.gameTitle) info.push('**Jeu** \xb7 ' + String(quest.gameTitle).slice(0, 180));
  if (quest.publisher) info.push('**\xc9diteur** \xb7 ' + String(quest.publisher).slice(0, 120));
"""
# Use exact file content with unicode middot and accents as in source
old_v2 = """  if (quest.gameTitle) info.push('**Jeu** \u00b7 ' + String(quest.gameTitle).slice(0, 180));
  if (quest.publisher) info.push('**\u00c9diteur** \u00b7 ' + String(quest.publisher).slice(0, 120));
"""
# Actually the file has literal · and Éditeur - match from downloaded file
old_v2 = "  if (quest.gameTitle) info.push('**Jeu** \u00b7 ' + String(quest.gameTitle).slice(0, 180));\n  if (quest.publisher) info.push('**\u00c9diteur** \u00b7 ' + String(quest.publisher).slice(0, 120));\n"
# Simpler: find lines by unique prefix
import re
m = re.search(r"  if \(quest\.gameTitle\) info\.push\([^\n]+\);\n  if \(quest\.publisher\) info\.push\([^\n]+\);\n", t)
if not m:
    raise SystemExit('V2 gameTitle block not found')
t = t[:m.start()] + "  if (quest.countriesFlags) info.push(quest.countriesFlags);\n" + m.group(0) + t[m.end():]

m2 = re.search(r"  if \(quest\.gameTitle\) desc\.push\([^\n]+\);\n  if \(quest\.publisher\) desc\.push\([^\n]+\);\n", t)
if not m2:
    raise SystemExit('embed gameTitle block not found')
t = t[:m2.start()] + "  if (quest.countriesFlags) desc.push(quest.countriesFlags);\n" + m2.group(0) + t[m2.end():]

old_merge = """    quests = Array.from(byId.values());
  }

  console.log(
    'Qu\u00eates fusionn\u00e9es:',
"""
# match whatever encoding of Quêtes fusionnées is in file
m3 = re.search(
    r"    quests = Array\.from\(byId\.values\(\)\);\n  \}\n\n  console\.log\(\n    'Qu.{1,10} fusionn.{1,5}:',",
    t,
)
if not m3:
    raise SystemExit('merge block not found')

regions = r'''    quests = Array.from(byId.values());
  }

  // Region / country flags from discordquest.com (best-effort)
  try {
    const regRes = await fetch('https://api.discordquest.com/api/regions', {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      timeout: 20000,
    });
    if (regRes.ok) {
      const regData = await regRes.json();
      const byQuest = {};
      const addCodes = (qid, arr) => {
        if (!qid) return;
        const id = String(qid);
        if (!byQuest[id]) byQuest[id] = new Set();
        for (const c of arr || []) {
          const s = String(c || '').trim().toUpperCase();
          if (/^[A-Z]{2}$/.test(s)) byQuest[id].add(s);
        }
      };
      if (Array.isArray(regData)) {
        for (const row of regData) {
          if (!row || typeof row !== 'object') continue;
          const qid = row.quest_id || row.questId || row.id;
          const countries = row.countries || row.country_codes || row.regions || row.codes || null;
          if (countries) addCodes(qid, Array.isArray(countries) ? countries : [countries]);
          if (row.country || row.code) {
            const code = row.country || row.code;
            const qids = row.quests || row.quest_ids || [];
            for (const q of qids) addCodes(q, [code]);
          }
        }
      } else if (regData && typeof regData === 'object') {
        for (const [k, v] of Object.entries(regData)) {
          if (/^[A-Z]{2}$/i.test(k) && Array.isArray(v)) {
            for (const q of v) addCodes(q, [k]);
          } else if (Array.isArray(v)) {
            addCodes(k, v);
          } else if (v && typeof v === 'object') {
            const countries = v.countries || v.country_codes || v.regions || v.codes || null;
            if (countries) addCodes(k, Array.isArray(countries) ? countries : [countries]);
          }
        }
      }
      let enriched = 0;
      for (const q of quests) {
        const extra = byQuest[q.id];
        if (!extra || !extra.size) continue;
        const merged = new Set([...(q.countries || []), ...extra]);
        q.countries = [...merged].sort();
        q.countriesFlags = countriesFlagsLine(q.countries);
        enriched++;
      }
      console.log('Regions API: enriched', enriched, 'quests with country flags');
    } else {
      console.warn('Regions API HTTP', regRes.status);
    }
  } catch (e) {
    console.warn('Regions API:', String(e.message || e).slice(0, 120));
  }

  console.log(
    ''' + m3.group(0).split("console.log(")[1]
# fix - use simpler approach

# Re-do merge replacement properly
anchor = '    quests = Array.from(byId.values());\n  }\n\n  console.log('\n'
if anchor not in t:
    # try without exact
    idx = t.find('    quests = Array.from(byId.values());')
    if idx < 0:
        raise SystemExit('byId.values not found')
    # find console.log after
    cidx = t.find("console.log(", idx)
    insert_at = cidx
    regions_js = '''  // Region / country flags from discordquest.com (best-effort)
  try {
    const regRes = await fetch('https://api.discordquest.com/api/regions', {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      timeout: 20000,
    });
    if (regRes.ok) {
      const regData = await regRes.json();
      const byQuest = {};
      const addCodes = (qid, arr) => {
        if (!qid) return;
        const id = String(qid);
        if (!byQuest[id]) byQuest[id] = new Set();
        for (const c of arr || []) {
          const s = String(c || '').trim().toUpperCase();
          if (/^[A-Z]{2}$/.test(s)) byQuest[id].add(s);
        }
      };
      if (Array.isArray(regData)) {
        for (const row of regData) {
          if (!row || typeof row !== 'object') continue;
          const qid = row.quest_id || row.questId || row.id;
          const countries = row.countries || row.country_codes || row.regions || row.codes || null;
          if (countries) addCodes(qid, Array.isArray(countries) ? countries : [countries]);
          if (row.country || row.code) {
            const code = row.country || row.code;
            for (const q of row.quests || row.quest_ids || []) addCodes(q, [code]);
          }
        }
      } else if (regData && typeof regData === 'object') {
        for (const [k, v] of Object.entries(regData)) {
          if (/^[A-Z]{2}$/i.test(k) && Array.isArray(v)) {
            for (const q of v) addCodes(q, [k]);
          } else if (Array.isArray(v)) {
            addCodes(k, v);
          } else if (v && typeof v === 'object') {
            const countries = v.countries || v.country_codes || v.regions || v.codes || null;
            if (countries) addCodes(k, Array.isArray(countries) ? countries : [countries]);
          }
        }
      }
      let enriched = 0;
      for (const q of quests) {
        const extra = byQuest[q.id];
        if (!extra || !extra.size) continue;
        const merged = new Set([...(q.countries || []), ...extra]);
        q.countries = [...merged].sort();
        q.countriesFlags = countriesFlagsLine(q.countries);
        enriched++;
      }
      console.log('Regions API: enriched', enriched, 'quests with country flags');
    } else {
      console.warn('Regions API HTTP', regRes.status);
    }
  } catch (e) {
    console.warn('Regions API:', String(e.message || e).slice(0, 120));
  }

'''
    t = t[:insert_at] + regions_js + t[insert_at:]
else:
    pass

p.write_text(t)
print('patched OK')
