/**
 * Discord Mobile Version Tracker
 *
 * Tracks iOS (stable + beta) and Android (stable + beta + alpha) versions.
 *
 * Sources:
 *  - iOS stable: iTunes App Store lookup API
 *  - iOS beta: Discord OTA manifest (TestFlight track, if ahead of App Store)
 *  - Android stable: APKCombo / Google Play (or OTA if it matches)
 *  - Android beta: OTA version ahead of stable (Play beta track)
 *  - Android alpha: highest OTA version ahead of stable (Play alpha track)
 *
 * The OTA manifest at https://discord.com/{platform}/{version}/manifest.json
 * serves ALL released versions. We probe a range of versions to discover them.
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./lib/webhook');
const { writeJsonAtomic } = require('./lib/atomic');
const { DEFAULT_BOT_NAME: BOT_NAME, DEFAULT_MOBILE_AVATAR: BOT_AVATAR, DEFAULT_UA } = require('./lib/utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// ── PAUSE ─────────────────────────────────────────────
// true = no version scrape notifications (requested)
const PAUSED =
  process.env.MOBILE_VERSIONS_PAUSED === '1' ||
  process.env.MOBILE_VERSIONS_PAUSED === 'true';
// ──────────────────────────────────────────────────────

const IOS_APP_ID = '985746746';
const TESTFLIGHT_URL = 'https://testflight.apple.com/join/gdE4pRzI';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.discord';

// ── Version helpers ───────────────────────────────────

function parseVersion(v) {
  const parts = String(v)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function channelKey(c) {
  return `${c.platform}/${c.channel}`;
}

function versionFingerprint(c) {
  if (!c || !c.version) return null;
  return `${c.platform}|${c.channel}|${c.version}`;
}

// ── HTTP helpers ──────────────────────────────────────

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    timeout: 22000,
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

// ── Webhook ───────────────────────────────────────────

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return false;
  const body = {
    username: BOT_NAME,
    avatar_url: BOT_AVATAR,
    ...payload,
  };
  const embeds = body.embeds || [];
  const base = { username: body.username || BOT_NAME, avatar_url: body.avatar_url || BOT_AVATAR };
  const r = await sendEmbeds(WEBHOOK_URL, base, embeds, { label: 'mobile', timeoutMs: 30000, minGapMs: 200, withDismiss: true });
  if (r.ok) {
    console.log('Webhook OK');
    return true;
  }
  if (r.status >= 400 && r.status < 500 && r.status !== 429) {
    throw new Error('Webhook HTTP ' + r.status);
  }
  throw new Error('Webhook failed after retries');
}

// ── iOS stable (App Store) ────────────────────────────

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
    available: true,
  };
}

// ── OTA manifest probing ──────────────────────────────

/**
 * Probe Discord OTA manifests for a platform.
 * Tries a range of major.minor versions and returns all that exist.
 *
 * @param {string} platform - 'ios' or 'android'
 * @param {number} centerMajor - the major version to center the search around
 * @returns {Promise<Array<{version, build, commit, releaseName}>>}
 */
async function probeOta(platform, centerMajor) {
  const found = [];
  const seen = new Set();

  // Search from centerMajor+5 down to centerMajor-15
  // This covers stable, beta, and alpha tracks
  const majors = [];
  for (let m = centerMajor + 5; m >= Math.max(180, centerMajor - 15); m--)
    majors.push(m);

  // Android uses more minor versions than iOS
  const minors =
    platform === 'android'
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  let emptyMajors = 0;

  for (const major of majors) {
    let hits = 0;
    const batchSize = 8;

    for (let i = 0; i < minors.length; i += batchSize) {
      const slice = minors.slice(i, i + batchSize);
      const results = await Promise.all(
        slice.map(async (minor) => {
          const version = `${major}.${minor}`;
          try {
            const data = await fetchJson(
              `https://discord.com/${platform}/${version}/manifest.json`,
            );
            const meta = data.metadata || data || {};
            return {
              version,
              build:
                meta.build != null
                  ? String(meta.build)
                  : meta.native_build != null
                    ? String(meta.native_build)
                    : null,
              commit: meta.commit || null,
              releaseName: meta.release_name || null,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r || seen.has(r.version)) continue;
        seen.add(r.version);
        found.push(r);
        hits++;
      }
    }

    if (hits === 0) {
      emptyMajors++;
      // Stop after 4 consecutive empty majors (once we've found at least something)
      if (found.length && emptyMajors >= 4) break;
    } else {
      emptyMajors = 0;
    }
  }

  // Sort descending by version
  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

// ── Android stable (stores) ───────────────────────────

async function androidFromStores() {
  const sources = [
    {
      name: 'apkcombo',
      url: 'https://apkcombo.com/discord/com.discord/',
      patterns: [
        /softwareVersion[\"'\s:>]+(\d+\.\d+(?:\.\d+)?)/i,
        /itemprop=["']version["'][^>]*content=["'](\d+\.\d+(?:\.\d+)?)["']/i,
        /(?:Version|version)[^\d]{0,40}(\d{2,3}\.\d+(?:\.\d+)?)/,
      ],
    },
    {
      name: 'apkpure',
      url: 'https://apkpure.com/discord-talk-chat-hang-out/com.discord',
      patterns: [
        /(\d{2,3}\.\d+\.\d+)\s*<\/span>/,
        /version[\"'\s:>]+(\d{2,3}\.\d+(?:\.\d+)?)/i,
      ],
    },
    {
      name: 'play_html',
      url: 'https://play.google.com/store/apps/details?id=com.discord&hl=en&gl=US',
      patterns: [
        /\[\[\["(\d+\.\d+\.\d+)"\]/,
        /Current Version[^\d]{0,80}(\d+\.\d+(?:\.\d+)?)/i,
      ],
    },
  ];

  for (const src of sources) {
    try {
      const html = await fetchText(src.url);
      for (const re of src.patterns) {
        const m = html.match(re);
        if (m && /^\d{2,3}\./.test(m[1])) {
          return {
            platform: 'android',
            channel: 'stable',
            version: m[1],
            build: null,
            source: src.name,
            storeUrl: PLAY_STORE_URL,
            available: true,
          };
        }
      }
    } catch (e) {
      console.warn(src.name, e.message);
    }
  }
  return null;
}

// ── Channel classification ────────────────────────────

/**
 * Classify OTA versions into channels.
 *
 * For iOS:
 *  - stable = App Store version
 *  - beta = highest OTA version if > stable (TestFlight)
 *
 * For Android:
 *  - stable = store version (or OTA if it matches)
 *  - beta = OTA version just ahead of stable
 *  - alpha = highest OTA version (most experimental)
 *
 * If multiple OTA versions are ahead of stable:
 *  - The highest = alpha
 *  - The second highest = beta
 *  - If only one ahead: it's alpha
 */
function classifyChannels(platform, storeVersion, otaVersions) {
  const channels = [];

  if (platform === 'ios') {
    // iOS stable
    channels.push({
      platform: 'ios',
      channel: 'stable',
      version: storeVersion,
      source: 'itunes_lookup',
      storeUrl: `https://apps.apple.com/app/id${IOS_APP_ID}`,
      available: true,
    });

    // iOS beta (TestFlight) — OTA version ahead of App Store
    const ahead = otaVersions.filter((v) => cmpVersion(v.version, storeVersion) > 0);
    if (ahead.length > 0) {
      const beta = ahead[0]; // highest
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: beta.version,
        build: beta.build,
        commit: beta.commit,
        releaseName: beta.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: TESTFLIGHT_URL,
        available: true,
        note: 'OTA ahead of App Store (TestFlight)',
      });
    } else {
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: null,
        available: false,
        note: 'OTA not ahead of App Store',
      });
    }
  } else if (platform === 'android') {
    // Android stable — prefer store version, fall back to OTA
    const otaLatest = otaVersions[0] || null;
    let stableVersion = storeVersion;
    let stableSource = 'store';
    let stableBuild = null;
    let stableCommit = null;
    let stableReleaseName = null;

    // If OTA latest matches or is behind store, use store version
    // If OTA latest is ahead of store, the store version is the stable
    if (otaLatest && storeVersion) {
      if (cmpVersion(otaLatest.version, storeVersion) === 0) {
        // OTA latest == store version → use OTA metadata (has build/commit)
        stableVersion = otaLatest.version;
        stableBuild = otaLatest.build;
        stableCommit = otaLatest.commit;
        stableReleaseName = otaLatest.releaseName;
        stableSource = 'discord_ota_manifest';
      }
    }

    if (!stableVersion && otaLatest) {
      // No store version, use OTA as stable
      stableVersion = otaLatest.version;
      stableBuild = otaLatest.build;
      stableCommit = otaLatest.commit;
      stableReleaseName = otaLatest.releaseName;
      stableSource = 'discord_ota_manifest';
    }

    if (stableVersion) {
      channels.push({
        platform: 'android',
        channel: 'stable',
        version: stableVersion,
        build: stableBuild,
        commit: stableCommit,
        releaseName: stableReleaseName,
        source: stableSource,
        storeUrl: PLAY_STORE_URL,
        available: true,
      });
    } else {
      channels.push({
        platform: 'android',
        channel: 'stable',
        version: null,
        available: false,
        note: 'No public Android version source',
      });
    }

    // Android beta + alpha — OTA versions ahead of stable
    const ahead = stableVersion
      ? otaVersions.filter((v) => cmpVersion(v.version, stableVersion) > 0)
      : [];

    if (ahead.length >= 2) {
      // alpha = highest, beta = second highest
      const alpha = ahead[0];
      const beta = ahead[1];
      channels.push({
        platform: 'android',
        channel: 'beta',
        version: beta.version,
        build: beta.build,
        commit: beta.commit,
        releaseName: beta.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: PLAY_STORE_URL,
        available: true,
        note: 'OTA version ahead of stable',
      });
      channels.push({
        platform: 'android',
        channel: 'alpha',
        version: alpha.version,
        build: alpha.build,
        commit: alpha.commit,
        releaseName: alpha.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: PLAY_STORE_URL,
        available: true,
        note: 'OTA version ahead of stable',
      });
    } else if (ahead.length === 1) {
      // Only one version ahead — classify as alpha (most experimental)
      const alpha = ahead[0];
      channels.push({
        platform: 'android',
        channel: 'beta',
        version: null,
        available: false,
        note: 'No OTA version between stable and alpha',
      });
      channels.push({
        platform: 'android',
        channel: 'alpha',
        version: alpha.version,
        build: alpha.build,
        commit: alpha.commit,
        releaseName: alpha.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: PLAY_STORE_URL,
        available: true,
        note: 'OTA version ahead of stable',
      });
    } else {
      channels.push({
        platform: 'android',
        channel: 'beta',
        version: null,
        available: false,
        note: 'No OTA version ahead of stable',
      });
      channels.push({
        platform: 'android',
        channel: 'alpha',
        version: null,
        available: false,
        note: 'No OTA version ahead of stable',
      });
    }
  }

  return channels;
}

// ── Main collection ───────────────────────────────────

async function collectAll() {
  const checkedAt = new Date().toISOString();
  const channels = [];
  const otaIndex = { ios: [], android: [] };

  // 1. iOS stable from App Store
  let iosStoreVersion = null;
  let iosStoreData = null;
  try {
    iosStoreData = await iosStable();
    iosStoreVersion = iosStoreData.version;
    console.log('iOS stable', iosStoreVersion);
  } catch (e) {
    console.warn('iOS stable fail', e.message);
  }

  // Center the OTA search around the iOS stable major (or a fallback)
  const centerMajor = iosStoreVersion ? parseVersion(iosStoreVersion)[0] : 346;

  // 2. iOS OTA probe
  let iosOta = [];
  try {
    iosOta = await probeOta('ios', centerMajor);
    otaIndex.ios = iosOta.slice(0, 30);
    console.log('iOS OTA versions found:', iosOta.length);
    if (iosOta[0]) console.log('iOS OTA latest', iosOta[0].version, iosOta[0].build);
  } catch (e) {
    console.warn('iOS OTA fail', e.message);
  }

  // 3. Android OTA probe
  let androidOta = [];
  try {
    androidOta = await probeOta('android', centerMajor);
    otaIndex.android = androidOta.slice(0, 40);
    console.log('Android OTA versions found:', androidOta.length);
    if (androidOta[0]) console.log('Android OTA latest', androidOta[0].version, androidOta[0].build);
  } catch (e) {
    console.warn('Android OTA fail', e.message);
  }

  // 4. Android store version
  let androidStoreVersion = null;
  try {
    const androidStore = await androidFromStores();
    if (androidStore) {
      androidStoreVersion = androidStore.version;
      console.log('Android store', androidStoreVersion, androidStore.source);
    }
  } catch (e) {
    console.warn('Android store fail', e.message);
  }

  // 5. Classify iOS channels (stable + beta)
  const iosClassified = classifyChannels('ios', iosStoreVersion, iosOta);
  // Merge store data (releaseNotes, releaseDate) into stable channel
  if (iosStoreData) {
    const stableCh = iosClassified.find((c) => c.channel === 'stable');
    if (stableCh) {
      stableCh.releaseDate = iosStoreData.releaseDate || null;
      stableCh.releaseNotes = iosStoreData.releaseNotes || null;
    }
  }
  for (const c of iosClassified) {
    channels.push({ ...c, checkedAt });
  }

  // 6. Classify Android channels (stable + beta + alpha)
  const androidClassified = classifyChannels('android', androidStoreVersion, androidOta);
  for (const c of androidClassified) {
    channels.push({ ...c, checkedAt });
  }

  // Print summary
  for (const c of channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }

  return { scrapedAt: checkedAt, channels, otaIndex };
}

// ── Change detection ──────────────────────────────────

function detectChanges(previous, snapshot) {
  const changes = [];
  const notified = new Set((previous?.notifiedFingerprints || []).map(String));
  const prevMap = new Map();
  for (const c of previous?.channels || []) {
    if (c && c.version) prevMap.set(channelKey(c), c);
  }

  for (const c of snapshot.channels) {
    if (!c.version) continue;
    const key = channelKey(c);
    const fp = versionFingerprint(c);
    if (!fp) continue;
    if (notified.has(fp)) continue;

    const prev = prevMap.get(key);
    if (!prev || !prev.version) {
      changes.push({ type: 'new', channel: c, previous: null, fp });
      continue;
    }
    if (cmpVersion(c.version, prev.version) > 0) {
      changes.push({ type: 'updated', channel: c, previous: prev, fp });
    }
  }

  return { changes, notified };
}

// ── Notifications ─────────────────────────────────────

function colorFor(channel) {
  if (channel === 'alpha') return 0xed4245;
  if (channel === 'beta') return 0xfee75c;
  return 0x5865f2;
}

function platformEmoji(platform) {
  if (platform === 'ios') return '🍎';
  if (platform === 'android') return '🤖';
  return '📱';
}

async function notify(changes) {
  if (!WEBHOOK_URL || !changes.length) return;

  const summaryLines = changes.map((ch) => {
    const c = ch.channel;
    const arrow =
      ch.type === 'updated' && ch.previous
        ? `${ch.previous.version} → **${c.version}**`
        : `**${c.version}**`;
    return `• **${c.platform}/${c.channel}** ${arrow}${c.build ? ` · build \`${c.build}\`` : ''}`;
  });

  await postWebhook({
    embeds: [
      {
        title: 'New Discord Mobile Build',
        description: summaryLines.join('\n'),
        color: 0x5865f2,
        footer: { text: 'Mobile · versions' },
        timestamp: new Date().toISOString(),
      },
    ],
  });

  for (const ch of changes) {
    const c = ch.channel;
    const lines = [
      `**${platformEmoji(c.platform)} ${c.platform.toUpperCase()}** · \`${c.channel}\``,
      ch.type === 'updated'
        ? `* ${ch.previous.version} → **${c.version}**`
        : `* Version **${c.version}**`,
    ];
    if (c.build) lines.push(`* Build **${c.build}**`);
    if (c.commit) lines.push(`* Commit \`${String(c.commit).slice(0, 12)}\``);
    if (c.releaseName) lines.push(`* \`${c.releaseName}\``);
    if (c.source) lines.push(`Source: **${c.source}**`);
    if (c.releaseDate) lines.push(`Released: ${c.releaseDate}`);
    if (c.note) lines.push(c.note.slice(0, 180));
    if (c.storeUrl) lines.push(c.storeUrl);

    await postWebhook({
      embeds: [
        {
          title: `Mobile ${c.platform.toUpperCase()} · ${c.channel}`,
          description: lines.join('\n'),
          color: colorFor(c.channel),
          footer: { text: `Mobile · ${c.platform} · ${c.channel}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

// ── Main ──────────────────────────────────────────────

async function main() {
  if (PAUSED) {
    console.log('=== Mobile Versions ===');
    console.log('PAUSED — no scrape / no webhooks');
    console.log('Set MOBILE_VERSIONS_PAUSED=0 to re-enable');
    console.log('=== Mobile versions done (paused) ===');
    return;
  }

  await fs.ensureDir(DATA_DIR);
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {
      console.warn('loadPrevious: failed to read', STATE_FILE, '-', e.message);
    }
  }

  console.log('=== Mobile Versions ===');
  const snapshot = await collectAll();

  const hadPriorState =
    previous &&
    ((previous.notifiedFingerprints && previous.notifiedFingerprints.length) ||
      (previous.channels || []).some((c) => c && c.version));

  const { changes, notified } = detectChanges(previous, snapshot);

  for (const fp of previous?.notifiedFingerprints || []) {
    notified.add(String(fp));
  }

  const history = previous?.history || [];
  const willNotify = hadPriorState && changes.length > 0 && !!WEBHOOK_URL;

  console.log(
    'Candidates:', changes.length,
    '| hadPriorState:', !!hadPriorState,
    '| prior fingerprints:', notified.size,
  );

  if (!hadPriorState) {
    console.log('Seed run - no webhook; recording fingerprints');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else if (willNotify) {
    try {
      await notify(changes);
    } catch (e) {
      snapshot.history = history.slice(0, 100);
      snapshot.previousScrapedAt = previous?.scrapedAt || null;
      snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
      snapshot.changes = [];
      snapshot.paused = false;
      snapshot.notifyOk = false;
      await writeJsonAtomic(STATE_FILE, snapshot, 2);
      console.warn('NOTIFY_FAIL:', e.message, '- fingerprints NOT advanced');
      process.exit(2);
    }
    for (const ch of changes) {
      if (ch.fp) notified.add(ch.fp);
      history.unshift({
        at: snapshot.scrapedAt,
        key: channelKey(ch.channel),
        from: ch.previous?.version || null,
        to: ch.channel.version,
        build: ch.channel.build || null,
      });
    }
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else {
    console.log('No version bumps - no webhook');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  }

  snapshot.history = history.slice(0, 100);
  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
  snapshot.changes = willNotify
    ? changes.map((c) => ({
        type: c.type,
        key: channelKey(c.channel),
        from: c.previous?.version || null,
        to: c.channel.version,
        build: c.channel.build || null,
      }))
    : [];
  snapshot.paused = false;
  snapshot.notifyOk = true;

  await writeJsonAtomic(STATE_FILE, snapshot, 2);
  console.log('=== Mobile versions done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
