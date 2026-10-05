#!/usr/bin/env node
/**
 * Vérifie la syntaxe de TOUS les fichiers JS et Python du projet.
 * JS : node --check
 * Python : py_compile (si python3 disponible)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'test', 'docs', 'scripts'];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push({ path: p, lang: 'js' });
    else if (ent.name.endsWith('.py')) out.push({ path: p, lang: 'py' });
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d), [])).sort();
let failed = 0;
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

for (const f of files) {
  let r;
  if (f.lang === 'js') {
    r = spawnSync(process.execPath, ['--check', f.path], { encoding: 'utf8' });
  } else if (f.lang === 'py' && hasPython) {
    r = spawnSync('python3', ['-m', 'py_compile', f.path], { encoding: 'utf8' });
  } else {
    continue;
  }
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, f.path)}\n${r.stderr || r.stdout}`);
  }
}
console.log(`syntax check: ${files.length - failed}/${files.length} OK`);
process.exit(failed ? 1 : 0);
