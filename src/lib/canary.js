/**
 * Discord Canary build scraper.
 * Fetches the canary.discord.com/app HTML, parses GLOBAL_ENV metadata
 * (BUILD_NUMBER, VERSION_HASH, etc.), and extracts all JS/CSS asset URLs.
 * Assets are prioritized so web.* bundles are fetched first.
 */
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { DEFAULT_UA } = require('./utils');

const CANARY_APP = 'https://canary.discord.com/app';

/**
 * Fetch the Discord Canary web app HTML and extract build metadata + asset URLs.
 *
 * @returns {Promise<{buildNumber:string,versionHash:string|null,releaseChannel:string,apiEndpoint:string|null,webappEndpoint:string|null,assets:string[],cssAssets:string[],globalEnv:object,scrapedAt:string}>}
 * @throws {Error} if BUILD_NUMBER is missing or invalid, or if no JS assets found
 */
async function fetchBuild() {
  const res = await fetch(CANARY_APP, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml',
    },
    timeout: 25000,
  });
  if (!res.ok) throw new Error('canary app HTTP ' + res.status);
  const html = await res.text();
  console.log('HTML length:', html.length);

  const env = parseGlobalEnv(html);
  const { js, css } = extractAssetUrls(html);
  const assets = prioritizeAssets(js);

  console.log(
    'BUILD_NUMBER:',
    env.BUILD_NUMBER,
    '| js:',
    assets.length,
    '| css:',
    css.length,
    '| web:',
    assets.filter((u) => /\/web\./i.test(u)).length,
  );

  // BUILD_NUMBER is mandatory — never continue as "unknown".
  if (!env.BUILD_NUMBER || !/^\d{4,12}$/.test(String(env.BUILD_NUMBER))) {
    throw new Error(
      'BUILD_NUMBER_MISSING: could not parse a valid Discord Canary BUILD_NUMBER from HTML — abort scrape',
    );
  }
  if (!assets.length) {
    throw new Error('NO_JS_ASSETS: HTML listed zero /assets/ JS files — abort scrape');
  }

  return {
    buildNumber: String(env.BUILD_NUMBER),
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    apiEndpoint: env.API_ENDPOINT || null,
    webappEndpoint: env.WEBAPP_ENDPOINT || null,
    assets,
    cssAssets: css,
    globalEnv: env,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Parse Discord's GLOBAL_ENV object from the HTML to extract build metadata.
 * Tries quoted, unquoted, and window.GLOBAL_ENV block patterns.
 * @param {string} html - raw HTML from canary.discord.com/app
 * @returns {object} parsed environment keys
 */
function parseGlobalEnv(html) {
  const out = {};
  const keys = [
    'BUILD_NUMBER',
    'VERSION_HASH',
    'RELEASE_CHANNEL',
    'API_ENDPOINT',
    'WEBAPP_ENDPOINT',
    'CDN_HOST',
    'ASSET_ENDPOINT',
    'MEDIA_PROXY_ENDPOINT',
    'WIDGET_ENDPOINT',
    'INVITE_HOST',
    'GUILD_TEMPLATE_HOST',
    'GIFT_CODE_HOST',
    'MARKETING_ENDPOINT',
    'NETWORKING_ENDPOINT',
    'REMOTE_AUTH_ENDPOINT',
    'SENTRY_TAGS',
  ];
  for (const k of keys) {
    const re = new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"');
    const m = html.match(re);
    if (m) out[k] = m[1];
  }
  // BUILD_NUMBER sometimes unquoted numeric (4–12 digits)
  if (!out.BUILD_NUMBER) {
    const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d{4,12})"?/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  if (!out.BUILD_NUMBER) {
    const m = html.match(/BUILD_NUMBER['"]?\s*[:=]\s*['"]?(\d{4,12})/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  if (!out.BUILD_NUMBER) {
    const m = html.match(/window\.GLOBAL_ENV\s*=\s*\{([\s\S]{0,4000}?)\}/);
    if (m) {
      const block = m[1];
      const bm = block.match(/BUILD_NUMBER['"]?\s*:\s*['"]?(\d{4,12})/);
      if (bm) out.BUILD_NUMBER = bm[1];
    }
  }
  return out;
}

/**
 * Extract all JS and CSS asset URLs from the Discord Canary HTML.
 * Uses both cheerio DOM parsing and regex fallback for robustness.
 * @param {string} html - raw HTML
 * @returns {{js:string[],css:string[]}} arrays of absolute asset URLs
 */
function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const js = new Set();
  const css = new Set();

  const add = (href) => {
    if (!href || !href.includes('/assets/')) return;
    const clean = href.split('?')[0];
    if (clean.endsWith('.js'))
      js.add(
        clean.startsWith('http')
          ? clean
          : 'https://canary.discord.com' +
            (clean.startsWith('/') ? clean : '/' + clean),
      );
    if (clean.endsWith('.css'))
      css.add(
        clean.startsWith('http')
          ? clean
          : 'https://canary.discord.com' +
            (clean.startsWith('/') ? clean : '/' + clean),
      );
  };

  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('link[rel="stylesheet"]').each((_, el) => add($(el).attr('href')));

  const reSrc = /(?:src|href)=["']([^"']*\/assets\/[^"']+\.(?:js|css))["']/gi;
  let m;
  while ((m = reSrc.exec(html))) add(m[1]);

  return { js: [...js], css: [...css] };
}

/**
 * Sort assets by priority: web.* bundles first, then other JS, then sentry.
 * @param {string[]} assets - asset URLs
 * @returns {string[]} sorted assets
 */
function prioritizeAssets(assets) {
  return [...assets].sort((a, b) => score(b) - score(a));
}

/** Priority score for an asset URL (higher = more important). */
function score(url) {
  const u = String(url).toLowerCase();
  if (/\/web\./.test(u)) return 100;
  if (/\/sentry\./.test(u)) return 10;
  return 50;
}

module.exports = { fetchBuild, extractAssetUrls, prioritizeAssets, parseGlobalEnv };
