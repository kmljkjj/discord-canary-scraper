#!/usr/bin/env python3
"""v11.5: apex/legacy, defaultConfig, richer routes, snapshots."""
from pathlib import Path

def patch_extract():
    p = Path('src/lib/extract.js')
    t = p.read_text()
    if "system: 'apex'" in t and 'extractDefaultConfigNear' in t:
        print('extract: already v11.5')
        return True

    old_routes = '''function extractRoutes(content, out) {
  const re =
    /\\b([A-Z][A-Z0-9_]{2,80})\\s*:\\s*["'`](\\/[a-zA-Z0-9_\\-./{}@:]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re2 =
    /["']([A-Z][A-Z0-9_]{2,80})["']\\s*:\\s*["'](\\/[^"']{1,200})["']/g;
  while ((m = re2.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re3 =
    /\\.([A-Z][A-Z0-9_]{2,80})\\s*=\\s*["'](\\/[a-zA-Z0-9_\\-./{}@:]+)["']/g;
  while ((m = re3.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
}'''
    # Use file content matching without over-escaping - load from live patterns
    start = t.find('function extractRoutes(content, out) {')
    end = t.find('function extractExperiments(content, map) {', start)
    if start < 0 or end < 0:
        print('extract: routes markers miss')
        return False
    new_routes = r'''function extractRoutes(content, out) {
  const re =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*["'`](\/[a-zA-Z0-9_\-./{}@:$]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re2 =
    /["']([A-Z][A-Z0-9_]{2,100})["']\s*:\s*["'](\/[^"']{1,250})["']/g;
  while ((m = re2.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re3 =
    /\.([A-Z][A-Z0-9_]{2,100})\s*=\s*["'](\/[a-zA-Z0-9_\-./{}@:$]+)["']/g;
  while ((m = re3.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re4 =
    /(?:Endpoints|Routes|API_ENDPOINTS|APIRoutes)\s*(?:\.|\[)\s*["']?([A-Z][A-Z0-9_]{2,100})["']?\s*(?:\])?\s*=\s*["'`](\/[^"'`]{1,250})["'`]/g;
  while ((m = re4.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re5 =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*(?:\([^)]*\)\s*=>\s*)?["'`](\/[a-zA-Z0-9_\-./{}@:$]+)["'`]/g;
  while ((m = re5.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
}

'''
    t = t[:start] + new_routes + t[end:]

    old_up_start = t.find('function upsertExp(map, id, kind, content, posAfter) {')
    old_up_end = t.find('function countVariationsNear(content, from) {', old_up_start)
    if old_up_start < 0 or old_up_end < 0:
        print('extract: upsertExp markers miss')
        return False
    new_up = r'''function extractDefaultConfigNear(content, from) {
  const window = content.slice(from, from + 2800);
  const m = window.match(/defaultConfig\s*:\s*\{/);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < window.length && depth > 0; i++) {
    if (window[i] === '{') depth++;
    else if (window[i] === '}') depth--;
  }
  const body = window.slice(start, i - 1);
  const out = {};
  const re = /([A-Za-z_][\w]*)\s*:\s*(true|false|null|\d+|["'][^"']*["'])/g;
  let x;
  while ((x = re.exec(body)) !== null) {
    let v = x[2];
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, '');
    out[x[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

function extractLabelNear(content, from) {
  const window = content.slice(Math.max(0, from - 200), from + 1200);
  const m =
    window.match(/label\s*:\s*["']([^"']{3,120})["']/) ||
    window.match(/title\s*:\s*["']([^"']{3,120})["']/);
  return m ? m[1] : null;
}

function upsertExp(map, id, kind, content, posAfter) {
  if (!id || /^20\d{2}-\d{2}$/.test(id)) return;
  const variations = countVariationsNear(content, posAfter);
  const defaultConfig = extractDefaultConfigNear(content, posAfter);
  const label = extractLabelNear(content, posAfter);
  const hasTreatmentsArray = /treatments\s*:\s*\[/.test(
    content.slice(posAfter, posAfter + 2800),
  );
  const system = hasTreatmentsArray ? 'legacy' : 'apex';
  const existing = map.get(id);
  if (existing) {
    if (kind === 'guild') {
      existing.type = 'guild';
      existing.kind = 'guild';
    }
    if (
      variations &&
      (!existing.variations ||
        Object.keys(variations).length >
          Object.keys(existing.variations || {}).length)
    ) {
      existing.variations = variations;
      existing.variationCount = Object.keys(variations).length;
    }
    if (defaultConfig && !existing.defaultConfig)
      existing.defaultConfig = defaultConfig;
    if (label && !existing.label) existing.label = label;
    if (!existing.system) existing.system = system;
    return;
  }
  map.set(id, {
    id,
    type: kind,
    kind,
    label: label || null,
    system,
    defaultConfig: defaultConfig || null,
    variations,
    variationCount: variations ? Object.keys(variations).length : 0,
    source: 'discord',
  });
}

'''
    t = t[:old_up_start] + new_up + t[old_up_end:]

    old_reid = '''    map.set(id, {
      id,
      type,
      kind: type,
      label: null,
      variations,
      variationCount: variations ? Object.keys(variations).length : 0,
      source: 'discord',
    });'''
    new_reid = '''    map.set(id, {
      id,
      type,
      kind: type,
      label: extractLabelNear(content, m.index) || null,
      system: 'apex',
      defaultConfig: extractDefaultConfigNear(content, m.index),
      variations,
      variationCount: variations ? Object.keys(variations).length : 0,
      source: 'discord',
    });'''
    if old_reid in t:
        t = t.replace(old_reid, new_reid, 1)

    p.write_text(t)
    print('extract: patched')
    return True


def patch_notify():
    p = Path('src/lib/notify.js')
    t = p.read_text()
    if '· _${system}_' in t or "· _${system}_" in t or "_system_" in t:
        # check for system tag in expLine
        pass
    start = t.find('function expLine(e, prefix) {')
    end = t.find('function chunkLines', start)
    if start < 0 or end < 0:
        print('notify: expLine miss')
        return False
    if 'e.system' in t[start:end]:
        print('notify: already enriched')
        return True
    new_fn = '''function expLine(e, prefix) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const system = (e && e.system) || (e && e.treatments ? 'legacy' : 'apex');
  const labelTxt = e && e.label ? cleanText(e.label, 70) : null;
  let depth = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    depth = `${e.treatments.length} treatments`;
  else if (e && e.variations && typeof e.variations === 'object')
    depth = `${Object.keys(e.variations).length} variations`;
  else if (e && e.variationCount)
    depth = `${e.variationCount} variations`;

  let line = `\`${prefix}${id}\` · **${kind}** · _${system}_`;
  if (labelTxt) line += `\n　${labelTxt}`;
  if (depth) line += ` · _${depth}_`;
  return line;
}

'''
    t = t[:start] + new_fn + t[end:]
    t = t.replace(
        "title: label(E.exp, 'Experiments'),",
        "title: label(E.exp, 'Experiments · Apex / Legacy'),",
        1,
    )
    p.write_text(t)
    print('notify: patched')
    return True


def patch_index():
    p = Path('src/index.js')
    t = p.read_text()
    if 'apex_experiments.json' in t:
        print('index: already snapshots')
        return True
    for a, b in [
        ('Canary Pulse v11.4 (no build webhooks — exp/routes/strings only)',
         'Canary Pulse v11.5 (apex/legacy · snapshots · richer routes)'),
        ('Canary Pulse v11.3 (stable experiments)',
         'Canary Pulse v11.5 (apex/legacy · snapshots · richer routes)'),
    ]:
        if a in t:
            t = t.replace(a, b, 1)
            break
    needle = '''  await Promise.all([
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
  ]);'''
    insert = '''  await Promise.all([
    saveKnownIds(KNOWN_EXP, knownExp, 8000),
    saveKnownIds(KNOWN_STR, knownStr, 50000),
    saveKnownIds(KNOWN_RT, knownRt, 10000),
    saveLastMap(LAST_EXTRACT_STR, extractedStrings, build.buildNumber),
    saveLastMap(LAST_EXTRACT_RT, nextRt, build.buildNumber),
    saveLastMap(LAST_EXTRACT_EXP, nextExpSnap, build.buildNumber),
  ]);

  try {
    const allExps = findings.experiments || [];
    const apexList = allExps
      .filter((e) => e.system !== 'legacy')
      .map((e) => ({
        kind: e.kind || e.type || 'user',
        name: e.id,
        defaultConfig: e.defaultConfig || null,
        variations: e.variations || null,
        label: e.label || null,
        system: e.system || 'apex',
      }));
    const legacyList = allExps
      .filter((e) => e.system === 'legacy' || (e.treatments && e.treatments.length))
      .map((e) => ({
        kind: e.kind || e.type || 'user',
        id: e.id,
        label: e.label || null,
        defaultConfig: e.defaultConfig || null,
        treatments: e.treatments || null,
        system: 'legacy',
      }));
    await fs.writeJson(path.join(DATA, 'apex_experiments.json'), apexList, { spaces: 2 });
    await fs.writeJson(path.join(DATA, 'experiments.json'), legacyList.length ? legacyList : allExps, { spaces: 2 });
    await fs.writeJson(path.join(DATA, 'routes.json'), nextRt, { spaces: 2 });
    console.log('Snapshots', {
      apex: apexList.length,
      legacy: legacyList.length,
      routes: Object.keys(nextRt).length,
    });
  } catch (e) {
    console.warn('snapshot write', e.message);
  }'''
    if needle not in t:
        print('index: save block miss')
        return False
    t = t.replace(needle, insert, 1)
    p.write_text(t)
    print('index: patched')
    return True


if __name__ == '__main__':
    ok = patch_extract() and patch_notify() and patch_index()
    raise SystemExit(0 if ok else 1)
