/**
 * Shared utility functions used across all scraper scripts.
 *
 * Centralises: sleep, redactSecrets, loadTokens, common constants.
 * Prevents drift between scripts that previously each defined their own copy.
 */

/** Default User-Agent for all HTTP requests to Discord. */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Default bot name shown on Discord webhook messages. */
const DEFAULT_BOT_NAME = process.env.ORBIT_BOT_NAME || 'Datamining';

/** Default avatar URL for webhook messages. */
const DEFAULT_AVATAR_URL =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media/datamining-avatar.png';

/** Default avatar for mobile/blog/quest scripts. */
const DEFAULT_MOBILE_AVATAR =
  process.env.ORBIT_BOT_AVATAR ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

/**
 * Promise-based sleep.
 * @param {number} ms - milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Redact Discord tokens and JWTs from error messages before logging.
 * @param {string|Error} msg - message or error to redact
 * @returns {string} redacted message
 */
function redactSecrets(msg) {
  return String(msg || '')
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{10,}/g, '[REDACTED_JWT]')
    .replace(/mfa\.[\w-]{20,}/gi, '[REDACTED_TOKEN]')
    .replace(/Bot\s+[\w.-]{20,}/gi, 'Bot [REDACTED]');
}

/**
 * Load Discord user tokens from environment variables.
 * Checks DISCORD_USER_TOKENS (comma/newline/semicolon separated),
 * DISCORD_USER_TOKEN_1..10, DISCORD_USER_TOKEN, DISCORD_TOKEN.
 * @param {number} [maxIndex=10] - max token index to check
 * @returns {string[]} array of unique non-empty tokens
 */
function loadTokens(maxIndex = 10) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const part of String(process.env.DISCORD_USER_TOKENS || '').split(/[,;\n]+/)) push(part);
  for (let i = 1; i <= maxIndex; i++) {
    push(process.env['DISCORD_USER_TOKEN_' + i]);
    push(process.env['DISCORD_USER_TOKENS' + i]);
  }
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  return out;
}

/**
 * Get the first available Discord user token from environment.
 * Shorthand for loadTokens()[0].
 * @returns {string|null}
 */
function firstToken() {
  const tokens = loadTokens();
  return tokens.length > 0 ? tokens[0] : null;
}

/**
 * Keep the `max` most recently inserted ids of a Set / array (insertion order).
 * Replaces the former `[...set].sort().slice(-max)` pattern, which evicted ids
 * by lexicographic order (hashes → random eviction) and caused re-notifications.
 * @param {Iterable<string>} ids
 * @param {number} max
 * @returns {string[]}
 */
function trimRecent(ids, max) {
  const arr = [...new Set(Array.from(ids || [], String))];
  return max > 0 && arr.length > max ? arr.slice(arr.length - max) : arr;
}

/**
 * ISO string for a date-ish value, or `fallback` when missing/unparseable.
 * `new Date(bad).toISOString()` throws RangeError and used to abort whole runs
 * on a single malformed feed date.
 */
function safeIso(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}

module.exports = {
  safeIso,
  trimRecent,
  sleep,
  redactSecrets,
  loadTokens,
  firstToken,
  DEFAULT_UA,
  DEFAULT_BOT_NAME,
  DEFAULT_AVATAR_URL,
  DEFAULT_MOBILE_AVATAR,
};
