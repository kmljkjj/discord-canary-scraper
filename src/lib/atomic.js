/** Atomic JSON / file writes */
const fs = require('fs-extra');
const path = require('path');

async function writeJsonAtomic(file, value, spaces = 2) {
  const dir = path.dirname(file);
  await fs.ensureDir(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (spaces == null) {
      await fs.writeJson(tmp, value);
    } else {
      await fs.writeJson(tmp, value, { spaces });
    }
    await fs.move(tmp, file, { overwrite: true });
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {}
    throw e;
  }
}

async function writeFileAtomic(file, buf) {
  const dir = path.dirname(file);
  await fs.ensureDir(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, buf);
    await fs.move(tmp, file, { overwrite: true });
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {}
    throw e;
  }
}

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

module.exports = { writeJsonAtomic, writeFileAtomic, envInt };
