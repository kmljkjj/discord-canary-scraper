#!/usr/bin/env python3
"""Wire percentage helper into experiment_state, extract, notify."""
from pathlib import Path

# --- experiment_state.js ---
esp = Path('src/lib/experiment_state.js')
es = esp.read_text()
changed = False

if "require('./experiment_percentages')" not in es:
    es = es.replace(
        "const { writeJsonAtomic } = require('./atomic');",
        "const { writeJsonAtomic } = require('./atomic');\n"
        "const { attachPercentages } = require('./experiment_percentages');",
    )
    changed = True
    print('state: require')

old_fp = '''function createExperimentFingerprint(exp) {
  const payload = stableObject({
    id: String(exp.id || ''),
    kind: exp.kind || exp.type || null,
    system: exp.system || null,
    label: exp.label || exp.title || null,
    variations: exp.variations || null,
    treatments: exp.treatments || null,
    defaultConfig: exp.defaultConfig || null,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}'''

new_fp = '''function createExperimentFingerprint(exp) {
  const pctKey = (p) => {
    if (!p || p.status === 'unknown' || p.value == null) return null;
    return { status: p.status, value: p.value };
  };
  const payload = stableObject({
    id: String(exp.id || ''),
    kind: exp.kind || exp.type || null,
    system: exp.system || null,
    label: exp.label || exp.title || null,
    variations: exp.variations || null,
    treatments: exp.treatments || null,
    defaultConfig: exp.defaultConfig || null,
    guildPercentage: pctKey(exp.guildPercentage),
    userPercentage: pctKey(exp.userPercentage),
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}'''

if 'pctKey' not in es:
    if old_fp not in es:
        raise SystemExit('fingerprint block missing')
    es = es.replace(old_fp, new_fp)
    changed = True
    print('state: fingerprint')

old_base = '''  const base = {
    id,
    kind,
    type: kind,
    system,
    label,
    title: raw.title || label,
    description: raw.description || null,
    defaultConfig: raw.defaultConfig || null,
    variations,
    treatments: raw.treatments || null,
    variationCount:
      raw.variationCount ||
      (variations && typeof variations === 'object'
        ? Object.keys(variations).length
        : 0) ||
      0,
  };
  base.fingerprint = createExperimentFingerprint(base);
  return base;
}'''

new_base = '''  const base = {
    id,
    kind,
    type: kind,
    system,
    label,
    title: raw.title || label,
    description: raw.description || null,
    defaultConfig: raw.defaultConfig || null,
    variations,
    treatments: raw.treatments || null,
    variationCount:
      raw.variationCount ||
      (variations && typeof variations === 'object'
        ? Object.keys(variations).length
        : 0) ||
      0,
    percentage: raw.percentage,
    percent: raw.percent,
    rate: raw.rate,
    rollout: raw.rollout,
    rolloutPercentage: raw.rolloutPercentage,
    pct: raw.pct,
  };
  const withPct = attachPercentages(base);
  withPct.fingerprint = createExperimentFingerprint(withPct);
  return withPct;
}'''

if 'attachPercentages(base)' not in es:
    if old_base not in es:
        raise SystemExit('normalize base block missing')
    es = es.replace(old_base, new_base)
    changed = True
    print('state: normalize')

if changed:
    esp.write_text(es)
    print('wrote experiment_state', esp.stat().st_size)

# --- notify expLine ---
np = Path('src/lib/notify.js')
ns = np.read_text()
if 'guildPercentage' not in ns:
    old = (
        "  if (nVar != null)\n"
        "    meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);\n"
        "  if (meta.length) line += `\\n${meta.join(' · ')}`;\n"
        "  if (labelTxt) line += `\\n${labelTxt}`;\n"
        "  return line;\n"
        "}"
    )
    # try both middle-dot encodings
    if old not in ns:
        old = (
            "  if (nVar != null)\n"
            "    meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);\n"
            "  if (meta.length) line += `\\n${meta.join(' · ')}`;\n"
            "  if (labelTxt) line += `\\n${labelTxt}`;\n"
            "  return line;\n"
            "}"
        )
    new = (
        "  if (nVar != null)\n"
        "    meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);\n"
        "  const pct =\n"
        "    (e && e.guildPercentage && e.guildPercentage.status !== 'unknown'\n"
        "      ? e.guildPercentage\n"
        "      : null) ||\n"
        "    (e && e.userPercentage && e.userPercentage.status !== 'unknown'\n"
        "      ? e.userPercentage\n"
        "      : null);\n"
        "  if (pct && pct.value != null) {\n"
        "    meta.push(`${pct.value}% (${pct.status})`);\n"
        "  }\n"
        "  if (meta.length) line += `\\n${meta.join(' · ')}`;\n"
        "  if (labelTxt) line += `\\n${labelTxt}`;\n"
        "  return line;\n"
        "}"
    )
    # Fix: use actual file content pattern from disk
    idx = ns.find('if (nVar != null)')
    if idx < 0:
        raise SystemExit('expLine not found')
    end = ns.find('function chunkLines', idx)
    block = ns[idx:end]
    # insert pct after variation meta line
    needle = "meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);"
    if needle not in block:
        raise SystemExit('variation meta line not found')
    insert = (
        needle
        + "\n  const pct =\n"
        "    (e && e.guildPercentage && e.guildPercentage.status !== 'unknown'\n"
        "      ? e.guildPercentage\n"
        "      : null) ||\n"
        "    (e && e.userPercentage && e.userPercentage.status !== 'unknown'\n"
        "      ? e.userPercentage\n"
        "      : null);\n"
        "  if (pct && pct.value != null) {\n"
        "    meta.push(`${pct.value}% (${pct.status})`);\n"
        "  }"
    )
    ns = ns[:idx] + block.replace(needle, insert, 1) + ns[end:]
    np.write_text(ns)
    print('notify patched')
else:
    print('notify already has percentages')

# --- extract enrichment ---
exp = Path('src/lib/extract.js')
ex = exp.read_text()
if 'entry.percentage' not in ex:
    old = 'for (const k of keys) out[k] = { id: Number(k) };'
    new = '''for (const k of keys) {
      const entry = { id: Number(k) };
      const re = new RegExp('(?:^|[,{])\\s*' + k + '\\s*:\\s*\\{([^}]{0,400})\\}');
      const block = body.match(re);
      if (block) {
        const inner = block[1];
        const pct =
          inner.match(/percentage\\s*:\\s*([0-9.]+)/i) ||
          inner.match(/percent\\s*:\\s*([0-9.]+)/i) ||
          inner.match(/rate\\s*:\\s*([0-9.]+)/i);
        if (pct) {
          const n = Number(pct[1]);
          if (Number.isFinite(n)) entry.percentage = n;
        }
        const start = inner.match(/(?:start|min|from)\\s*:\\s*([0-9.]+)/i);
        const end = inner.match(/(?:end|max|to)\\s*:\\s*([0-9.]+)/i);
        if (start && end) {
          entry.start = Number(start[1]);
          entry.end = Number(end[1]);
        }
        const enabled = inner.match(/enabled\\s*:\\s*([0-9.]+)/i);
        const total = inner.match(/total\\s*:\\s*([0-9.]+)/i);
        if (enabled && total) {
          entry.enabled = Number(enabled[1]);
          entry.total = Number(total[1]);
        }
      }
      out[k] = entry;
    }'''
    # The above has wrong escaping for writing into JS via Python - use exact from extract_pct
    if old not in ex:
        raise SystemExit('extract keys loop not found')
    # Use simpler enrichment from prepared file pattern without double escape issues
    new = (
        "for (const k of keys) {\n"
        "      const entry = { id: Number(k) };\n"
        "      const re = new RegExp('(?:^|[,{])\\s*' + k + '\\s*:\\s*\\{([^}]{0,400})\\}');\n"
        "      const block = body.match(re);\n"
        "      if (block) {\n"
        "        const inner = block[1];\n"
        "        const pct =\n"
        "          inner.match(/percentage\\s*:\\s*([0-9.]+)/i) ||\n"
        "          inner.match(/percent\\s*:\\s*([0-9.]+)/i) ||\n"
        "          inner.match(/rate\\s*:\\s*([0-9.]+)/i);\n"
        "        if (pct) {\n"
        "          const n = Number(pct[1]);\n"
        "          if (Number.isFinite(n)) entry.percentage = n;\n"
        "        }\n"
        "        const start = inner.match(/(?:start|min|from)\\s*:\\s*([0-9.]+)/i);\n"
        "        const end = inner.match(/(?:end|max|to)\\s*:\\s*([0-9.]+)/i);\n"
        "        if (start && end) {\n"
        "          entry.start = Number(start[1]);\n"
        "          entry.end = Number(end[1]);\n"
        "        }\n"
        "        const enabled = inner.match(/enabled\\s*:\\s*([0-9.]+)/i);\n"
        "        const total = inner.match(/total\\s*:\\s*([0-9.]+)/i);\n"
        "        if (enabled && total) {\n"
        "          entry.enabled = Number(enabled[1]);\n"
        "          entry.total = Number(total[1]);\n"
        "        }\n"
        "      }\n"
        "      out[k] = entry;\n"
        "    }"
    )
    # Actually write the JS with single backslashes as they appear in source files
    new = open('/dev/null')  # placeholder

print('done partial')
