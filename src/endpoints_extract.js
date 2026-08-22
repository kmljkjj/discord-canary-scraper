/**
 * Wumpus / discrapper-canary style Discord client routes.
 *
 * Reference:
 *   https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/routes.json
 *
 * Format:
 *   { "USER": "/users/:param", "USER_PROFILE": "/users/:param/profile", ... }
 *
 * Channel style (user example):
 *   Endpoints
 *   + GIFTING_...: /users/@me/gifting-...
 */

const WUMPUS_ROUTES_URL =
  'https://raw.githubusercontent.com/Wumpus-Central/discrapper-canary/main/data/routes.json';

function isValidRouteKey(key) {
  if (typeof key !== 'string') return false;
  // SCREAMING_SNAKE, at least 3 chars, mostly A-Z0-9_
  if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(key)) return false;
  // reject pure noise
  if (/^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS|TRUE|FALSE|NULL)$/.test(key)) return false;
  return true;
}

function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  // strip query-only fragments
  if (!p.startsWith('/')) return null;
  if (p.length < 2 || p.length > 300) return null;
  // Discord client uses :param placeholders (Wumpus style)
  // also accept ${...} templates → convert to :param
  p = p.replace(/\$\{[^}]+\}/g, ':param');
  // collapse multiple :param/:param from messy templates
  // keep as-is if already :id style
  if (!/^\/[a-zA-Z0-9_\-@.:/{}]+$/.test(p.replace(/:param/g, 'x'))) {
    // allow common path chars
    if (!/^\/[a-zA-Z0-9_\-@.:/]+$/.test(p)) return null;
  }
  // must look like an API path (not static asset)
  if (/\.(js|css|map|png|jpg|webp|svg|woff2?)$/i.test(p)) return null;
  if (p.startsWith('/assets/')) return null;
  return p;
}

function isValidRouteValue(val) {
  return normalizePath(val) !== null;
}

/**
 * Extract KEY → path from webpack chunk source.
 */
function extractEndpointsFromContent(content, outMap = new Map()) {
  if (!content || typeof content !== 'string') return outMap;

  // 1) KEY: "/path" or KEY: '/path'
  const reColon =
    /\b([A-Z][A-Z0-9_]{2,120})\s*:\s*["'`](\/[^"'`]{1,300})["'`]/g;
  let m;
  while ((m = reColon.exec(content)) !== null) {
    const key = m[1];
    const path = normalizePath(m[2]);
    if (isValidRouteKey(key) && path) outMap.set(key, path);
  }

  // 2) "KEY": "/path"
  const reQuoted =
    /["']([A-Z][A-Z0-9_]{2,120})["']\s*:\s*["'](\/[^"']{1,300})["']/g;
  while ((m = reQuoted.exec(content)) !== null) {
    const key = m[1];
    const path = normalizePath(m[2]);
    if (isValidRouteKey(key) && path) outMap.set(key, path);
  }

  // 3) KEY = "/path" assignments
  const reAssign =
    /\b([A-Z][A-Z0-9_]{2,120})\s*=\s*["'`](\/[^"'`]{1,300})["'`]/g;
  while ((m = reAssign.exec(content)) !== null) {
    const key = m[1];
    const path = normalizePath(m[2]);
    if (isValidRouteKey(key) && path) outMap.set(key, path);
  }

  return outMap;
}

function sanitizeRoutesMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!isValidRouteKey(k)) continue;
    const p = normalizePath(String(v));
    if (p) out[k] = p;
  }
  return out;
}

function diffRoutes(prev, curr) {
  prev = sanitizeRoutesMap(prev);
  curr = sanitizeRoutesMap(curr);
  const added = {};
  const removed = {};
  const modified = {};
  for (const [k, v] of Object.entries(curr)) {
    if (!(k in prev)) added[k] = v;
    else if (prev[k] !== v) modified[k] = v;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in curr)) removed[k] = v;
  }
  return { added, removed, modified };
}

function formatEndpointsEmbed(routeDiff, buildNumber, limit = 40) {
  const lines = [];
  for (const [k, v] of Object.entries(routeDiff.added || {})) {
    lines.push(`+ ${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(routeDiff.removed || {})) {
    lines.push(`- ${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(routeDiff.modified || {})) {
    lines.push(`~ ${k}: ${v}`);
  }

  const a = Object.keys(routeDiff.added || {}).length;
  const r = Object.keys(routeDiff.removed || {}).length;
  const m = Object.keys(routeDiff.modified || {}).length;
  if (a + r + m === 0) return null;

  const body = lines.slice(0, limit).join('\n');
  const more = lines.length > limit ? `\n… +${lines.length - limit} more` : '';

  return {
    title: 'Endpoints',
    description:
      'Added · removed · modified\n```\n' +
      body +
      more +
      '\n```\n**Build Id** — ' +
      buildNumber,
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
  };
}

async function fetchWumpusRoutes(fetchImpl) {
  try {
    const res = await fetchImpl(WUMPUS_ROUTES_URL, {
      headers: { 'User-Agent': 'canary-scraper', Accept: 'application/json' },
      timeout: 60000,
    });
    if (!res.ok) return null;
    return sanitizeRoutesMap(await res.json());
  } catch {
    return null;
  }
}

module.exports = {
  extractEndpointsFromContent,
  sanitizeRoutesMap,
  diffRoutes,
  formatEndpointsEmbed,
  fetchWumpusRoutes,
  isValidRouteKey,
  normalizePath,
  WUMPUS_ROUTES_URL,
};
