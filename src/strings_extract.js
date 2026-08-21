/**
 * Wumpus / discrapper-canary style Discord i18n strings extraction.
 *
 * Reference format:
 *   https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json
 * Keys: exactly 6 chars from [A-Za-z0-9+/]
 * Values: UI message strings
 */

const WUMPUS_STRINGS_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/strings.json';

function unescapeValue(raw) {
  let s = raw;
  try {
    // Prefer JSON string rules
    s = JSON.parse('"' + raw.replace(/\\/g, '\\').replace(/"/g, '\\"') + '"');
    return s;
  } catch {
    /* fall through */
  }
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9+/]{6}$/.test(key);
}

function isValidValue(val) {
  if (typeof val !== 'string') return false;
  const v = val.trim();
  if (v.length < 1 || v.length > 800) return false;
  // Junk filters (same spirit as dataminers)
  if (/discord_web[-_]/i.test(v)) return false;
  if (/^function\b|=>\s*\{|webpackJsonp|__webpack/i.test(v)) return false;
  if (/^[a-f0-9]{20,}$/i.test(v)) return false;
  if (/^\/assets\//i.test(v)) return false;
  // Must look like human / UI text (letters or common punctuation messages)
  if (!/[A-Za-zÀ-ÿ\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(v) && v.length > 12) {
    // allow pure symbols short UI like "…" "—"
    if (!/[\p{L}]/u.test(v)) return false;
  }
  return true;
}

/**
 * Extract from arbitrary JS chunk content into Map key -> value
 */
function extractStringsFromContent(content, outMap = new Map()) {
  if (!content || typeof content !== 'string') return outMap;

  // 1) Classic object entries: "Ab12+/" : "Some text"
  const reQuoted =
    /["']([A-Za-z0-9+/]{6})["']\s*:\s*["']((?:[^"'\\]|\\.){1,800})["']/g;
  let m;
  while ((m = reQuoted.exec(content)) !== null) {
    const key = m[1];
    const val = unescapeValue(m[2]);
    if (isValidKey(key) && isValidValue(val)) outMap.set(key, val);
  }

  // 2) JSON.parse("{...}") big locale blobs (common in webpack)
  const reJsonParse = /JSON\.parse\(\s*["'](\{[\s\S]{20,500000}?\})["']\s*\)/g;
  while ((m = reJsonParse.exec(content)) !== null) {
    try {
      const inner = m[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\');
      const obj = JSON.parse(inner);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (isValidKey(k) && isValidValue(String(v))) outMap.set(k, String(v));
        }
      }
    } catch {
      /* ignore bad blobs */
    }
  }

  // 3) Dense minified: {Ab12+f:"Text",Cd34/g:"More"} without spaces
  const reDense =
    /([A-Za-z0-9+/]{6}):\"((?:[^\"\\]|\\.){1,800})\"/g;
  while ((m = reDense.exec(content)) !== null) {
    const key = m[1];
    const val = unescapeValue(m[2]);
    if (isValidKey(key) && isValidValue(val)) outMap.set(key, val);
  }

  return outMap;
}

function diffStrings(prev, curr) {
  const added = {};
  const removed = {};
  const modified = {};
  prev = prev || {};
  curr = curr || {};
  for (const [k, v] of Object.entries(curr)) {
    if (!(k in prev)) added[k] = v;
    else if (prev[k] !== v) modified[k] = v;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in curr)) removed[k] = v;
  }
  return { added, removed, modified };
}

/**
 * Format like Wumpus / user examples for Discord embeds
 */
function formatStringsEmbed(stringDiff, buildNumber, limit = 35) {
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

  const header = `**Strings**\nAdded \`${a}\` · Removed \`${r}\` · Modified \`${m}\``;
  const body = lines.slice(0, limit).join('\n');
  const more =
    lines.length > limit ? `\n… +${lines.length - limit} more` : '';

  return {
    title: 'Strings',
    description:
      header +
      '\n```\n' +
      (body || '(no string changes)') +
      more +
      '\n```\n**Build Id** — ' +
      buildNumber,
    color: 0x57f287,
    timestamp: new Date().toISOString(),
  };
}

function singleLine(v) {
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchWumpusStrings(fetchImpl) {
  try {
    const res = await fetchImpl(WUMPUS_STRINGS_URL, {
      headers: { 'User-Agent': 'canary-scraper', Accept: 'application/json' },
      timeout: 60000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (isValidKey(k) && typeof v === 'string' && isValidValue(v)) cleaned[k] = v;
    }
    return cleaned;
  } catch {
    return null;
  }
}

module.exports = {
  extractStringsFromContent,
  diffStrings,
  formatStringsEmbed,
  fetchWumpusStrings,
  isValidKey,
  isValidValue,
  WUMPUS_STRINGS_URL,
};
