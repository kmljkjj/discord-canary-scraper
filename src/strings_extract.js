/**
 * Wumpus / discrapper-canary style Discord i18n strings.
 *
 * Reference:
 *   https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json
 *
 * Real examples:
 *   "ihBfyA": "Add to Favorites"
 *   "ZEs/pI": "Add reaction"
 *   "owG+AO": "..."
 *
 * NOT strings:
 *   "173309": "c8fb0200b419bf54"
 *   "Number": "598883"
 */

const WUMPUS_STRINGS_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json';

function unescapeValue(raw) {
  try {
    return JSON.parse('"' + String(raw).replace(/\\/g, '\\').replace(/"/g, '\\"') + '"');
  } catch {
    /* fall through */
  }
  return String(raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Wumpus keys are 6 chars base64 alphabet, but almost never pure digits.
 * Require at least one letter.
 */
function isValidKey(key) {
  if (typeof key !== 'string') return false;
  if (!/^[A-Za-z0-9+/]{6}$/.test(key)) return false;
  // pure digits like 173309 / 598883 — not i18n hashes in practice for UI map
  if (/^[0-9]{6}$/.test(key)) return false;
  // must contain a letter (Wumpus samples: ihBfyA, ZEs/pI, owG+AO)
  if (!/[A-Za-z]/.test(key)) return false;
  // skip obvious code identifiers mistaken as keys
  if (/^(number|Number|string|String|object|Object|length|Length)$/.test(key)) return false;
  return true;
}

/**
 * Values must look like real UI copy, not hashes / build ids / code.
 */
function isValidValue(val) {
  if (typeof val !== 'string') return false;
  const v = val.trim();
  if (v.length < 1 || v.length > 400) return false;

  // Build numbers / pure numbers
  if (/^[0-9]{4,}$/.test(v)) return false;

  // Hex hashes (8–64 hex chars)
  if (/^[a-f0-9]{8,64}$/i.test(v)) return false;

  // webpack / code junk
  if (/discord_web[-_]/i.test(v)) return false;
  if (/^function\b|=>\s*\{|webpackJsonp|__webpack|use strict/i.test(v)) return false;
  if (/^\/assets\//i.test(v)) return false;
  if (/^https?:\/\/cdn\.discordapp\.com\//i.test(v)) return false;

  // Must contain at least 2 letters (any alphabet) — real UI text
  const letters = v.match(/[A-Za-zÀ-ÿ\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/g);
  if (!letters || letters.length < 2) return false;

  // Reject values that are mostly hex-like tokens
  const hexRatio = (v.match(/[a-f0-9]/gi) || []).length / v.length;
  if (v.length >= 12 && hexRatio > 0.85 && !/\s/.test(v)) return false;

  return true;
}

function sanitizeStringsMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (isValidKey(k) && isValidValue(String(v))) out[k] = String(v);
  }
  return out;
}

/**
 * Extract only quoted object-style i18n entries (closest to Wumpus output).
 * Avoid unquoted dense key:value noise that pulls hashes.
 */
function extractStringsFromContent(content, outMap = new Map()) {
  if (!content || typeof content !== 'string') return outMap;

  // "AbC12+": "Some UI text"   or  'ZEs/pI': 'Add reaction'
  const reQuoted =
    /["']([A-Za-z0-9+/]{6})["']\s*:\s*["']((?:[^"'\\]|\\.){1,400})["']/g;
  let m;
  while ((m = reQuoted.exec(content)) !== null) {
    const key = m[1];
    const val = unescapeValue(m[2]);
    if (isValidKey(key) && isValidValue(val)) outMap.set(key, val);
  }

  // JSON.parse("{ \"ihBfyA\": \"Add to Favorites\", ... }")
  const reJsonParse = /JSON\.parse\(\s*["'](\{[\s\S]{50,400000}?\})["']\s*\)/g;
  while ((m = reJsonParse.exec(content)) !== null) {
    try {
      let inner = m[1];
      // content is inside a JS string — unescape common sequences
      inner = inner
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
      const obj = JSON.parse(inner);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (isValidKey(k) && isValidValue(String(v))) outMap.set(k, String(v));
        }
      }
    } catch {
      /* ignore */
    }
  }

  return outMap;
}

function diffStrings(prev, curr) {
  const added = {};
  const removed = {};
  const modified = {};
  prev = sanitizeStringsMap(prev);
  curr = sanitizeStringsMap(curr);
  for (const [k, v] of Object.entries(curr)) {
    if (!(k in prev)) added[k] = v;
    else if (prev[k] !== v) modified[k] = v;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in curr)) removed[k] = v;
  }
  return { added, removed, modified };
}

function singleLine(v) {
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 140);
}

/**
 * Embed format close to user / Wumpus channel style
 */
function formatStringsEmbed(stringDiff, buildNumber, limit = 40) {
  const lines = [];
  for (const [k, v] of Object.entries(stringDiff.added || {})) {
    lines.push(`+ ${k}: ${singleLine(v)}`);
  }
  for (const [k, v] of Object.entries(stringDiff.removed || {})) {
    lines.push(`- ${k}: ${singleLine(v)}`);
  }
  for (const [k, v] of Object.entries(stringDiff.modified || {})) {
    lines.push(`~ ${k}: ${singleLine(v)}`);
  }

  const a = Object.keys(stringDiff.added || {}).length;
  const r = Object.keys(stringDiff.removed || {}).length;
  const m = Object.keys(stringDiff.modified || {}).length;

  if (a + r + m === 0) return null;

  const header = `Added · removed · modified`;
  const body = lines.slice(0, limit).join('\n');
  const more = lines.length > limit ? `\n… +${lines.length - limit} more` : '';

  return {
    title: 'Strings',
    description:
      header +
      '\n```\n' +
      body +
      more +
      '\n```\n**Build Id** — ' +
      buildNumber,
    color: 0x57f287,
    timestamp: new Date().toISOString(),
  };
}

async function fetchWumpusStrings(fetchImpl) {
  try {
    const res = await fetchImpl(WUMPUS_STRINGS_URL, {
      headers: { 'User-Agent': 'canary-scraper', Accept: 'application/json' },
      timeout: 60000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return sanitizeStringsMap(data);
  } catch {
    return null;
  }
}

module.exports = {
  extractStringsFromContent,
  diffStrings,
  formatStringsEmbed,
  fetchWumpusStrings,
  sanitizeStringsMap,
  isValidKey,
  isValidValue,
  WUMPUS_STRINGS_URL,
};
