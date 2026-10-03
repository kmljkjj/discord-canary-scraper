'use strict';

/**
 * Hygiène du dépôt : empêche le retour des résidus de patchs ponctuels,
 * des workflows qui réécrivent le code source, et des incohérences README/package.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean)
      // ignore les fichiers supprimés du disque mais pas encore commités
      .filter((f) => fs.existsSync(path.join(ROOT, f)));
  } catch {
    return null; // pas un checkout git (archive) : test ignoré
  }
}

const RESIDUE = [
  /(^|\/)__pycache__\//,
  /\.py[cod]$/,
  /\.b64(\.|$)/,
  /^\.github\/payloads\//,
  /\.py\.a$/,
  /(^|\/)\.apply-/,
];

test('aucun résidu de patch (base64, .pyc, .py.a, .apply-*) n’est versionné', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('pas de dépôt git');
  const bad = files.filter((f) => RESIDUE.some((re) => re.test(f)));
  assert.deepEqual(bad, []);
});

test('.gitignore exclut le bytecode Python et les résidus de patchs', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  for (const pat of ['__pycache__/', '*.py[cod]', '.github/payloads/', '*.b64.*', '*.py.a', '.apply-*']) {
    assert.ok(lines.includes(pat), `.gitignore doit contenir ${pat}`);
  }
});

const WF_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

test('aucun workflow de patch ponctuel (apply-/patch-/fix-/heal-/restore-)', () => {
  const bad = workflows.filter((f) => /^(apply|patch|fix|heal|restore)-/.test(f));
  assert.deepEqual(bad, []);
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^apply_.*\.py$/.test(f));
  assert.deepEqual(scripts, []);
});

test('aucun workflow n’utilise « A && B || C » (SC2015, casse actionlint en CI)', () => {
  const offenders = [];
  for (const f of workflows) {
    read(path.join('.github', 'workflows', f)).split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*#.*$/, '');
      // expressions GitHub (`if:`, `${{ }}`) : pas du shell
      if (/^\s*-?\s*if:/.test(code) || /\$\{\{/.test(code)) return;
      // comme shellcheck : B = echo/printf/true/: ne peut pas échouer → toléré
      // B = tout ce qui est entre le premier && et le || (peut contenir d'autres &&)
      const m = code.match(/&&\s*(.+?)\s*\|\|/);
      if (m && (/&&/.test(m[1]) || !/^(echo|printf|true|:)(\s|$)/.test(m[1]))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('la version de package.json correspond à la dernière version du README', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const versions = [...read('README.md').matchAll(/^###\s+v(\d+\.\d+(?:\.\d+)?)/gm)].map((m) => m[1]);
  assert.ok(versions.length > 0, 'aucune section ### vX.Y dans le README');
  const norm = (v) => (v.split('.').length === 2 ? `${v}.0` : v);
  const cmp = (a, b) => {
    const [x, y] = [norm(a).split('.').map(Number), norm(b).split('.').map(Number)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const latest = norm(versions.sort(cmp).at(-1));
  assert.equal(pkg.version, latest);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('le GITHUB_REPO du README correspond au dépôt par défaut des scripts', () => {
  const def = read('scripts/_canary_common.py').match(/^DEFAULT_REPO\s*=\s*"([^"]+)"/m);
  assert.ok(def, 'DEFAULT_REPO introuvable');
  const cog = read('cogs/canary_trigger.py').match(/GITHUB_REPO"\)\s*or\s*"([^"]+)"/);
  assert.ok(cog, 'dépôt par défaut du cog introuvable');
  assert.equal(cog[1], def[1]);
  const inReadme = [...read('README.md').matchAll(/GITHUB_REPO=(\S+)/g)].map((m) => m[1]);
  assert.ok(inReadme.length > 0);
  for (const r of inReadme) assert.equal(r, def[1]);
});
