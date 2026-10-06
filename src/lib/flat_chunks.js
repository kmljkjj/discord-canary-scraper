/**
 * Flat chunks system — inspired by Wumpus-Central/discrapper-canary.
 *
 * Publie le build courant dans un format plat et diffable sur GitHub :
 * - chunks/{chunkId}.js  (tous les chunks webpack, hash strippé du nom)
 * - css/{hash}.css       (tous les fichiers CSS)
 * - info.json            (buildNumber, versionHash, builtAt)
 * - data/chunk_manifest.json (mapping chunk → asset original, size, sha256)
 *
 * Le contenu de chunks/ et css/ est entièrement remplacé à chaque build
 * (via un dossier temporaire puis swap atomique) pour garder un état propre.
 *
 * Env :
 *   FLAT_CHUNKS=1       enable (default 1)
 *   FLAT_CHUNKS_DIR     root for chunks/css (default: repo root)
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic, writeFileAtomic } = require('./atomic');

const ENABLED = () => process.env.FLAT_CHUNKS !== '0';

/**
 * Extrait le chunkId d'un nom d'asset Discord.
 * Les assets sont nommés `{chunkId}.{hash}.js` ou `web.{hash}.js`.
 * @param {string} name - nom du fichier asset
 * @returns {string|null} chunkId ou null si non déterminable
 */
function chunkIdFromName(name) {
  if (!name) return null;
  const base = name.replace(/\.(js|css)$/, '');
  // web.*.js → -1 (convention discrapper-canary pour le bundle principal)
  if (/^web\./i.test(name)) return '-1';
  // Pattern: {chunkId}.{hash}.js → garder seulement chunkId
  const m = base.match(/^(\d+)\./);
  if (m) return m[1];
  // Si le nom ne contient pas de point, c'est déjà un chunkId
  if (/^\d+$/.test(base)) return base;
  // Fallback: utiliser le premier segment avant le point
  const firstSeg = base.split('.')[0];
  return firstSeg || base;
}

/**
 * Calcule le sha256 d'un buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * Remplace le contenu d'un dossier par celui d'un dossier temporaire.
 * 1. Renomme old → old.bak
 * 2. Renomme tmp → target
 * 3. Supprime old.bak
 * En cas de crash, old.bak peut être restauré manuellement.
 * @param {string} targetDir
 * @param {string} tmpDir
 */
async function swapDirs(targetDir, tmpDir) {
  const parent = path.dirname(targetDir);
  await fs.ensureDir(parent);
  const bak = targetDir + '.bak.' + process.pid;
  try {
    if (await fs.pathExists(targetDir)) {
      await fs.rename(targetDir, bak);
    }
    await fs.rename(tmpDir, targetDir);
    if (await fs.pathExists(bak)) {
      await fs.remove(bak);
    }
  } catch (e) {
    // Restaurer le backup si le rename a échoué
    if (await fs.pathExists(bak)) {
      try { await fs.rename(bak, targetDir); } catch {}
    }
    throw e;
  }
}

/**
 * Publie les assets du build courant dans le format flat chunks.
 *
 * @param {object} opts
 * @param {string} opts.assetsDir - dossier contenant les assets téléchargés
 * @param {string} [opts.repoRoot] - racine du repo (défaut: 2 niveaux au-dessus de src/lib)
 * @param {object} opts.build - { buildNumber, versionHash, releaseChannel, scrapedAt }
 * @returns {Promise<object|null>} manifest ou null si désactivé
 */
async function publishFlatChunks({ assetsDir, repoRoot, build }) {
  if (!ENABLED()) {
    console.log('FLAT_CHUNKS=0 — skip');
    return null;
  }
  if (!build || !build.buildNumber || build.buildNumber === 'unknown') {
    console.warn('flat_chunks: pas de build number — skip');
    return null;
  }

  const root = repoRoot || path.join(__dirname, '..', '..');
  const chunksDir = path.join(root, 'chunks');
  const cssDir = path.join(root, 'css');
  const dataDir = path.join(root, 'data');

  // Dossiers temporaires
  const tmpChunks = path.join(root, '.tmp-chunks-' + process.pid);
  const tmpCss = path.join(root, '.tmp-css-' + process.pid);

  await fs.ensureDir(tmpChunks);
  await fs.ensureDir(tmpCss);

  const names = (await fs.readdir(assetsDir)).filter(
    (f) => f.endsWith('.js') || f.endsWith('.css'),
  );

  const manifest = {
    buildNumber: String(build.buildNumber),
    versionHash: build.versionHash || null,
    publishedAt: new Date().toISOString(),
    chunkCount: 0,
    cssCount: 0,
    totalBytes: 0,
    chunks: [],
  };

  let copied = 0;
  let skipped = 0;

  for (const name of names) {
    const src = path.join(assetsDir, name);
    let st;
    try {
      st = await fs.stat(src);
    } catch {
      continue;
    }
    if (!st.size) {
      skipped++;
      continue;
    }

    const isCss = name.endsWith('.css');
    const chunkId = chunkIdFromName(name);

    // Lire le contenu pour le sha256 et détecter les collisions
    let buf;
    try {
      buf = await fs.readFile(src);
    } catch {
      continue;
    }

    // Vérifier que ce n'est pas du HTML (corruption)
    if (name.endsWith('.js')) {
      const head = buf.slice(0, 80).toString('utf8');
      if (/^\s*<(!DOCTYPE|html|HTML)/.test(head)) {
        skipped++;
        continue;
      }
    }

    const hash = sha256(buf);
    const outName = isCss ? name : (chunkId + '.js');
    const outDir = isCss ? tmpCss : tmpChunks;
    const outPath = path.join(outDir, outName);

    // Gestion de collision: si deux assets donnent le même nom de sortie
    if (await fs.pathExists(outPath)) {
      const existing = await fs.readFile(outPath);
      if (existing.equals(buf)) {
        // Même contenu — skip
        skipped++;
        continue;
      }
      // Collision: ajouter un suffixe
      const ext = isCss ? '.css' : '.js';
      const altName = chunkId + '_' + hash.slice(0, 8) + ext;
      const altPath = path.join(outDir, altName);
      await writeFileAtomic(altPath, buf);
      copied++;
      manifest.totalBytes += st.size;
      if (isCss) {
        manifest.cssCount++;
        manifest.chunks.push({ name: altName, original: name, size: st.size, sha256: hash, kind: 'css' });
      } else {
        manifest.chunkCount++;
        manifest.chunks.push({ name: altName, original: name, size: st.size, sha256: hash, kind: 'chunk', chunkId });
      }
      continue;
    }

    await writeFileAtomic(outPath, buf);
    copied++;
    manifest.totalBytes += st.size;

    if (isCss) {
      manifest.cssCount++;
      manifest.chunks.push({ name: outName, original: name, size: st.size, sha256: hash, kind: 'css' });
    } else {
      manifest.chunkCount++;
      manifest.chunks.push({ name: outName, original: name, size: st.size, sha256: hash, kind: 'chunk', chunkId });
    }
  }

  // Trier les chunks par nom
  manifest.chunks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  manifest.totalMB = Math.round((manifest.totalBytes / 1024 / 1024) * 100) / 100;

  console.log(
    'Flat chunks:',
    manifest.chunkCount, 'chunks,',
    manifest.cssCount, 'css,',
    copied, 'copied,',
    skipped, 'skipped,',
    manifest.totalMB, 'MB',
  );

  // Swap atomique des dossiers
  try {
    await swapDirs(chunksDir, tmpChunks);
    await swapDirs(cssDir, tmpCss);
  } catch (e) {
    console.warn('flat_chunks: swap échoué:', e.message);
    // Nettoyer les dossiers temporaires
    try { await fs.remove(tmpChunks); } catch {}
    try { await fs.remove(tmpCss); } catch {}
  }

  // Écrire info.json à la racine du repo
  const info = {
    buildNumber: String(build.buildNumber),
    versionHash: build.versionHash || null,
    builtAt: Date.now(),
  };
  await writeJsonAtomic(path.join(root, 'info.json'), info, 0);

  // Écrire le manifest dans data/
  await fs.ensureDir(dataDir);
  await writeJsonAtomic(path.join(dataDir, 'chunk_manifest.json'), manifest, 2);

  return manifest;
}

module.exports = {
  publishFlatChunks,
  chunkIdFromName,
  swapDirs,
};
