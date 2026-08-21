/**
 * FAST path: detect new BUILD_NUMBER and announce once.
 * Deduped via notify_guard so scrape.js won't double-announce.
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

  const res = await fetch(CANARY_APP, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    timeout: 12000,
  });
  if (!res.ok) throw new Error(`canary app ${res.status}`);
  const html = await res.text();

  const m = html.match(/"BUILD_NUMBER"\s*:\s*"?(\d+)"?/);
  const buildNumber = m ? m[1] : null;
  const vh = html.match(/"VERSION_HASH"\s*:\s*"([a-f0-9]+)"/i);
  const versionHash = vh ? vh[1] : null;

  if (!buildNumber) {
    await log.warn('No BUILD_NUMBER found');
    process.exit(0);
  }

  await fs.ensureDir(DATA_DIR);
  let prev = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) prev = await fs.readJson(BUILD_FILE);
  } catch {}

  const isNew = !prev || String(prev.buildNumber) !== String(buildNumber);
  await log.info(`Build ${buildNumber}`, { isNew, ms: Date.now() - t0 });

  if (!isNew || !WEBHOOK_URL) {
    await log.info('watch_build skip (not new or no webhook)');
    process.exit(0);
  }

  const key = `build-announce:${buildNumber}`;
  const ok = await claim(key);
  if (!ok) {
    await log.info('watch_build skip — already announced', { buildNumber });
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
          { name: 'Status', value: 'Detected — scanning…', inline: false },
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
  await markBuildAnnounced(buildNumber);
  await log.info(`Early webhook ${wr.status}`, { buildNumber, ms: Date.now() - t0 });
}

main().catch(async (e) => {
  await log.error('watch_build failed', { err: String(e.message || e) });
  process.exit(0);
});
