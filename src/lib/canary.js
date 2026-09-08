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

  if (!env.BUILD_NUMBER) console.warn('WARNING: BUILD_NUMBER not found');
  if (!assets.length) console.warn('WARNING: no JS assets');
  if (!css.length) console.warn('WARNING: no CSS assets');

  return {
    buildNumber: env.BUILD_NUMBER || 'unknown',
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

function parseGlobalEnv(html) {
  const out = {};
  // window.GLOBAL_ENV = { ... } or inline "KEY":"value"
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
  // BUILD_NUMBER sometimes unquoted
  if (!out.BUILD_NUMBER) {
    const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  return out;
}

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

  const reJs = /\/assets\/([a-zA-Z0-9._-]+\.js)/g;
  const reCss = /\/assets\/([a-zA-Z0-9._-]+\.css)/g;
  let m;
  while ((m = reJs.exec(html)) !== null) add(`/assets/${m[1]}`);
  while ((m = reCss.exec(html)) !== null) add(`/assets/${m[1]}`);

  return { js: [...js], css: [...css].sort() };
}

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

module.exports = { fetchBuild, extractAssetUrls, prioritizeAssets, parseGlobalEnv };
