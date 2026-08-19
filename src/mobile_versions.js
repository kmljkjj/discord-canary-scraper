/**
 * Discord mobile version tracker
 * Same notification style as Canary scraper:
 *  - New Discord Mobile Build (summary)
 *  - Per-channel update embeds (iOS/Android · stable/beta/alpha)
 *
 * Sources (public):
 *  - iOS Stable → Apple iTunes Lookup
 *  - iOS Beta/OTA → discord.com/ios/{version}/manifest.json
 *  - Android Stable → apkcombo / play listing scrape
 *  - Android Beta/Alpha → public listing when available (Play internal tracks need auth)
 *
 * Full mobile experiment mining needs APK/Hermes unpack (Wumpus midroid / mobile-scraper);
 * this job focuses on reliable version detection + clear webhooks.
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IOS_APP_ID = '985746746';

function parseVersion(v) {
  const parts = String(v)
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    timeout: 25000,
    headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.warn('Webhook failed', res.status, await res.text());
  else console.log('Webhook sent');
  await new Promise((r) => setTimeout(r, 500));
}

async function iosStable() {
  const data = await fetchJson(
    `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=us`,
  );
  const r = data.results?.[0];
  if (!r) throw new Error('iTunes: no result');
  return {
    platform: 'ios',
    channel: 'stable',
    version: r.version,
    build: null,
    releaseDate: r.currentVersionReleaseDate || null,
    releaseNotes: (r.releaseNotes || '').slice(0, 500) || null,
    storeUrl: r.trackViewUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`,
    source: 'itunes_lookup',
  };
}

/** Binary-ish scan of public Discord iOS OTA manifests */
async function probeIosOta(centerMajor) {
  const found = [];
  const majors = [];
  for (let m = centerMajor + 12; m >= Math.max(200, centerMajor - 8); m--) majors.push(m);
  const minors = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20];

  for (const major of majors) {
    let hits = 0;
    for (const minor of minors) {
      const version = `${major}.${minor}`;
      try {
        const data = await fetchJson(`https://discord.com/ios/${version}/manifest.json`);
        const meta = data.metadata || data || {};
        found.push({
          version,
          build: meta.build != null ? String(meta.build) : null,
          commit: meta.commit || null,
        });
        hits++;
      } catch {
        /* 404 */
      }
    }
    // stop after a few empty majors below the top hit
    if (found.length && hits === 0) {
      const topMaj = parseVersion(found[0].version)[0];
      if (major < topMaj - 2) break;
    }
  }
  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

async function androidFromApkcombo() {
  try {
    const html = await fetchText('https://apkcombo.com/discord/com.discord/');
    // Prefer explicit version patterns near "Discord"
    const patterns = [
      /softwareVersion["'\s:>]+(\d+\.\d+(?:\.\d+)?)/i,
      /itemprop=["']version["'][^>]*content=["'](\d+\.\d+(?:\.\d+)?)["']/i,
      /(?:Version|version)[^\d]{0,40}(\d{2,3}\.\d+(?:\.\d+)?)/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        return {
          platform: 'android',
          channel: 'stable',
          version: m[1],
          build: null,
          source: 'apkcombo',
          storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
        };
      }
    }
  } catch (e) {
    console.warn('apkcombo failed:', e.message);
  }
  return null;
}

async function androidFromApkpure() {
  try {
    const html = await fetchText('https://apkpure.com/discord-talk-chat-hang-out/com.discord');
    const m = html.match(/(\d{2,3}\.\d+(?:\.\d+)?)\s*(?:\(|<)/);
    if (m) {
      return {
        platform: 'android',
        channel: 'stable',
        version: m[1],
        build: null,
        source: 'apkpure',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
      };
    }
  } catch (e) {
    console.warn('apkpure failed:', e.message);
  }
  return null;
}

async function collectAll() {
  const now = new Date().toISOString();
  const channels = [];

  // iOS Stable
  let iosStableVer = null;
  try {
    const ios = await iosStable();
    iosStableVer = ios.version;
    channels.push({ ...ios, available: true, checkedAt: now });
    console.log(`iOS stable: ${ios.version}`);
  } catch (e) {
    console.warn('iOS stable failed:', e.message);
  }

  // iOS OTA / beta lineage
  let iosOta = [];
  try {
    const baseMajor = iosStableVer ? parseVersion(iosStableVer)[0] : 340;
    iosOta = await probeIosOta(baseMajor);
    if (iosOta[0]) {
      const latest = iosOta[0];
      const newer =
        iosStableVer && cmpVersion(latest.version, iosStableVer) > 0;
      channels.push({
        platform: 'ios',
        channel: newer ? 'beta' : 'ota_latest',
        version: latest.version,
        build: latest.build,
        commit: latest.commit,
        source: 'discord_ota_manifest',
        storeUrl: 'https://testflight.apple.com/join/gdE4pRzI',
        available: true,
        note: newer
          ? 'OTA newer than App Store — likely TestFlight / beta'
          : 'OTA in line with or behind App Store stable',
        checkedAt: now,
      });
      console.log(`iOS OTA latest: ${latest.version} build=${latest.build}`);
    }
  } catch (e) {
    console.warn('iOS OTA failed:', e.message);
  }

  // Android stable from public listings
  let android = await androidFromApkcombo();
  if (!android) android = await androidFromApkpure();
  if (android) {
    channels.push({ ...android, available: true, checkedAt: now });
    console.log(`Android stable: ${android.version} (${android.source})`);
  }

  // Placeholders for tracks that are not public
  const ensure = [
    {
      platform: 'ios',
      channel: 'beta',
      note: 'Filled when OTA build is newer than App Store stable.',
    },
    {
      platform: 'android',
      channel: 'beta',
      note: 'Play beta is not public without Google auth. No public OTA path found currently.',
    },
    {
      platform: 'android',
      channel: 'alpha',
      note: 'Play alpha is not public. No public OTA path found currently.',
    },
  ];
  for (const e of ensure) {
    if (!channels.some((c) => c.platform === e.platform && c.channel === e.channel)) {
      channels.push({
        platform: e.platform,
        channel: e.channel,
        version: null,
        build: null,
        available: false,
        note: e.note,
        checkedAt: now,
      });
    }
  }

  return {
    scrapedAt: now,
    channels,
    otaIndex: { ios: iosOta.slice(0, 20), android: [] },
  };
}

function channelKey(c) {
  return `${c.platform}:${c.channel}`;
}

function detectChanges(prev, next) {
  const changes = [];
  const prevMap = new Map(
    (prev?.channels || []).filter((c) => c.version).map((c) => [channelKey(c), c]),
  );
  for (const c of next.channels) {
    if (!c.version) continue;
    const p = prevMap.get(channelKey(c));
    if (!p) {
      changes.push({ type: 'new', channel: c });
    } else if (p.version !== c.version || (c.build && p.build && p.build !== c.build)) {
      changes.push({ type: 'updated', previous: p, channel: c });
    }
  }
  return changes;
}

function colorFor(channel) {
  if (channel === 'alpha') return 0xed4245;
  if (channel === 'beta' || channel === 'ota_latest') return 0xfaa61a;
  return 0x5865f2;
}

/** Same spirit as Canary "New Discord Canary Build" + experiment cards */
async function notify(changes, snapshot) {
  if (!WEBHOOK_URL || !changes.length) {
    if (!WEBHOOK_URL) console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }

  // 1) Summary
  await postWebhook({
    username: 'Mobile Scraper',
    embeds: [
      {
        title: 'New Discord Mobile Build',
        color: 0xed4245,
        fields: [
          {
            name: 'Updates',
            value: String(changes.length),
            inline: true,
          },
          {
            name: 'Delta',
            value: changes
              .map((ch) => `${ch.channel.platform}/${ch.channel.channel}`)
              .join(' · ')
              .slice(0, 200),
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });

  // 2) One embed per change (experiment-style)
  for (const ch of changes.slice(0, 10)) {
    const c = ch.channel;
    const lines = [
      `+ \`${c.platform}/${c.channel}\``,
      ch.type === 'updated'
        ? `* ${ch.previous.version} → **${c.version}**`
        : `* Version **${c.version}**`,
    ];
    if (c.build) lines.push(`* Build **${c.build}**`);
    if (c.commit) lines.push(`* Commit \`${String(c.commit).slice(0, 12)}\``);
    if (c.source) lines.push(`Source: **${c.source}**`);
    if (c.note) lines.push(c.note.slice(0, 180));
    if (c.storeUrl) lines.push(c.storeUrl);

    await postWebhook({
      username: 'Mobile Scraper',
      embeds: [
        {
          title:
            c.channel === 'beta' || c.channel === 'alpha'
              ? `New Mobile ${c.platform.toUpperCase()} ${c.channel}`
              : `New Mobile ${c.platform.toUpperCase()} Build`,
          description: lines.join('\n'),
          color: colorFor(c.channel),
          footer: { text: `Mobile · ${c.platform} · ${c.channel}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // 3) Snapshot of all known versions
  const lines = snapshot.channels
    .filter((c) => c.version)
    .map(
      (c) =>
        `• **${c.platform}/${c.channel}**: \`${c.version}\`${c.build ? ` (build ${c.build})` : ''}`,
    )
    .join('\n');
  await postWebhook({
    username: 'Mobile Scraper',
    embeds: [
      {
        title: 'Current mobile versions',
        description: lines || '_none detected_',
        color: 0x57f287,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }

  console.log('📱 Discord mobile versions…');
  const snapshot = await collectAll();
  const changes = detectChanges(previous, snapshot);

  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.changes = changes.map((c) => ({
    type: c.type,
    key: channelKey(c.channel),
    from: c.previous?.version || null,
    to: c.channel.version,
    build: c.channel.build || null,
  }));

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });

  for (const c of snapshot.channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }
  console.log(`Changes: ${changes.length}`);

  if (changes.length) await notify(changes, snapshot);
  console.log('✅ Mobile check done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
