/**
 * FAST path: detect new BUILD_NUMBER and announce once.
 * Writes build.json immediately so the next run never re-announces.
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { log } = require('./logger');
const { claim, markBuildAnnounced } = require('./notify_guard');

const CANARY_APP = 'https://canary.discord.com/app';
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const t0 = Date.now();
  await log.info('watch_build start');
  await fs.ensureDir(DATA_DIR);

  if (!WEBHOOK_URL) {
    await log.warn('DISCORD_WEBHOOK_URL missing — cannot notify');
  }

  const res = await fetch(CANARY_APP, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error('canary app ' + res.status);
  const html = await res.text();

  const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
  const buildNumber = m ? m[1] : null;
  const vh = html.match(/"VERSION_HASH"\s*:\s*"([a-f0-9]+)"/i);
  const versionHash = vh ? vh[1] : null;

  if (!buildNumber) {
    await log.warn('No BUILD_NUMBER found');
    process.exit(0);
  }

  let prev = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) prev = await fs.readJson(BUILD_FILE);
  } catch (e) {}

  const isNew = !prev || String(prev.buildNumber) !== String(buildNumber);
  await log.info('Build ' + buildNumber, {
    isNew,
    prev: prev && prev.buildNumber,
    ms: Date.now() - t0,
  });

  // Always persist current build number first (even if same)
  // so failed later steps cannot leave us stuck on an old build forever.
  await fs.writeJson(
    BUILD_FILE,
    {
      buildNumber: String(buildNumber),
      versionHash: versionHash || (prev && prev.versionHash) || null,
      releaseChannel: 'canary',
      scrapedAt: new Date().toISOString(),
      source: 'watch_build',
    },
    { spaces: 2 },
  );

  if (!isNew) {
    await log.info('watch_build skip (same build)');
    process.exit(0);
  }

  if (!WEBHOOK_URL) {
    await log.info('watch_build skip (no webhook)');
    process.exit(0);
  }

  const key = 'build-announce:' + buildNumber;
  const ok = await claim(key);
  if (!ok) {
    await log.info('watch_build skip — already claimed', { buildNumber });
    process.exit(0);
  }

  const body = {
    username: 'Canary Scraper',
    embeds: [
      {
        title: 'New Discord Canary Build',
        color: 0xed4245,
        fields: [
          { name: 'Build', value: String(buildNumber), inline: true },
          { name: 'Channel', value: 'canary', inline: true },
          {
            name: 'Hash',
            value: versionHash ? '`' + versionHash.slice(0, 12) + '`' : '—',
            inline: true,
          },
          { name: 'Status', value: 'Detected — full scan running…', inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const wr = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await wr.text().catch(() => '');
  await markBuildAnnounced(buildNumber);
  await log.info('Early webhook ' + wr.status, {
    buildNumber,
    ms: Date.now() - t0,
    body: txt.slice(0, 120),
  });

  if (!wr.ok) {
    await log.warn('Webhook POST failed — check DISCORD_WEBHOOK_URL secret');
  }
}

if (require.main === module) {
  main().catch(async (e) => {
    await log.error('watch_build failed', { err: String(e.message || e) });
    process.exit(0);
  });
}
