const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CANARY_APP = 'https://canary.discord.com/app';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchBuild() {
  const res = await fetch(CANARY_APP, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    timeout: 20000,
  });
  if (!res.ok) throw new Error('canary app ' + res.status);
  const html = await res.text();

  const env = parseGlobalEnv(html);
  const assets = extractAssetUrls(html);

  return {
    buildNumber: env.BUILD_NUMBER || 'unknown',
    versionHash: env.VERSION_HASH || null,
    releaseChannel: env.RELEASE_CHANNEL || 'canary',
    assets,
    scrapedAt: new Date().toISOString(),
  };
}

function parseGlobalEnv(html) {
  const m = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\});/);
  if (!m) {
    // fallback BUILD_NUMBER
    const bn = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
    const vh = html.match(/"VERSION_HASH"\s*:\s*"([a-f0-9]+)"/i);
    return {
      BUILD_NUMBER: bn ? bn[1] : null,
      VERSION_HASH: vh ? vh[1] : null,
      RELEASE_CHANNEL: 'canary',
    };
  }
  const block = m[1];
  const grab = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"?([^,"}]+)"?`);
    const mm = block.match(re);
    return mm ? mm[1].replace(/^"|"$/g, '').trim() : null;
  };
  return {
    BUILD_NUMBER: grab('BUILD_NUMBER'),
    VERSION_HASH: grab('VERSION_HASH'),
    RELEASE_CHANNEL: grab('RELEASE_CHANNEL') || 'canary',
  };
}

function extractAssetUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  const add = (href) => {
    if (!href || !href.includes('/assets/')) return;
    urls.add(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
  };
  $('script[src]').each((_, el) => add($(el).attr('src')));
  const re = /\/assets\/([a-zA-Z0-9._-]+\.js)/g;
  let m;
  while ((m = re.exec(html)) !== null) add(`/assets/${m[1]}`);
  return [...urls];
}

module.exports = { fetchBuild, extractAssetUrls };
