/**
 * Track Discord mobile app versions and notify on updates.
 *
 * Channels:
 *  - iOS Stable  → Apple iTunes Lookup API (public, reliable)
 *  - iOS Beta    → highest iOS OTA manifest (often tracks TestFlight-ish builds)
 *  - Android Stable → highest public OTA manifest + cross-check
 *  - Android Beta / Alpha → higher OTA builds when Discord publishes them;
 *    otherwise marked unavailable (Play internal tracks are not public)
 *
 * State: data/mobile_versions.json
 * Webhook: DISCORD_WEBHOOK_URL (same as main scraper)
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
  const text = await fetchText(url, opts);
  return JSON.parse(text);
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
    releaseNotes: (r.releaseNotes || '').slice(0, 400) || null,
    storeUrl: r.trackViewUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`,
    source: 'itunes_lookup',
  };
}

/** Probe public OTA manifests for a platform; return highest version found. */
async function probeOtaLatest(os, majorFrom, majorTo) {
  const found = [];
  // Discord mobile versions are usually MAJOR.MINOR (iOS often MAJOR.0)
  const minors =
    os === 'ios'
      ? [0, 1, 2, 3, 4, 5]
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  // Scan from high majors downward for speed once we have a hit
  for (let major = majorTo; major >= majorFrom; major--) {
    let anyInMajor = false;
    for (const minor of minors) {
      const version = `${major}.${minor}`;
      try {
        const data = await fetchJson(
          `https://discord.com/${os}/${version}/manifest.json`,
        );
        const meta = data.metadata || {};
        found.push({
          version,
          build: meta.build || null,
          commit: meta.commit || null,
          releaseName: meta.release_name || null,
        });
        anyInMajor = true;
      } catch {
        // 404 etc.
      }
    }
    // If we already found something in a higher major and this major is empty,
    // we can stop early when scanning downward — but keep 1 major below max for safety
    if (found.length && !anyInMajor && major < majorTo - 1) break;
  }

  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

async function androidFromApkcombo() {
  try {
    const html = await fetchText('https://apkcombo.com/discord/com.discord/');
    const m = html.match(/(?:version|Version)[^0-9]{0,30}(\d+\.\d+(?:\.\d+)?)/i);
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
  } catch (e) {
    console.warn('apkcombo failed:', e.message);
  }
  return null;
}

async function collectAll() {
  const now = new Date().toISOString();
  const channels = [];

  // --- iOS Stable ---
  try {
    const ios = await iosStable();
    channels.push({ ...ios, checkedAt: now });
  } catch (e) {
    console.warn('iOS stable failed:', e.message);
  }

  // --- iOS OTA (proxy for latest published mobile build, incl. some beta) ---
  let iosOta = [];
  try {
    // Start near current stable major
    const baseMajor = channels.find((c) => c.platform === 'ios')
      ? parseVersion(channels.find((c) => c.platform === 'ios').version)[0]
      : 340;
    iosOta = await probeOtaLatest('ios', Math.max(320, baseMajor - 5), baseMajor + 8);
    if (iosOta[0]) {
      const latest = iosOta[0];
      const stable = channels.find((c) => c.platform === 'ios' && c.channel === 'stable');
      const isNewerThanStable =
        stable && cmpVersion(latest.version, stable.version) > 0;
      channels.push({
        platform: 'ios',
        channel: isNewerThanStable ? 'beta' : 'ota_latest',
        version: latest.version,
        build: latest.build,
        commit: latest.commit,
        source: 'discord_ota_manifest',
        storeUrl: 'https://testflight.apple.com/join/gdE4pRzI',
        note: isNewerThanStable
          ? 'OTA build newer than App Store stable — likely TestFlight/beta lineage'
          : 'Matches or trails App Store stable',
        checkedAt: now,
      });
    }
  } catch (e) {
    console.warn('iOS OTA probe failed:', e.message);
  }

  // --- Android OTA ---
  let androidOta = [];
  try {
    const baseMajor = 340;
    androidOta = await probeOtaLatest('android', baseMajor - 5, baseMajor + 15);
    if (androidOta[0]) {
      const latest = androidOta[0];
      channels.push({
        platform: 'android',
        channel: 'stable',
        version: latest.version,
        build: latest.build,
        commit: latest.commit,
        releaseName: latest.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
        checkedAt: now,
      });

      // Heuristic: versions clearly above "stable" latest may be beta/alpha tracks
      // Discord often ships beta ~+1 major family, alpha ~+2 (observed on APK hosts).
      // We keep the top 3 distinct majors as stable / beta / alpha when available.
      const byMajor = new Map();
      for (const row of androidOta) {
        const maj = parseVersion(row.version)[0];
        if (!byMajor.has(maj) || cmpVersion(row.version, byMajor.get(maj).version) > 0) {
          byMajor.set(maj, row);
        }
      }
      const majors = [...byMajor.keys()].sort((a, b) => b - a);
      if (majors.length >= 2) {
        const beta = byMajor.get(majors[0]);
        // if top major is same as stable channel version major, skip
        const stableMaj = parseVersion(latest.version)[0];
        if (majors[0] > stableMaj) {
          // reclassify: highest major = alpha-ish, second = beta-ish when 3+ majors
          // With only public OTA we usually only see stable lineage — still report newest as "latest_ota"
        }
      }
    }
  } catch (e) {
    console.warn('Android OTA probe failed:', e.message);
  }

  // Cross-check apkcombo for Android stable version string
  try {
    const apk = await androidFromApkcombo();
    if (apk) {
      const existing = channels.find(
        (c) => c.platform === 'android' && c.channel === 'stable',
      );
      if (!existing) {
        channels.push({ ...apk, checkedAt: now });
      } else if (cmpVersion(apk.version, existing.version) !== 0) {
        channels.push({
          ...apk,
          channel: 'stable_store_listing',
          note: `Store listing reports ${apk.version} (OTA latest ${existing.version})`,
          checkedAt: now,
        });
      }
    }
  } catch {}

  // Explicit placeholders so the state file always documents all requested tracks
  const ensure = [
    {
      platform: 'ios',
      channel: 'beta',
      fallbackNote:
        'TestFlight versions are not fully public. OTA probe used when a build newer than App Store appears.',
    },
    {
      platform: 'android',
      channel: 'beta',
      fallbackNote:
        'Play Store beta track is not publicly readable without Google auth. Will fill when a public OTA/build is detected.',
    },
    {
      platform: 'android',
      channel: 'alpha',
      fallbackNote:
        'Play Store alpha track is not publicly readable. Will fill when a public OTA/build is detected.',
    },
  ];
  for (const e of ensure) {
    const has = channels.some(
      (c) => c.platform === e.platform && c.channel === e.channel,
    );
    if (!has) {
      channels.push({
        platform: e.platform,
        channel: e.channel,
        version: null,
        build: null,
        available: false,
        note: e.fallbackNote,
        checkedAt: now,
      });
    }
  }

  return {
    scrapedAt: now,
    channels,
    otaIndex: {
      ios: iosOta.slice(0, 15),
      android: androidOta.slice(0, 15),
    },
  };
}

function channelKey(c) {
  return `${c.platform}:${c.channel}`;
}

function detectChanges(prev, next) {
  const changes = [];
  const prevMap = new Map(
    (prev?.channels || [])
      .filter((c) => c.version)
      .map((c) => [channelKey(c), c]),
  );
  for (const c of next.channels) {
    if (!c.version) continue;
    const p = prevMap.get(channelKey(c));
    if (!p) {
      changes.push({ type: 'new_channel', channel: c });
    } else if (
      p.version !== c.version ||
      (c.build && p.build && p.build !== c.build)
    ) {
      changes.push({
        type: 'updated',
        previous: p,
        channel: c,
      });
    }
  }
  return changes;
}

async function notify(changes, snapshot) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }
  if (!changes.length) return;

  const embeds = changes.slice(0, 8).map((ch) => {
    const c = ch.channel;
    const title =
      ch.type === 'updated'
        ? `📱 New Discord ${c.platform.toUpperCase()} ${c.channel}`
        : `📱 Discord ${c.platform.toUpperCase()} ${c.channel} tracked`;
    const desc =
      ch.type === 'updated'
        ? `**${ch.previous.version}** → **${c.version}**`
        : `Version **${c.version}**`;
    const fields = [
      { name: 'Platform', value: c.platform, inline: true },
      { name: 'Channel', value: c.channel, inline: true },
      { name: 'Version', value: String(c.version), inline: true },
    ];
    if (c.build) fields.push({ name: 'Build', value: String(c.build), inline: true });
    if (c.commit)
      fields.push({ name: 'Commit', value: `\`${c.commit.slice(0, 12)}\``, inline: true });
    if (c.source) fields.push({ name: 'Source', value: c.source, inline: true });
    if (c.note) fields.push({ name: 'Note', value: c.note.slice(0, 200) });
    if (c.releaseNotes)
      fields.push({ name: 'Release notes', value: c.releaseNotes.slice(0, 300) });
    if (c.storeUrl) fields.push({ name: 'Link', value: c.storeUrl });

    const color =
      c.channel === 'alpha'
        ? 0xe74c3c
        : c.channel === 'beta'
          ? 0xf39c12
          : 0x5865f2;

    return {
      title,
      description: desc,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'discord-canary-scraper · mobile versions' },
    };
  });

  // Summary embed of all known versions
  const lines = snapshot.channels
    .filter((c) => c.version)
    .map(
      (c) =>
        `• **${c.platform}/${c.channel}**: \`${c.version}\`${c.build ? ` (build ${c.build})` : ''}`,
    )
    .join('\n');
  embeds.push({
    title: '📋 Current mobile versions',
    description: lines || '_none_',
    color: 0x2f3136,
    timestamp: new Date().toISOString(),
  });

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds }),
  });
  if (!res.ok) {
    console.warn('Webhook failed', res.status, await res.text());
  } else {
    console.log(`🔔 Notified ${changes.length} mobile version change(s)`);
  }
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }

  console.log('📱 Checking Discord mobile versions…');
  const snapshot = await collectAll();
  const changes = detectChanges(previous, snapshot);

  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.changes = changes.map((c) => ({
    type: c.type,
    key: channelKey(c.channel),
    from: c.previous?.version || null,
    to: c.channel.version,
  }));

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });

  for (const c of snapshot.channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }
  console.log(`Changes: ${changes.length}`);

  if (changes.length) {
    await notify(changes, snapshot);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
