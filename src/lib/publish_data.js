/**
 * Atomic multi-file publication for data/.
 *
 * Model:
 *  1) Write a complete generation under data/.generations/<runId>/
 *  2) Validate every JSON file + shared runId/buildNumber
 *  3) Promote each file to fixed paths via atomic rename
 *  4) Write data/generation.json pointer LAST
 *
 * On failure before/during staging validation: published files stay untouched.
 * On failure mid-promote: process exits non-zero so CI does not commit.
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic, writeFileAtomic } = require('./atomic');

const GENERATIONS_DIR = '.generations';
const STAGING_DIR = '.publish_staging';
const POINTER_FILE = 'generation.json';
const KEEP_GENERATIONS = Number(process.env.DATA_KEEP_GENERATIONS || 5);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

async function publishDataGeneration(dataDir, opts) {
  const runId = String(opts.runId || '').trim();
  const buildNumber = String(opts.buildNumber || '').trim();
  const files = opts.files || {};

  if (!runId) throw new Error('publishDataGeneration: missing runId');
  if (!buildNumber || buildNumber === 'unknown') {
    throw new Error('publishDataGeneration: missing or unknown buildNumber');
  }
  const names = Object.keys(files);
  if (!names.length) throw new Error('publishDataGeneration: no files');

  await fs.ensureDir(dataDir);

  const stagingRoot = path.join(dataDir, STAGING_DIR);
  const staging = path.join(stagingRoot, runId);
  await fs.emptyDir(staging);

  const checksums = {};
  const written = [];

  for (const rel of names.sort()) {
    if (rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error('publishDataGeneration: invalid path ' + rel);
    }
    const value = files[rel];
    const target = path.join(staging, rel);
    await fs.ensureDir(path.dirname(target));
    let outBuf = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    if (
      (rel === 'strings.json' ||
        rel === 'routes.json' ||
        rel === 'last_extract_strings.json') &&
      outBuf.length > 2_000_000
    ) {
      outBuf = Buffer.from(JSON.stringify(value), 'utf8');
    }
    await writeFileAtomic(target, outBuf);
    checksums[rel] = sha256(outBuf);
    written.push(rel);
  }

  for (const rel of written) {
    const target = path.join(staging, rel);
    const raw = await fs.readFile(target);
    if (sha256(raw) !== checksums[rel]) {
      throw new Error(
        'publishDataGeneration: checksum mismatch after write ' + rel,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new Error(
        'publishDataGeneration: invalid JSON ' + rel + ': ' + e.message,
      );
    }
    if (isPlainObject(parsed)) {
      if (parsed.runId != null && String(parsed.runId) !== runId) {
        throw new Error(
          `publishDataGeneration: runId mismatch in ${rel}: ${parsed.runId} !== ${runId}`,
        );
      }
      if (
        parsed.buildNumber != null &&
        String(parsed.buildNumber) !== buildNumber
      ) {
        throw new Error(
          `publishDataGeneration: buildNumber mismatch in ${rel}: ${parsed.buildNumber} !== ${buildNumber}`,
        );
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    buildNumber,
    publishedAt: null,
    stagedAt: new Date().toISOString(),
    files: written.map((rel) => ({
      path: rel,
      sha256: checksums[rel],
    })),
  };
  await writeJsonAtomic(path.join(staging, '_manifest.json'), manifest);

  const genRoot = path.join(dataDir, GENERATIONS_DIR);
  const generationDir = path.join(genRoot, runId);
  await fs.emptyDir(generationDir);
  await fs.copy(staging, generationDir);

  const promoted = [];
  try {
    for (const rel of written) {
      const from = path.join(generationDir, rel);
      const to = path.join(dataDir, rel);
      await fs.ensureDir(path.dirname(to));
      const tmp = `${to}.promote-${process.pid}-${Date.now()}`;
      await fs.copy(from, tmp);
      await fs.move(tmp, to, { overwrite: true });
      promoted.push(rel);
    }
  } catch (e) {
    throw new Error(
      `publishDataGeneration: promote failed after [${promoted.join(', ')}]: ${e.message}`,
    );
  }

  const pointer = {
    schemaVersion: 1,
    runId,
    buildNumber,
    publishedAt: new Date().toISOString(),
    files: written.slice(),
    generationDir: path.join(GENERATIONS_DIR, runId),
  };
  await writeJsonAtomic(path.join(dataDir, POINTER_FILE), pointer);

  manifest.publishedAt = pointer.publishedAt;
  await writeJsonAtomic(path.join(generationDir, '_manifest.json'), manifest);

  try {
    await fs.remove(staging);
  } catch {}
  try {
    await pruneGenerations(genRoot, KEEP_GENERATIONS, runId);
  } catch (e) {
    console.warn('pruneGenerations', e.message);
  }

  console.log('DATA_PUBLISH ok', {
    runId,
    buildNumber,
    files: written.length,
  });

  return { runId, buildNumber, files: written, generationDir };
}

async function pruneGenerations(genRoot, keep, currentRunId) {
  if (!(await fs.pathExists(genRoot))) return;
  const entries = await fs.readdir(genRoot);
  const dirs = [];
  for (const name of entries) {
    const full = path.join(genRoot, name);
    const st = await fs.stat(full);
    if (st.isDirectory()) {
      dirs.push({ name, full, mtime: st.mtimeMs });
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  for (const d of dirs) {
    if (d.name === currentRunId || kept < keep) {
      kept++;
      continue;
    }
    await fs.remove(d.full);
  }
}

async function readCurrentGeneration(dataDir) {
  try {
    const p = path.join(dataDir, POINTER_FILE);
    if (!(await fs.pathExists(p))) return null;
    return await fs.readJson(p);
  } catch {
    return null;
  }
}

module.exports = {
  publishDataGeneration,
  readCurrentGeneration,
  GENERATIONS_DIR,
  POINTER_FILE,
  STAGING_DIR,
};
