'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { publishFlatChunks, chunkIdFromName, swapDirs } = require('../src/lib/flat_chunks');

test('chunkIdFromName: extrait le chunkId du nom d\'asset', () => {
  assert.strictEqual(chunkIdFromName('954035.abc123.js'), '954035');
  assert.strictEqual(chunkIdFromName('0.js'), '0');
  assert.strictEqual(chunkIdFromName('123.def456.js'), '123');
  assert.strictEqual(chunkIdFromName('web.abc123.js'), '-1');
});

test('chunkIdFromName: gère les noms sans hash', () => {
  assert.strictEqual(chunkIdFromName('42.js'), '42');
});

test('chunkIdFromName: retourne le premier segment pour les noms non numériques', () => {
  assert.strictEqual(chunkIdFromName('vendor.abc.js'), 'vendor');
});

test('chunkIdFromName: gère null/undefined', () => {
  assert.strictEqual(chunkIdFromName(null), null);
  assert.strictEqual(chunkIdFromName(undefined), null);
  assert.strictEqual(chunkIdFromName(''), null);
});

test('publishFlatChunks: skip si désactivé', async () => {
  const old = process.env.FLAT_CHUNKS;
  process.env.FLAT_CHUNKS = '0';
  try {
    const result = await publishFlatChunks({
      assetsDir: '/tmp',
      repoRoot: '/tmp',
      build: { buildNumber: '123', versionHash: 'abc' },
    });
    assert.strictEqual(result, null);
  } finally {
    if (old === undefined) delete process.env.FLAT_CHUNKS;
    else process.env.FLAT_CHUNKS = old;
  }
});

test('publishFlatChunks: skip sans build number', async () => {
  const result = await publishFlatChunks({
    assetsDir: '/tmp',
    repoRoot: '/tmp',
    build: { buildNumber: 'unknown' },
  });
  assert.strictEqual(result, null);
});

test('publishFlatChunks: publie les chunks et css', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flat-chunks-'));
  const tmpAssets = path.join(tmpRoot, 'assets');
  await fs.ensureDir(tmpAssets);

  // Créer des faux assets
  await fs.writeFile(path.join(tmpAssets, '954035.abc123.js'), 'console.log("chunk1");');
  await fs.writeFile(path.join(tmpAssets, '0.def456.js'), 'console.log("chunk2");');
  await fs.writeFile(path.join(tmpAssets, 'web.hash.js'), 'console.log("web bundle");');
  await fs.writeFile(path.join(tmpAssets, '001ccfa2.css'), 'body{color:red}');

  const manifest = await publishFlatChunks({
    assetsDir: tmpAssets,
    repoRoot: tmpRoot,
    build: { buildNumber: '630765', versionHash: 'abc123', releaseChannel: 'canary' },
  });

  assert.ok(manifest, 'manifest should not be null');
  assert.strictEqual(manifest.chunkCount, 3); // 954035, 0, web(-1)
  assert.strictEqual(manifest.cssCount, 1);
  assert.strictEqual(manifest.buildNumber, '630765');

  // Vérifier que les fichiers existent
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'chunks', '954035.js')));
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'chunks', '0.js')));
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'chunks', '-1.js')));
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'css', '001ccfa2.css')));
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'info.json')));
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'data', 'chunk_manifest.json')));

  // Vérifier info.json
  const info = await fs.readJson(path.join(tmpRoot, 'info.json'));
  assert.strictEqual(info.buildNumber, '630765');
  assert.strictEqual(info.versionHash, 'abc123');

  // Nettoyer
  await fs.remove(tmpRoot);
});

test('publishFlatChunks: skip les fichiers HTML corrompus', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flat-chunks-'));
  const tmpAssets = path.join(tmpRoot, 'assets');
  await fs.ensureDir(tmpAssets);

  // Fichier HTML au lieu de JS
  await fs.writeFile(path.join(tmpAssets, '999.html.js'), '<!DOCTYPE html><html></html>');
  // Fichier JS valide
  await fs.writeFile(path.join(tmpAssets, '42.abc.js'), 'console.log("ok");');

  const manifest = await publishFlatChunks({
    assetsDir: tmpAssets,
    repoRoot: tmpRoot,
    build: { buildNumber: '100', versionHash: null },
  });

  assert.strictEqual(manifest.chunkCount, 1); // seulement 42.abc.js
  assert.ok(await fs.pathExists(path.join(tmpRoot, 'chunks', '42.js')));
  assert.ok(!await fs.pathExists(path.join(tmpRoot, 'chunks', '999.js')));

  await fs.remove(tmpRoot);
});

test('swapDirs: remplace le contenu atomiquement', async () => {
  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'swap-'));
  const target = path.join(tmpParent, 'target');
  const tmp = path.join(tmpParent, 'tmp');

  // Préparer target avec ancien contenu
  await fs.ensureDir(target);
  await fs.writeFile(path.join(target, 'old.js'), 'old');

  // Préparer tmp avec nouveau contenu
  await fs.ensureDir(tmp);
  await fs.writeFile(path.join(tmp, 'new.js'), 'new');

  await swapDirs(target, tmp);

  // Vérifier que target contient maintenant le nouveau contenu
  assert.ok(await fs.pathExists(path.join(target, 'new.js')));
  assert.ok(!await fs.pathExists(path.join(target, 'old.js')));

  await fs.remove(tmpParent);
});
