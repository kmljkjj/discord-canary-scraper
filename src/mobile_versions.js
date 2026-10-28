/**
 * Discord Mobile Version Tracker
 *
 * Tracks iOS (stable + beta) and Android (stable + beta + alpha) versions.
 *
 * Sources:
 *  - iOS stable: iTunes App Store lookup API
 *  - iOS beta: Discord OTA manifest (TestFlight track, if ahead of App Store)
 *  - Android stable: APKCombo / Google Play (or OTA if it matches)
 *  - Android beta: Aptoide versions page (lists track labels) / APKMirror
 *  - Android alpha: APKMirror (lists alpha track) / Aptoide
 *
 * The OTA manifest at https://discord.com/{platform}/{version}/manifest.json
 * also serves beta/alpha builds — the build number encodes the track
 * (MMM T NN PPPPPPPPP → T: 0=stable, 1=bêta, 2=alpha, 3=dev), so beta/alpha
 * are decoded directly from Discord's OTA. Aptoide/APKMirror are fallback labels.
 *
 * Build number format (from Discord Userdoccers):
 *   MMM T NN PPPPPPP
 *   346 0 13 00444005
 *   ^   ^   ^  ^
 *   |   |   |  patch/build
 *   |   |   minor version
 *   |   track (0=stable, 1=beta, 2=alpha, 3=dev)
 *   major version
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds, sendWebhook, withComponentsUrl } = require('./lib/webhook');
const {
  IS_COMPONENTS_V2_FLAG,
  textDisplay,
  mediaGalleryFromUrls,
  linkButton,
  chunkIntoMessages,
} = require('./lib/components_v2');
const { writeJsonAtomic } = require('./lib/atomic');
const { DEFAULT_BOT_NAME: BOT_NAME, DEFAULT_MOBILE_AVATAR: BOT_AVATAR, DEFAULT_UA } = require('./lib/utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');
const EXTERNAL_FILE = path.join(DATA_DIR, 'external_versions.json');
// Webhook UNIQUE pour les versions mobiles : la première var définie gagne.
// MOBILE_WEBHOOK_URL (salon dédié) → DISCORD_WEBHOOK_URL.
const WEBHOOK_CANDIDATES = [
  ['MOBILE_WEBHOOK_URL', process.env.MOBILE_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK_URL = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;

// ── PAUSE ─────────────────────────────────────────────
const PAUSED =
  process.env.MOBILE_VERSIONS_PAUSED === '1' ||
  process.env.MOBILE_VERSIONS_PAUSED === 'true';
// ──────────────────────────────────────────────────────

const IOS_APP_ID = '985746746';
const TESTFLIGHT_URL = 'https://testflight.apple.com/join/gdE4pRzI';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.discord';
const APTOIDE_VERSIONS_URL = 'https://discord.bd.aptoide.com/versions';
const APKMIRROR_UPLOADS_URL = 'https://www.apkmirror.com/uploads/?appcategory=discord-chat-for-gamers';

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
  const r = await sendEmbeds(WEBHOOK_URL, base, embeds, { identity: 'mobile', label: 'mobile', timeoutMs: 30000, minGapMs: 200, withDismiss: true });
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
    size: r.fileSizeBytes ? (Math.round((Number(r.fileSizeBytes) / 1048576) * 10) / 10) + ' MB' : null,
    requires: r.minimumOsVersion ? 'iOS ' + r.minimumOsVersion + '+' : null,
    artwork: r.artworkUrl512 || r.artworkUrl100 || null,
    releaseDate: r.currentVersionReleaseDate || null,
    releaseNotes: (r.releaseNotes || '').slice(0, 400) || null,
    storeUrl: r.trackViewUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`,
    source: 'itunes_lookup',
    available: true,
  };
}

// ── OTA manifest probing ──────────────────────────────

async function probeOta(platform, centerMajor) {
  const found = [];
  const seen = new Set();

  const majors = [];
  for (let m = centerMajor + 5; m >= Math.max(180, centerMajor - 15); m--)
    majors.push(m);

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
      if (found.length && emptyMajors >= 4) break;
    } else {
      emptyMajors = 0;
    }
  }

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
        /softwareVersion["'\s:>]+(\d+\.\d+(?:\.\d+)?)/i,
        /itemprop=["']version["'][^>]*content=["'](\d+\.\d+(?:\.\d+)?)["']/i,
        /(?:Version|version)[^\d]{0,40}(\d{2,3}\.\d+(?:\.\d+)?)/,
      ],
    },
    {
      name: 'apkpure',
      url: 'https://apkpure.com/discord-talk-chat-hang-out/com.discord',
      patterns: [
        /(\d{2,3}\.\d+\.\d+)\s*<\/span>/,
        /version["'\s:>]+(\d{2,3}\.\d+(?:\.\d+)?)/i,
      ],
    },
    {
      name: 'play_html',
      url: 'https://play.google.com/store/apps/details?id=com.discord&hl=en&gl=US',
      patterns: [
        /\[\[\["(\d+\.\d+\.\d+)"/,
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

// ── Android beta/alpha from external data file ───────

/**
 * Load the last known beta/alpha versions from data/external_versions.json.
 * This file is a fallback for when Aptoide/APKMirror are behind Cloudflare.
 * It can be updated manually or automatically when the scraping succeeds.
 */
async function loadExternalVersions() {
  try {
    if (await fs.pathExists(EXTERNAL_FILE)) {
      const data = await fs.readJson(EXTERNAL_FILE);
      return data;
    }
  } catch (e) {
    console.warn('loadExternalVersions:', e.message);
  }
  return null;
}

/**
 * Save the external versions data to data/external_versions.json.
 * Called when Aptoide/APKMirror scraping succeeds.
 */
async function saveExternalVersions(data) {
  try {
    await writeJsonAtomic(EXTERNAL_FILE, data, 2);
    console.log('Saved external versions to', EXTERNAL_FILE);
  } catch (e) {
    console.warn('saveExternalVersions:', e.message);
  }
}

// ── Android beta/alpha from Aptoide ───────────────────

/**
 * Scrape Aptoide versions page for Discord Android versions with track labels.
 * Aptoide lists versions like "347.8 - Beta — 22/9/2026" and "346.13 - Stable — 22/9/2026".
 * This is the most reliable source for Android beta versions.
 *
 * Returns: { beta: {version, date}, alpha: {version, date} } or null
 */
async function androidFromAptoide() {
  // Try multiple Aptoide locales — the data is the same but some might not be behind Cloudflare
  const locales = ['bd', 'ru', 'fr', 'en', 'vn', 'cn', 'pl'];
  for (const locale of locales) {
    const url = `https://discord.${locale}.aptoide.com/versions`;
    try {
      const html = await fetchText(url, {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      // Skip Cloudflare challenge pages
      if (html.includes('Just a moment') || html.includes('cf-challenge') || html.length < 7000) {
        console.warn(`Aptoide ${locale}: Cloudflare challenge, skipping`);
        continue;
      }

      // Parse version-track pairs from the page
      // Format in HTML: "347.8 - Beta" or "346.13 - Stable"
      const versionTrackRe = /(\d{2,3}\.\d+)\s*[-–]\s*(Stable|Beta|Alpha)/gi;
      const matches = [...html.matchAll(versionTrackRe)];

      if (!matches.length) {
        console.warn(`Aptoide ${locale}: no version-track pairs found (${html.length} bytes)`);
        continue;
      }

      const versions = matches.map((m) => ({
        version: m[1],
        track: m[2].toLowerCase(),
      }));

      // Also try to extract dates
      const dateRe = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
      const _dates = [...html.matchAll(dateRe)];

      // Find the latest beta and alpha
      const betas = versions.filter((v) => v.track === 'beta')
        .sort((a, b) => cmpVersion(b.version, a.version));
      const alphas = versions.filter((v) => v.track === 'alpha')
        .sort((a, b) => cmpVersion(b.version, a.version));
      const stables = versions.filter((v) => v.track === 'stable')
        .sort((a, b) => cmpVersion(b.version, a.version));

      console.log(`Aptoide ${locale}: found ${versions.length} versions (${betas.length} beta, ${alphas.length} alpha, ${stables.length} stable)`);

      return {
        beta: betas[0] || null,
        alpha: alphas[0] || null,
        stable: stables[0] || null,
        all: versions,
        source: 'aptoide',
      };
    } catch (e) {
      console.warn(`Aptoide ${locale}:`, e.message);
    }
  }
  return null;
}

// ── Android beta/alpha from APKMirror ─────────────────

/**
 * Scrape APKMirror for Discord Android versions with track labels.
 * APKMirror lists versions like "Version:290.16 - Beta" and "Version:291.4 - Alpha".
 * Returns: { beta: {version}, alpha: {version} } or null
 */
async function androidFromApkMirror() {
  try {
    const html = await fetchText(APKMIRROR_UPLOADS_URL, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html',
      },
    });

    if (html.includes('Just a moment') || html.includes('cf-challenge') || html.length < 5000) {
      console.warn('APKMirror: Cloudflare challenge, skipping');
      return null;
    }

    // Parse version-track pairs
    const versionTrackRe = /(\d{2,3}\.\d+)\s*[-–]\s*(Stable|Beta|Alpha)/gi;
    const matches = [...html.matchAll(versionTrackRe)];

    if (!matches.length) {
      console.warn('APKMirror: no version-track pairs found');
      return null;
    }

    const versions = matches.map((m) => ({
      version: m[1],
      track: m[2].toLowerCase(),
    }));

    const betas = versions.filter((v) => v.track === 'beta')
      .sort((a, b) => cmpVersion(b.version, a.version));
    const alphas = versions.filter((v) => v.track === 'alpha')
      .sort((a, b) => cmpVersion(b.version, a.version));

    console.log(`APKMirror: found ${versions.length} versions (${betas.length} beta, ${alphas.length} alpha)`);

    return {
      beta: betas[0] || null,
      alpha: alphas[0] || null,
      source: 'apkmirror',
    };
  } catch (e) {
    console.warn('APKMirror:', e.message);
    return null;
  }
}

// ── Android beta/alpha from Discord min version API ──

/**
 * Discord's minimum version API at https://dl.discordapp.net/apps/android/versions.json
 * Returns the minimum supported version, which can hint at the current stable track.
 */
async function discordMinVersion() {
  try {
    const data = await fetchJson('https://dl.discordapp.net/apps/android/versions.json');
    return data?.discord_android_min_version || null;
  } catch (e) {
    console.warn('Discord min version:', e.message);
    return null;
  }
}

// ── Channel classification ────────────────────────────

/**
 * Classify channels for a platform using all available sources.
 *
 * For iOS:
 *  - stable = App Store version
 *  - beta = OTA version ahead of stable (TestFlight)
 *
 * For Android:
 *  - stable = store version (or OTA if it matches)
 *  - beta = from Aptoide/APKMirror (track-labeled versions)
 *  - alpha = from APKMirror/Aptoide (track-labeled versions)
 *  - Fallback: OTA versions ahead of stable
 */
function classifyIosChannels(storeVersion, iosStoreData, otaVersions) {
  const channels = [];

  // iOS stable
  channels.push({
    platform: 'ios',
    channel: 'stable',
    version: storeVersion,
    build: null,
    size: iosStoreData?.size || null,
    requires: iosStoreData?.requires || null,
    artwork: iosStoreData?.artwork || null,
    releaseDate: iosStoreData?.releaseDate || null,
    releaseNotes: iosStoreData?.releaseNotes || null,
    source: 'itunes_lookup',
    storeUrl: `https://apps.apple.com/app/id${IOS_APP_ID}`,
    available: !!storeVersion,
  });

  // iOS beta (TestFlight) — OTA version ahead of App Store
  if (storeVersion) {
    const ahead = otaVersions.filter((v) => cmpVersion(v.version, storeVersion) > 0);
    if (ahead.length > 0) {
      const beta = ahead[0]; // highest OTA version ahead of stable
      channels.push({
        platform: 'ios',
        channel: 'beta',
        version: beta.version,
        build: beta.build,
        commit: beta.commit,
        releaseName: beta.releaseName,
        artwork: iosStoreData?.artwork || null,
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
        storeUrl: TESTFLIGHT_URL,
      });
    }
  } else {
    channels.push({
      platform: 'ios',
      channel: 'beta',
      version: null,
      available: false,
      note: 'No App Store version available',
      storeUrl: TESTFLIGHT_URL,
    });
  }

  return channels;
}

function classifyAndroidChannels(storeVersion, otaVersions, externalBeta, externalAlpha) {
  const channels = [];
  const otaLatest = otaVersions[0] || null;

  // Android stable — prefer store version, fall back to OTA
  let stableVersion = storeVersion;
  let stableBuild = null;
  let stableCommit = null;
  let stableReleaseName = null;
  let stableSource = 'store';

  if (otaLatest && storeVersion && cmpVersion(otaLatest.version, storeVersion) === 0) {
    // OTA latest matches store → use OTA metadata (has build/commit)
    stableBuild = otaLatest.build;
    stableCommit = otaLatest.commit;
    stableReleaseName = otaLatest.releaseName;
    stableSource = 'discord_ota_manifest';
  }

  if (!stableVersion && otaLatest) {
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
      storeUrl: PLAY_STORE_URL,
    });
  }

  // Versions OTA en avance sur la stable
  const ahead = stableVersion
    ? otaVersions.filter((v) => cmpVersion(v.version, stableVersion) > 0)
    : [];

  // Track EXACT décodé du build number : MMM T NN PPPPPPP → T
  // (0 = stable, 1 = bêta, 2 = alpha, 3 = dev). On lit le manifeste OTA de
  // Discord directement — plus fiable que les miroirs (Aptoide/APKMirror).
  const otaByTrack = (track) =>
    ahead.find((v) => (decodeAndroidBuild(v.build) || {}).track === track) || null;
  const otaBeta = otaByTrack(1);
  const otaAlpha = otaByTrack(2);

  const otaEntry = (v, note, channel) => ({
    platform: 'android',
    channel,
    version: v.version,
    build: v.build,
    commit: v.commit,
    releaseName: v.releaseName,
    source: 'discord_ota_manifest',
    storeUrl: PLAY_STORE_URL,
    available: true,
    note,
  });

  // Android bêta — track décodé (OTA) > label miroir (Aptoide/APKMirror) > inférence
  if (otaBeta) {
    channels.push(otaEntry(otaBeta, 'Track bêta décodé du build number', 'beta'));
  } else if (externalBeta && externalBeta.version) {
    const otaMatch = otaVersions.find((v) => v.version === externalBeta.version);
    channels.push({
      platform: 'android',
      channel: 'beta',
      version: externalBeta.version,
      build: otaMatch?.build || null,
      commit: otaMatch?.commit || null,
      releaseName: otaMatch?.releaseName || null,
      source: externalBeta.source || 'aptoide',
      storeUrl: PLAY_STORE_URL,
      available: true,
      note: externalBeta.date ? `Track-labeled on ${externalBeta.source}` : 'Track-labeled version',
    });
  } else if (ahead.length >= 2) {
    // 2+ versions en avance sans track décodé → la 2e est probablement la bêta
    channels.push(otaEntry(ahead[1], 'OTA en avance sur la stable (bêta inférée)', 'beta'));
  } else {
    channels.push({
      platform: 'android',
      channel: 'beta',
      version: null,
      available: false,
      note: ahead.length
        ? 'Une seule version OTA en avance — track indéterminé'
        : 'No OTA version ahead of stable',
      storeUrl: PLAY_STORE_URL,
    });
  }

  // Android alpha — track décodé (OTA) > label miroir > plus haute OTA en avance
  if (otaAlpha) {
    channels.push(otaEntry(otaAlpha, 'Track alpha décodé du build number', 'alpha'));
  } else if (externalAlpha && externalAlpha.version) {
    const otaMatch = otaVersions.find((v) => v.version === externalAlpha.version);
    channels.push({
      platform: 'android',
      channel: 'alpha',
      version: externalAlpha.version,
      build: otaMatch?.build || null,
      commit: otaMatch?.commit || null,
      releaseName: otaMatch?.releaseName || null,
      source: externalAlpha.source || 'apkmirror',
      storeUrl: PLAY_STORE_URL,
      available: true,
      note: externalAlpha.date ? `Track-labeled on ${externalAlpha.source}` : 'Track-labeled version',
    });
  } else {
    const alphaCand = ahead.find((v) => !otaBeta || v.version !== otaBeta.version);
    if (alphaCand) {
      channels.push(otaEntry(alphaCand, 'OTA en avance sur la stable (alpha inférée)', 'alpha'));
    } else {
      channels.push({
        platform: 'android',
        channel: 'alpha',
        version: null,
        available: false,
        note: 'No alpha version found (OTA + mirrors)',
        storeUrl: PLAY_STORE_URL,
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
  const sources = {};

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

  // 5. Android beta/alpha from Aptoide
  let externalBeta = null;
  let externalAlpha = null;
  const aptoideData = await androidFromAptoide();
  if (aptoideData) {
    sources.aptoide = true;
    if (aptoideData.beta) {
      externalBeta = { version: aptoideData.beta.version, source: 'aptoide', date: aptoideData.beta.date };
      console.log('Android beta (Aptoide)', aptoideData.beta.version);
    }
    if (aptoideData.alpha) {
      externalAlpha = { version: aptoideData.alpha.version, source: 'aptoide', date: aptoideData.alpha.date };
      console.log('Android alpha (Aptoide)', aptoideData.alpha.version);
    }
    // Save to external versions file for future fallback
    await saveExternalVersions({
      updatedAt: checkedAt,
      sources: { aptoide: { url: APTOIDE_VERSIONS_URL, lastAccessible: true } },
      android: {
        beta: aptoideData.beta ? { version: aptoideData.beta.version, date: aptoideData.beta.date, source: 'aptoide', track: 'beta' } : null,
        alpha: aptoideData.alpha ? { version: aptoideData.alpha.version, date: aptoideData.alpha.date, source: 'aptoide', track: 'alpha' } : null,
      },
    });
  } else {
    // Aptoide blocked by Cloudflare — load from fallback file
    const externalData = await loadExternalVersions();
    if (externalData) {
      sources.externalFallback = true;
      sources.externalFallbackDate = externalData.updatedAt;
      if (externalData.android?.beta) {
        externalBeta = { version: externalData.android.beta.version, source: externalData.android.beta.source || 'aptoide', date: externalData.android.beta.date };
        console.log('Android beta (fallback)', externalBeta.version, 'from', externalData.updatedAt);
      }
      if (externalData.android?.alpha) {
        externalAlpha = { version: externalData.android.alpha.version, source: externalData.android.alpha.source || 'apkmirror', date: externalData.android.alpha.date };
        console.log('Android alpha (fallback)', externalAlpha.version, 'from', externalData.updatedAt);
      }
      // iOS beta from fallback
      if (externalData.ios?.beta && !iosOta.find(v => cmpVersion(v.version, iosStoreVersion) > 0)) {
        sources.iosBetaFallback = externalData.ios.beta;
        console.log('iOS beta (fallback)', externalData.ios.beta.version, 'from', externalData.updatedAt);
      }
    }
  }

  // 6. Android beta/alpha from APKMirror (fallback)
  if (!externalBeta || !externalAlpha) {
    const apkMirrorData = await androidFromApkMirror();
    if (apkMirrorData) {
      sources.apkmirror = true;
      if (!externalBeta && apkMirrorData.beta) {
        externalBeta = { version: apkMirrorData.beta.version, source: 'apkmirror' };
        console.log('Android beta (APKMirror)', apkMirrorData.beta.version);
      }
      if (!externalAlpha && apkMirrorData.alpha) {
        externalAlpha = { version: apkMirrorData.alpha.version, source: 'apkmirror' };
        console.log('Android alpha (APKMirror)', apkMirrorData.alpha.version);
      }
    }
  }

  // 7. Discord min version (informational)
  const minVersion = await discordMinVersion();
  if (minVersion) {
    console.log('Discord Android min version:', minVersion);
    sources.discordMinVersion = minVersion;
  }

  // 8. Classify iOS channels (stable + beta)
  const iosClassified = classifyIosChannels(iosStoreVersion, iosStoreData, iosOta);
  for (const c of iosClassified) {
    channels.push({ ...c, checkedAt });
  }

  // 9. Classify Android channels (stable + beta + alpha)
  const androidClassified = classifyAndroidChannels(
    androidStoreVersion, androidOta, externalBeta, externalAlpha,
  );
  for (const c of androidClassified) {
    channels.push({ ...c, checkedAt });
  }

  // Vignette (icône Discord) pour tous les canaux qui n'en ont pas
  for (const c of channels) {
    if (!c.artwork) c.artwork = iosStoreData?.artwork || null;
  }

  // Print summary
  for (const c of channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }

  return { scrapedAt: checkedAt, channels, otaIndex, sources };
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

/**
 * Décode un build number Android au format Discord :
 *   MMM T NN PPPPPPPPP  (ex. 35000800463173 → 350 / 0 / 08 / 00463173)
 *   → version 350.8 · track 0 = stable (0=stable, 1=beta, 2=alpha, 3=dev)
 */
function decodeAndroidBuild(build) {
  const m = String(build || '').match(/^(\d{3})(\d)(\d{2})(\d{8})$/);
  if (!m) return null;
  const trackNames = { 0: 'stable', 1: 'beta', 2: 'alpha', 3: 'dev' };
  return {
    version: `${Number(m[1])}.${Number(m[3])}`,
    track: Number(m[2]),
    trackName: trackNames[Number(m[2])] || 'unknown',
  };
}

/** Couleur d'accent par canal (style release tracker). */
function colorFor(channel) {
  if (channel === 'alpha') return 0xfee75c;
  if (channel === 'beta') return 0xe67e22;
  return 0x5865f2;
}

function releaseTitle(c) {
  if (c.platform === 'ios') return c.channel === 'beta' ? 'New TestFlight Release' : 'New App Store Release';
  return 'New Android Release';
}

function trackName(c) {
  if (c.channel === 'beta') return 'Beta';
  if (c.channel === 'alpha') return 'Alpha';
  return 'Stable';
}

function formatDateTimeEn(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '').slice(0, 19);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${date} at ${time}`;
  } catch {
    return String(iso || '').slice(0, 19);
  }
}

/**
 * Construit les composants Components V2 d'un message de release :
 * « New App Store Release » / « New TestFlight Release » / « New Android Release »
 * avec icône de l'app, version détectée, champs (Size, Requires, Build,
 * Commit, Released), What's New et boutons de liens.
 */
function buildReleaseComponents(ch) {
  const c = ch.channel;
  const isNew = ch.type === 'new' || !ch.previous || !ch.previous.version;
  const detected = formatDateTimeEn(c.checkedAt || new Date().toISOString());
  const track = c.platform === 'android' && c.channel !== 'stable' ? trackName(c) : null;

  const versionParts = [isNew ? `**${c.version}**` : `${ch.previous.version} → **${c.version}**`];
  if (track) versionParts.push(`**${track}**`);
  if (c.platform === 'ios' && c.channel === 'beta' && c.build) versionParts.push(`Build ${c.build}`);
  versionParts.push(`Detected ${detected}`);

  const comps = [];
  comps.push(textDisplay(`## ${releaseTitle(c)}`));
  const gallery = mediaGalleryFromUrls(c.artwork ? [c.artwork] : []);
  if (gallery) comps.push(gallery);
  comps.push(textDisplay(versionParts.join(' · ')));

  const lines = [];
  if (c.size) lines.push(`**Size** · ${c.size}`);
  if (c.requires) lines.push(`**Requires** · ${c.requires}`);
  if (c.build) {
    const decoded = c.platform === 'android' ? decodeAndroidBuild(c.build) : null;
    lines.push(`**Build** · \`${c.build}\`${decoded ? ` · track ${decoded.track} (${decoded.trackName})` : ''}`);
  }
  if (c.commit) lines.push(`**Commit** · \`${String(c.commit).slice(0, 12)}\``);
  if (c.releaseDate) lines.push(`**Released** · ${formatDateTimeEn(c.releaseDate)}`);
  if (lines.length) comps.push(textDisplay(lines.join('\n')));

  if (c.releaseNotes) {
    comps.push(textDisplay(`**What's New**\n> ${String(c.releaseNotes).slice(0, 500).replace(/\n+/g, '\n> ')}`));
  }

  const buttons = [];
  if (c.platform === 'ios') {
    buttons.push(linkButton('App Store', c.storeUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`));
    if (c.channel === 'beta') buttons.push(linkButton('How to Join', TESTFLIGHT_URL));
  } else {
    buttons.push(linkButton('Google Play Store', PLAY_STORE_URL));
    if (c.channel === 'beta' || c.channel === 'alpha') {
      buttons.push(linkButton('APKMirror', APKMIRROR_UPLOADS_URL));
      buttons.push(linkButton('Aptoide', APTOIDE_VERSIONS_URL));
    }
  }
  if (buttons.length) comps.push({ type: 1, components: buttons.slice(0, 4) });

  comps.push(textDisplay(`-# Datamining · Mobile · ${c.platform === 'ios' ? 'iOS' : 'Android'} · ${trackName(c)}`));
  return comps;
}

/** Envoie un payload Components V2 (boutons inclus) sur la webhook. */
async function postComponents(components, accentColor) {
  if (!WEBHOOK_URL) return false;
  const messages = chunkIntoMessages(components, accentColor, true);
  const url = withComponentsUrl(WEBHOOK_URL);
  for (const componentsMsg of messages) {
    const r = await sendWebhook(url, {
      username: BOT_NAME,
      avatar_url: BOT_AVATAR,
      flags: IS_COMPONENTS_V2_FLAG,
      components: componentsMsg,
    }, { identity: 'mobile', label: 'mobile', timeoutMs: 30000, minGapMs: 200 });
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        throw new Error('Webhook HTTP ' + r.status);
      }
      throw new Error('Webhook failed after retries');
    }
  }
  return true;
}

/**
 * Envoie les notifs : 1 résumé sobre (embeds) puis 1 message
 * Components V2 par release, style tracker de releases.
 */
async function notify(changes) {
  if (!WEBHOOK_URL || !changes.length) return;

  // 1) Résumé — tous les bumps dans un seul message
  const summaryLines = changes.map((ch) => {
    const c = ch.channel;
    const plat = c.platform === 'ios' ? 'iOS' : 'Android';
    const arrow = ch.type === 'updated' && ch.previous
      ? `${ch.previous.version} → **${c.version}**`
      : `**${c.version}**`;
    return `**${plat} ${trackName(c)}** · ${arrow}${c.build ? ` · \`${c.build}\`` : ''}`;
  });

  await postWebhook({
    embeds: [
      {
        title: `Discord Mobile · ${changes.length} new version${changes.length > 1 ? 's' : ''}`,
        description: summaryLines.join('\n').slice(0, 4000),
        color: 0x5865f2,
        footer: { text: 'Datamining · Mobile · versions' },
      },
    ],
  });

  // 2) Un message Components V2 par release (boutons + icône)
  for (const ch of changes) {
    await postComponents(buildReleaseComponents(ch), colorFor(ch.channel.channel));
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
  console.log('Webhook:', WEBHOOK_URL ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
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
