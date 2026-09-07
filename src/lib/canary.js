const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CANARY_APP = 'https://canary.discord.com/app';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchBuild() {
  const res = await fetch(CANARY_APP, {
    headers: {
      'User-Agent': UA,
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

  if (!env.BUILD_NUMBER) {
    console.warn('WARNING: BUILD_NUMBER not found in HTML');
  }
  if (assets.length === 0) {
    console.warn('WARNING: no /assets/ JS URLs found');
  }
  if (css.length === 0) {
    console.warn('WARNING: no /assets/ CSS URLs found');
  }

  return {
    buildNumber: env.BUILD_NUMBER || 'unknown',
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    assets,
    cssAssets: css,
    scrapedAt: new Date().toISOString(),
  };
}

function parseGlobalEnv(html) {
  const bn = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
  const vh = html.match(/"VERSION_HASH"\s*:\s*"([a-f0-9]+)"/i);
  const rc = html.match(/"RELEASE_CHANNEL"\s*:\s*"([a-z]+)"/i);
  return {
    BUILD_NUMBER: bn ? bn[1] : null,
    VERSION_HASH: vh ? vh[1] : null,
    RELEASE_CHANNEL: rc ? rc[1] : 'canary',
  };
}

/**
 * Récupère TOUS les assets JS + CSS référencés dans le HTML Canary.
 * Avant: seulement .js → on rattait ~250+ CSS.
 */
function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const js = new Set();
  const css = new Set();

  const add = (href) => {
    if (!href || !href.includes('/assets/')) return;
    const clean = href.split('?')[0];
    const full = clean.startsWith('http')
      ? clean
      : `https://canary.discord.com${clean}`;
    if (clean.endsWith('.js')) js.add(full);
    else if (clean.endsWith('.css')) css.add(full);
  };

  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('link[href]').each((_, el) => add($(el).attr('href')));

  // Références inline dans le HTML (listes d'assets Discord)
  const reJs = /\/assets\/([a-zA-Z0-9._-]+\.js)/g;
  const reCss = /\/assets\/([a-zA-Z0-9._-]+\.css)/g;
  let m;
  while ((m = reJs.exec(html)) !== null) add(`/assets/${m[1]}`);
  while ((m = reCss.exec(html)) !== null) add(`/assets/${m[1]}`);

  return { js: [...js], css: [...css].sort() };
}

/** web.* first — contains nearly all experiments + routes */
function prioritizeAssets(assets) {
  return [...assets].sort((a, b) => score(b) - score(a));
}

function score(url) {
  const n = url.split('/').pop().toLowerCase();
  let s = 0;
  if (n.startsWith('web.')) s += 1000;
  if (/i18n|locale|intl|lang|string|message/.test(n)) s += 100;
  if (/vendor/.test(n)) s += 10;
  return s;
}

module.exports = { fetchBuild, extractAssetUrls, prioritizeAssets };
