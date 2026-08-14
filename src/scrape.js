const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CANARY_URL = 'https://canary.discord.com/app';
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

async function getPage() {
  const res = await fetch(CANARY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch Canary page: ${res.status}`);
  return res.text();
}

function extractAssets(html) {
  const $ = cheerio.load(html);
  const assets = {
    scripts: [],
    styles: [],
    buildNumber: null,
    releaseChannel: 'canary',
  };

  // Extract script src
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.includes('/assets/')) {
      assets.scripts.push(src.startsWith('http') ? src : `https://canary.discord.com${src}`);
    }
  });

  // Extract CSS
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/assets/')) {
      assets.styles.push(href.startsWith('http') ? href : `https://canary.discord.com${href}`);
    }
  });

  // Try to find build number in inline scripts
  const scriptsText = $('script:not([src])').map((_, el) => $(el).html()).get().join('\n');
  
  const buildMatch = scriptsText.match(/BUILD_NUMBER["']?\s*[:=]\s*["']?(\d+)/i) ||
                     scriptsText.match(/buildNumber["']?\s*[:=]\s*["']?(\d+)/i) ||
                     scriptsText.match(/"build_number"\s*:\s*"?(\d+)/i);
  
  if (buildMatch) {
    assets.buildNumber = buildMatch[1];
  }

  // Fallback: hash of the main assets list
  if (!assets.buildNumber) {
    const hash = crypto.createHash('sha256')
      .update([...assets.scripts, ...assets.styles].sort().join('|'))
      .digest('hex')
      .slice(0, 12);
    assets.buildNumber = `hash-${hash}`;
  }

  return assets;
}

async function downloadFile(url, dest) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!res.ok) {
    console.warn(`Failed to download ${url}: ${res.status}`);
    return false;
  }
  const buffer = await res.buffer();
  await fs.ensureDir(path.dirname(dest));
  await fs.writeFile(dest, buffer);
  return true;
}

async function downloadAssets(assets) {
  await fs.emptyDir(ASSETS_DIR);
  const downloaded = [];

  for (const url of [...assets.scripts, ...assets.styles]) {
    const filename = path.basename(url.split('?')[0]);
    const dest = path.join(ASSETS_DIR, filename);
    const ok = await downloadFile(url, dest);
    if (ok) {
      downloaded.push(filename);
      console.log(`✓ ${filename}`);
    }
  }

  return downloaded;
}

async function loadPreviousBuild() {
  try {
    if (await fs.pathExists(BUILD_FILE)) {
      return await fs.readJson(BUILD_FILE);
    }
  } catch (e) {}
  return null;
}

async function saveBuild(info) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(BUILD_FILE, info, { spaces: 2 });
}

async function sendWebhook(buildInfo, isNew) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL set – skipping notification');
    return;
  }

  const embed = {
    title: isNew ? '🚀 New Discord Canary Build Detected!' : 'ℹ️ Discord Canary Check',
    color: isNew ? 0x57F287 : 0x5865F2,
    fields: [
      { name: 'Build', value: String(buildInfo.buildNumber), inline: true },
      { name: 'Channel', value: 'Canary', inline: true },
      { name: 'Assets downloaded', value: String(buildInfo.assetCount || 0), inline: true },
      { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    ],
    footer: { text: 'Discord Canary Scraper • Inspired by Wumpus Central' },
    timestamp: new Date().toISOString(),
  };

  if (buildInfo.scripts && buildInfo.scripts.length > 0) {
    const list = buildInfo.scripts
      .slice(0, 5)
      .map(s => '`' + path.basename(s) + '`')
      .join('\n');
    embed.fields.push({
      name: 'Main scripts',
      value: list || '—',
    });
  }

  const body = {
    username: 'Canary Scraper',
    avatar_url: 'https://cdn.discordapp.com/emojis/1044610189761052752.webp',
    embeds: [embed],
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('Webhook failed:', res.status);
    else console.log('Webhook notification sent');
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
}

async function main() {
  console.log('🔍 Scraping Discord Canary...\n');

  const html = await getPage();
  const assets = extractAssets(html);

  console.log(`Build number : ${assets.buildNumber}`);
  console.log(`Scripts found: ${assets.scripts.length}`);
  console.log(`Styles found : ${assets.styles.length}\n`);

  const previous = await loadPreviousBuild();
  const isNew = !previous || previous.buildNumber !== assets.buildNumber;

  if (isNew) {
    console.log('✨ New build detected! Downloading assets...\n');
    const downloaded = await downloadAssets(assets);

    const buildInfo = {
      buildNumber: assets.buildNumber,
      releaseChannel: 'canary',
      scrapedAt: new Date().toISOString(),
      assetCount: downloaded.length,
      scripts: assets.scripts,
      styles: assets.styles,
      files: downloaded,
    };

    await saveBuild(buildInfo);
    await sendWebhook(buildInfo, true);

    console.log(`\n✅ Done! ${downloaded.length} files archived.`);
    process.exit(0);
  } else {
    console.log('No new build. Everything is up to date.');
    await sendWebhook({
      buildNumber: assets.buildNumber,
      assetCount: previous?.assetCount || 0,
      scripts: assets.scripts,
    }, false);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
