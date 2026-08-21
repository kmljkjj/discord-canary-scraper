/**
 * Simple persistent logger for the scraper (console + data/logs/).
 */
const fs = require('fs-extra');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');

function stamp() {
  return new Date().toISOString();
}

function dayFile() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `scraper-${d}.log`);
}

async function writeLine(level, msg, meta) {
  const line =
    `[${stamp()}] [${level}] ${msg}` +
    (meta !== undefined ? ' ' + JSON.stringify(meta) : '') +
    '\n';
  try {
    await fs.ensureDir(LOG_DIR);
    await fs.appendFile(dayFile(), line);
  } catch (e) {
    // never crash the job for logging
    console.warn('log write failed', e.message);
  }
  const out = level === 'ERROR' ? console.error : console.log;
  out(`[${level}] ${msg}`, meta !== undefined ? meta : '');
}

const log = {
  info: (msg, meta) => writeLine('INFO', msg, meta),
  warn: (msg, meta) => writeLine('WARN', msg, meta),
  error: (msg, meta) => writeLine('ERROR', msg, meta),
  debug: (msg, meta) => writeLine('DEBUG', msg, meta),
};

module.exports = { log, LOG_DIR };
