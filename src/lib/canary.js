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

  // BUILD_NUMBER is mandatory — never continue as "unknown".
  if (!env.BUILD_NUMBER || !/^\d{4,8}$/.test(String(env.BUILD_NUMBER))) {
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
  // BUILD_NUMBER sometimes unquoted numeric
  if (!out.BUILD_NUMBER) {
    const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d{4,8})"?/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  // GLOBAL_ENV block strategies
  if (!out.BUILD_NUMBER) {
    const m = html.match(/BUILD_NUMBER['"]?\s*[:=]\s*['"]?(\d{4,8})/);
    if (m) out.BUILD_NUMBER = m[1];
  }
  if (!out.BUILD_NUMBER) {
    const m = html.match(/window\.GLOBAL_ENV\s*=\s*\{([\s\S]{0,4000}?)\}/);
    if (m) {
      const block = m[1];
      const bm = block.match(/BUILD_NUMBER['"]?\s*:\s*['"]?(\d{4,8})/);
      if (bm) out.BUILD_NUMBER = bm[1];
    }
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
    if (clean.endsWith('.js')) js.add(clean.startsWith('http') ? clean : 'https://canary.discord.com' + (clean.startsWith('/') ? clean : '/' + clean));
    if (clean.endsWith('.css')) css.add(clean.startsWith('http') ? clean : 'https://canary.discord.com' + (clean.startsWith('/') ? clean : '/' + clean));
  };

  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('link[rel="stylesheet"]').each((_, el) => add($(el).attr('href')));

  // regex fallback for script src not in DOM-friendly form
  const reSrc = /(?:src|href)=["']([^"']*\/assets\/[^"']+\.(?:js|css))["']/gi;
  let m;
  while ((m = reSrc.exec(html))) add(m[1]);

  return { js: [...js], css: [...css] };
}

function prioritizeAssets(assets) {
  return [...assets].sort((a, b) => score(b) - score(a));
}

function score(url) {
  const u = String(url).toLowerCase();
  if (/\/web\./.test(u)) return 100;
  if (/\/sentry\./.test(u)) return 10;
  return 50;
}

module.exports = { fetchBuild, extractAssetUrls, prioritizeAssets, parseGlobalEnv };
