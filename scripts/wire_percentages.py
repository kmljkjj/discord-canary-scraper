#!/usr/bin/env python3
from pathlib import Path

def patch_state():
    p = Path('src/lib/experiment_state.js')
    es = p.read_text()
    if "require('./experiment_percentages')" not in es:
        es = es.replace(
            "const { writeJsonAtomic } = require('./atomic');",
            "const { writeJsonAtomic } = require('./atomic');\n"
            "const { attachPercentages } = require('./experiment_percentages');",
        )
        print('state require')
    if 'pctKey' not in es:
        old = '''function createExperimentFingerprint(exp) {
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
        new = '''function createExperimentFingerprint(exp) {
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
        if old not in es:
            raise SystemExit('fingerprint block missing')
        es = es.replace(old, new)
        print('state fingerprint')
    if 'attachPercentages(base)' not in es:
        old = '''  const base = {
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
        new = '''  const base = {
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
        if old not in es:
            raise SystemExit('normalize block missing')
        es = es.replace(old, new)
        print('state normalize')
    p.write_text(es)

def patch_notify():
    p = Path('src/lib/notify.js')
    ns = p.read_text()
    if 'guildPercentage' in ns:
        print('notify ok')
        return
    needle = "meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);"
    if needle not in ns:
        raise SystemExit('notify variation line missing')
    insert = needle + '''
  const pct =
    (e && e.guildPercentage && e.guildPercentage.status !== 'unknown'
      ? e.guildPercentage
      : null) ||
    (e && e.userPercentage && e.userPercentage.status !== 'unknown'
      ? e.userPercentage
      : null);
  if (pct && pct.value != null) {
    meta.push(`${pct.value}% (${pct.status})`);
  }'''
    ns = ns.replace(needle, insert, 1)
    p.write_text(ns)
    print('notify patched')

def patch_extract():
    p = Path('src/lib/extract.js')
    ex = p.read_text()
    if 'entry.percentage' in ex:
        print('extract ok')
        return
    old = 'for (const k of keys) out[k] = { id: Number(k) };'
    if old not in ex:
        raise SystemExit('extract loop missing')
    new = (
        'for (const k of keys) {\n'
        '      const entry = { id: Number(k) };\n'
        "      const re = new RegExp('(?:^|[,{])\\s*' + k + '\\s*:\\s*\\{([^}]{0,400})\\}');\n"
        '      const block = body.match(re);\n'
        '      if (block) {\n'
        '        const inner = block[1];\n'
        '        const pct =\n'
        '          inner.match(/percentage\\s*:\\s*([0-9.]+)/i) ||\n'
        '          inner.match(/percent\\s*:\\s*([0-9.]+)/i) ||\n'
        '          inner.match(/rate\\s*:\\s*([0-9.]+)/i);\n'
        '        if (pct) {\n'
        '          const n = Number(pct[1]);\n'
        '          if (Number.isFinite(n)) entry.percentage = n;\n'
        '        }\n'
        '        const start = inner.match(/(?:start|min|from)\\s*:\\s*([0-9.]+)/i);\n'
        '        const end = inner.match(/(?:end|max|to)\\s*:\\s*([0-9.]+)/i);\n'
        '        if (start && end) {\n'
        '          entry.start = Number(start[1]);\n'
        '          entry.end = Number(end[1]);\n'
        '        }\n'
        '        const enabled = inner.match(/enabled\\s*:\\s*([0-9.]+)/i);\n'
        '        const total = inner.match(/total\\s*:\\s*([0-9.]+)/i);\n'
        '        if (enabled && total) {\n'
        '          entry.enabled = Number(enabled[1]);\n'
        '          entry.total = Number(total[1]);\n'
        '        }\n'
        '      }\n'
        '      out[k] = entry;\n'
        '    }'
    )
    # The above still double-escapes regex literals. Build with chr:
    new = 'for (const k of keys) {\n'
    new += '      const entry = { id: Number(k) };\n'
    new += "      const re = new RegExp('(?:^|[,{])\\s*' + k + '\\s*:\\s*\\{([^}]{0,400})\\}');\n"
    new += '      const block = body.match(re);\n'
    new += '      if (block) {\n'
    new += '        const inner = block[1];\n'
    new += '        const pct =\n'
    new += '          inner.match(/percentage\s*:\s*([0-9.]+)/i) ||\n'
    new += '          inner.match(/percent\s*:\s*([0-9.]+)/i) ||\n'
    new += '          inner.match(/rate\s*:\s*([0-9.]+)/i);\n'
    new += '        if (pct) {\n'
    new += '          const n = Number(pct[1]);\n'
    new += '          if (Number.isFinite(n)) entry.percentage = n;\n'
    new += '        }\n'
    new += '        const start = inner.match(/(?:start|min|from)\s*:\s*([0-9.]+)/i);\n'
    new += '        const end = inner.match(/(?:end|max|to)\s*:\s*([0-9.]+)/i);\n'
    new += '        if (start && end) {\n'
    new += '          entry.start = Number(start[1]);\n'
    new += '          entry.end = Number(end[1]);\n'
    new += '        }\n'
    new += '        const enabled = inner.match(/enabled\s*:\s*([0-9.]+)/i);\n'
    new += '        const total = inner.match(/total\s*:\s*([0-9.]+)/i);\n'
    new += '        if (enabled && total) {\n'
    new += '          entry.enabled = Number(enabled[1]);\n'
    new += '          entry.total = Number(total[1]);\n'
    new += '        }\n'
    new += '      }\n'
    new += '      out[k] = entry;\n'
    new += '    }'
    ex = ex.replace(old, new, 1)
    p.write_text(ex)
    print('extract patched')

patch_state()
patch_notify()
patch_extract()
print('ALL OK')
