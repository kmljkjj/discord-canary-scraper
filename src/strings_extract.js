/**
 * Wumpus-aligned Discord i18n string extraction.
 * Keys: exactly 6 chars (base64-ish) OR kept from Wumpus seed.
 */

const WUMPUS_STRINGS_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/refs/heads/main/data/strings.json';

function isValidKey(k) {
  if (typeof k !== 'string') return false;
  // Discord hashed i18n keys are typically 6 chars
  if (k.length === 6 && /[A-Za-z]/.test(k) && /^[A-Za-z0-9+/_-]+$/.test(k)) return true;
  return false;
}

function isValidValue(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || s.length > 400) return false;
  if (/^[a-f0-9]{16,}$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^discord_web-/i.test(s)) return false;
  if (/^release:/i.test(s)) return false;
  const letters = s.match(/[A-Za-zÀ-ÿ]/g);
  if (!letters || letters.length < 2) return false;
  return true;
}

function sanitizeStringsMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!isValidKey(k)) continue;
    if (!isValidValue(v)) continue;
    out[k] = String(v);
  }
  return out;
}

function extractStringsFromContent(content, intoMap) {
  const map = intoMap || new Map();
  // "XXXXXX": "value"
  const re = /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"']{2,400})["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const k = m[1];
    const v = m[2];
    if (!isValidKey(k) || !isValidValue(v)) continue;
    if (!map.has(k)) map.set(k, v);
  }
  return map;
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
 * Strings embed — channel style:
 * Strings
 * Added · removed · modified
 * + KEY: value
 * Build Id — N
 */
function formatStringsEmbed(stringDiff, buildNumber, limit = 40) {
  const lines = [];
  for (const [k, v] of Object.entries(stringDiff.added || {})) {
    lines.push('+ ' + k + ': ' + singleLine(v));
  }
  for (const [k, v] of Object.entries(stringDiff.removed || {})) {
    lines.push('- ' + k + ': ' + singleLine(v));
  }
  for (const [k, v] of Object.entries(stringDiff.modified || {})) {
    lines.push('~ ' + k + ': ' + singleLine(v));
  }

  const a = Object.keys(stringDiff.added || {}).length;
  const r = Object.keys(stringDiff.removed || {}).length;
  const m = Object.keys(stringDiff.modified || {}).length;
  if (a + r + m === 0) return null;

  const header = 'Added (' + a + ') · Removed (' + r + ') · Modified (' + m + ')';
  const body = lines.slice(0, limit).join('\n');
  const more = lines.length > limit ? '\n… +' + (lines.length - limit) + ' more' : '';

  return {
    title: 'Strings',
    description:
      header + '\n```\n' + body + more + '\n```\n**Build Id** — ' + buildNumber,
    color: 0x57f287,
    timestamp: new Date().toISOString(),
    footer: { text: 'Canary · strings' },
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
};
