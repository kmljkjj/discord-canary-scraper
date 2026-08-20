/**
 * FASTEST path: only check Canary BUILD_NUMBER and ping webhook immediately.
 * Runs before the full scrape so you announce first.
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const CANARY_APP = 'https://canary.discord.com/app';
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const t0 = Date.now();
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
    console.log('No BUILD_NUMBER found');
    process.exit(0);
  }

  await fs.ensureDir(DATA_DIR);
  let prev = null;
  try {
    if (await fs.pathExists(BUILD_FILE)) prev = await fs.readJson(BUILD_FILE);
  } catch {}

  const isNew = !prev || String(prev.buildNumber) !== String(buildNumber);
  console.log(`Build ${buildNumber} (${Date.now() - t0}ms) new=${isNew}`);

  if (!isNew || !WEBHOOK_URL) {
    process.exit(0);
  }

  // Fire immediately — full scrape will send details after
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
            value: versionHash ? `\`${versionHash.slice(0, 12)}\`` : '—',
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
  console.log(`Early webhook ${wr.status} in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(0); // don't fail the job
});
