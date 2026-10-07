#!/usr/bin/env python3
from pathlib import Path
import shutil

ROOT = Path('.')
src = ROOT / 'scripts' / '_dismissible_content_src.js'
lib = ROOT / 'src' / 'lib' / 'dismissible_content.js'
if not src.exists():
    raise SystemExit('missing source')
lib.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(src, lib)
print('copied module', lib.stat().st_size)

ep = ROOT / 'src' / 'lib' / 'extract.js'
et = ep.read_text()
if 'extractDismissibleContent' not in et:
    needle = "const { inferType } = require('./infer_type');"
    if needle in et:
        et = et.replace(needle, needle + "\nconst { extractDismissibleContent } = require('./dismissible_content');", 1)
    else:
        et = "const { extractDismissibleContent } = require('./dismissible_content');\n" + et

    old = "  const strings = {};\n  const routes = {};\n  const expSet = new Map();"
    new = "  const strings = {};\n  const routes = {};\n  const expSet = new Map();\n  const dismissibleContent = {};"
    if old not in et:
        raise SystemExit('init not found')
    et = et.replace(old, new, 1)

    old = "      await extractCoreParallel(webContent, { routes, expSet, strings });"
    if old in et:
        et = et.replace(old, old + "\n      extractDismissibleContent(webContent, dismissibleContent);", 1)

    old = "      if (item.size < 500_000) extractStrings(item.content, strings);"
    if old in et:
        et = et.replace(old, old + "\n      extractDismissibleContent(item.content, dismissibleContent);", 1)

    old = """  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
    coverage,
  });"""
    new = """  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    dismissible: Object.keys(dismissibleContent).length,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
    coverage,
  });"""
    if old in et:
        et = et.replace(old, new, 1)

    old = """  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
    downloadStats: getDownloadStats(),
    coverage,
  };"""
    new = """  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    dismissibleContent,
    css: cssInventory,
    downloadStats: getDownloadStats(),
    coverage,
  };"""
    if old not in et:
        raise SystemExit('return not found')
    et = et.replace(old, new, 1)

    old = "  extractVariationBlock,\n  parseTopLevelBlocks,\n};"
    if old in et:
        et = et.replace(old, "  extractVariationBlock,\n  parseTopLevelBlocks,\n  extractDismissibleContent,\n};", 1)
    ep.write_text(et)
    print('extract.js patched')
else:
    print('extract.js already')

ip = ROOT / 'src' / 'index.js'
it = ip.read_text()
if 'processDismissibleContent' not in it:
    old = "const { notifyUrgent, notifyNormal } = require('./lib/notify');"
    if old in it:
        it = it.replace(old, old + "\nconst { processDismissibleContent } = require('./lib/dismissible_content');", 1)
    else:
        old = "const { analyzeAssets } = require('./lib/extract');"
        it = it.replace(old, old + "\nconst { processDismissibleContent } = require('./lib/dismissible_content');", 1)

    block = """
  // --- Dismissible Content enum (added / removed) ---
  try {
    const dismissible = findings.dismissibleContent || {};
    const dcCount = Object.keys(dismissible).length;
    const isDcSeed = !(await fs.pathExists(path.join(DATA, 'dismissible_content.json')));
    await processDismissibleContent({
      dataDir: DATA,
      current: dismissible,
      buildNumber: build.buildNumber || build.number || null,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL || null,
      isSeed: isDcSeed || isCatchUp,
    });
    console.log('Dismissible Content done', dcCount);
  } catch (e) {
    console.warn('Dismissible Content failed:', String(e.message || e).slice(0, 160));
  }

"""
    if 'Notify done' in it:
        idx = it.find('Notify done')
        line_end = it.find('\n', idx)
        it = it[: line_end + 1] + block + it[line_end + 1 :]
        print('index.js patched')
    else:
        raise SystemExit('Notify done not found')
    ip.write_text(it)
else:
    print('index.js already')

sp = ROOT / '.github' / 'workflows' / 'scrape.yml'
if sp.exists():
    st = sp.read_text()
    if 'dismissible_content.json' not in st:
        old = '            data/routes.json \\\'
        new = '            data/routes.json \\\n            data/dismissible_content.json \\\'
        if old in st:
            st = st.replace(old, new, 1)
            sp.write_text(st)
            print('scrape.yml patched')
        else:
            print('WARN scrape.yml')
    else:
        print('scrape.yml already')

print('OK')
