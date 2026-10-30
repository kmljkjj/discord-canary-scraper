/**
 * Watch @DiscordNEW8r → Discord webhook
 *
 * Secrets (priority):
 *   X_WEBHOOK_URL or X_NEWS_WEBHOOK_URL
 *   X_BEARER_TOKEN  ← strongly recommended (public RSS is mostly dead)
 *
 * Soft-exit 0 if no posts (never red the workflow).
 *
 * Tier x-cli « guest » (github.com/tamnd/x-cli, binaire installé par le
 * workflow via X_CLI_BIN) : lecture de la timeline sans compte X ni secret
 * en dehors du webhook.
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { sendEmbeds } = require('./lib/webhook');
const { writeJsonAtomic } = require('./lib/atomic');
const { DEFAULT_UA } = require('./lib/utils');
const { safeJson } = require('./lib/http');

const USERNAME = process.env.X_USERNAME || 'DiscordNEW8r';
const USER_ID = process.env.X_USER_ID || '2073982489836584960';
const WEBHOOK =
  process.env.X_WEBHOOK_URL ||
  process.env.X_NEWS_WEBHOOK_URL ||
  process.env.DISCORD_X_WEBHOOK_URL ||
  '';
const BEARER =
  process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';

// Tier x-cli (github.com/tamnd/x-cli) : timeline en mode « guest » — aucun compte X
// requis, aucun secret. Le binaire est installé par le workflow (env X_CLI_BIN).
// Sortie JSONL : 1 tweet par ligne, id/text/created_at/media au premier niveau.
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const X_CLI_BIN = process.env.X_CLI_BIN || 'x';

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'x_seen_ids.json');
const MAX_SEEN = 300;
const MAX_NOTIFY = 5;

const RSS_SOURCES = [
  `https://rsshub.rssforever.com/twitter/user/${USERNAME}`,
  `https://rsshub.app/twitter/user/${USERNAME}`,
  `https://nitter.privacyredirect.com/${USERNAME}/rss`,
  `https://nitter.poast.org/${USERNAME}/rss`,
  `https://xcancel.com/${USERNAME}/rss`,
];

// Lit la page publique « timeline-profile » de la syndication X (tier 0 :
// aucune auth, aucun binaire). Le HTML embarque un blob __NEXT_DATA__ dont
// les entrées sont les tweets récents du compte.
function parseSyndicationProfile(html, screenName) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const entries =
    (data && data.props && data.props.pageProps && data.props.pageProps.timeline && data.props.pageProps.timeline.entries) ||
    [];
  const out = [];
  const seenIds = new Set();
  for (const e of entries) {
    const t = e && e.content && e.content.tweet;
    if (!t || !t.id_str) continue;
    const id = String(t.id_str);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    let image = null;
    const media =
      (t.extended_entities && t.extended_entities.media) ||
      (t.entities && t.entities.media) ||
      [];
    if (media[0]) image = media[0].media_url_https || null;
    out.push({
      id,
      text: String(t.full_text || t.text || ''),
      url: 'https://x.com/' + screenName + '/status/' + id,
      date: t.created_at ? new Date(t.created_at).toISOString() : null,
      image,
    });
  }
  return out;
}

// La page « timeline-profile » est publique (aucune auth), mais les IP des
// runners GitHub sont partagées : le budget X (30 req/fenêtre/IP) y est
// épuisé en permanence par d'autres utilisateurs. On tente donc dans
// l'ordre : direct, puis deux relais publics (chacun a sa propre IP),
// avant de renoncer — le cron réessaiera 10 min plus tard.
async function fetchSyndicationHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      timeout: 25000,
    });
    if (!res.ok) {
      console.warn('syndication', res.status, '·', String(url).slice(0, 80));
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn('syndication fail:', e.message || e);
    return null;
  }
}

async function fetchViaSyndication() {
  const target = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/' + USERNAME;
  const routes = [
    { name: 'direct', url: target },
    {
      name: 'allorigins',
      url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target),
    },
    {
      name: 'codetabs',
      url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(target),
    },
  ];
  for (const route of routes) {
    const html = await fetchSyndicationHtml(route.url);
    if (html == null) continue;
    const posts = parseSyndicationProfile(html, USERNAME);
    console.log(
      'syndication', route.name + ':', posts.length, 'posts · html',
      html.length, 'B · NEXT_DATA:', html.includes('__NEXT_DATA__'),
    );
    if (posts.length) return posts;
  }
  return [];
}
// Convertit la sortie JSONL de « x timeline <handle> --guest -o jsonl » en posts
// internes { id, text, url, date, image }. Ignore lignes vides/invalides,
// ids non numériques ou trop courts, et doublons.
function parseXcliJsonl(stdout, screenName) {
  const out = [];
  const seenIds = new Set();
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    const id = String(t.id || '').trim();
    if (!/^\d{10,}$/.test(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    let image = null;
    const media = Array.isArray(t.media) ? t.media : [];
    if (media[0]) image = media[0].preview_image || media[0].url || null;
    out.push({
      id,
      text: String(t.text || ''),
      url: 'https://x.com/' + screenName + '/status/' + id,
      date: t.created_at || null,
      image,
    });
  }
  return out;
}

// Lecture de la timeline via x-cli en mode guest (aucun secret requis).
async function fetchViaXcli() {
  try {
    const { stdout } = await execFileP(X_CLI_BIN, [
      'timeline', USERNAME, '--guest', '-n', '20', '-o', 'jsonl',
    ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return parseXcliJsonl(stdout, USERNAME);
  } catch (e) {
    console.warn('x-cli fail:', String(e.message || e).slice(0, 300));
    return [];
  }
}

async function main() {
  console.log('=== X Watch @' + USERNAME + ' ===');
  if (!WEBHOOK) {
    console.warn('Missing X webhook secret — soft skip');
    process.exit(0);
  }

  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  console.log('Seen ids:', seen.size);

  let posts = [];

  if (BEARER) {
    try {
      console.log('Source: X API v2 (bearer)');
      posts = await fetchViaOfficialApi(BEARER);
      console.log('API posts:', posts.length);
    } catch (e) {
      console.warn('API fail:', e.message);
    }
  } else {
    console.log('No X_BEARER_TOKEN — public sources often fail');
  }

  if (posts.length < 1) {
    posts = await fetchViaSyndication();
    console.log('syndication posts:', posts.length);
  }

  if (posts.length < 1) {
    posts = await fetchViaXcli();
    console.log('x-cli guest posts:', posts.length);
  }

  if (posts.length < 1) {
    posts = await fetchViaRss();
    console.log('RSS posts:', posts.length);
  }

  if (!posts.length) {
    console.warn(
      'No posts fetched (soft). Add secret X_BEARER_TOKEN for reliable X watch.',
    );
    process.exit(0);
  }

  posts.sort((a, b) => String(b.id).localeCompare(String(a.id)));

  const isFirstRun = seen.size === 0;
  const fresh = posts.filter((p) => p.id && !seen.has(String(p.id)));

  console.log('Fresh:', fresh.length, isFirstRun ? '(seed only)' : '');

  if (isFirstRun) {
    for (const p of posts) seen.add(String(p.id));
    await saveSeen(seen);
    console.log('Seeded', seen.size, 'ids — no webhook');
    return;
  }

  const toSend = fresh.slice(0, MAX_NOTIFY);
  let sentOk = 0;
  let sentFail = 0;
  for (const p of toSend) {
    const ok = await postWebhook(p);
    if (ok) {
      seen.add(String(p.id));
      sentOk++;
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL x post', p.id, '- will retry next run');
    }
  }
  // Do NOT mark unsent fresh posts as seen
  await saveSeen(seen);
  console.log('Done. Sent', sentOk, 'failed', sentFail, 'pending', fresh.length - sentOk);
  if (sentFail > 0 && sentOk === 0 && toSend.length > 0) {
    process.exitCode = 2;
  }
}

async function fetchViaOfficialApi(bearer) {
  // Resolve user id if needed
  let uid = USER_ID;
  try {
    const uRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${USERNAME}`,
      {
        headers: { Authorization: 'Bearer ' + bearer, 'User-Agent': 'orbit-x-watch' },
        timeout: 15000,
      },
    );
    if (uRes.ok) {
      const uj = await safeJson(uRes);
      if (uj && uj.data && uj.data.id) uid = String(uj.data.id);
    }
  } catch (e) {
    console.warn('username lookup fail, using env USER_ID');
  }

  const url =
    `https://api.twitter.com/2/users/${uid}/tweets` +
    `?max_results=10` +
    `&tweet.fields=created_at,text,entities,attachments` +
    `&expansions=attachments.media_keys` +
    `&media.fields=url,preview_image_url,type`;

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + bearer,
      'User-Agent': 'orbit-x-watch',
    },
    timeout: 20000,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(res.status + ' ' + t.slice(0, 180));
  }
  const data = await safeJson(res);
  if (!data) throw new Error('réponse JSON invalide');
  const mediaMap = {};
  for (const m of (data.includes && data.includes.media) || []) {
    mediaMap[m.media_key] = m.url || m.preview_image_url || null;
  }
  const out = [];
  for (const t of data.data || []) {
    let image = null;
    if (t.attachments && t.attachments.media_keys) {
      for (const k of t.attachments.media_keys) {
        if (mediaMap[k]) {
          image = mediaMap[k];
          break;
        }
      }
    }
    out.push({
      id: String(t.id),
      text: t.text || '',
      url: `https://x.com/${USERNAME}/status/${t.id}`,
      date: t.created_at || null,
      image,
    });
  }
  return out;
}

async function fetchViaRss() {
  const posts = [];
  for (const src of RSS_SOURCES) {
    try {
      const res = await fetch(src, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: 12000,
      });
      if (!res.ok) {
        console.warn('RSS', src, res.status);
        continue;
      }
      const xml = await res.text();
      if (
        /whitelist|cloudflare|Attention Required|not yet whitelist|Making sure you're not a bot/i.test(
          xml,
        ) &&
        !/<item[\s>]/i.test(xml)
      ) {
        console.warn('RSS blocked', src);
        continue;
      }
      // Skip fake whitelist items
      if (/RSS reader not yet whitelist/i.test(xml) && !/status\/\d{10,}/i.test(xml)) {
        console.warn('RSS whitelist-only', src);
        continue;
      }
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      for (const m of items) {
        const block = m[1];
        const link = pick(block, /<link>([^<]+)<\/link>/i);
        const title = decodeXml(pick(block, /<title>([^<]+)<\/title>/i) || '');
        const guid = pick(block, /<guid[^>]*>([^<]+)<\/guid>/i) || link;
        const date = pick(block, /<pubDate>([^<]+)<\/pubDate>/i);
        const id = extractStatusId(link || guid || '');
        if (!id) continue;
        if (/whitelist/i.test(title)) continue;
        posts.push({
          id,
          url: `https://x.com/${USERNAME}/status/${id}`,
          text: stripHtml(title).slice(0, 400),
          date: date ? new Date(date).toISOString() : null,
        });
      }
      if (posts.length) {
        console.log('RSS ok', src, posts.length);
        break;
      }
    } catch (e) {
      console.warn('RSS', src, e.message);
    }
  }
  return dedupe(posts);
}

async function postWebhook(p) {
  const url = p.url || `https://x.com/${USERNAME}/status/${p.id}`;
  const text = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const body = {
    username: 'Datamining · X',
    avatar_url:
      'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4f0.png',
    content: url,
    embeds: [
      {
        author: {
          name: '@' + USERNAME,
          url: `https://x.com/${USERNAME}`,
          icon_url:
            'https://pbs.twimg.com/profile_images/2088274756466286592/ZU7Jl8B-_normal.jpg',
        },
        description: text || undefined,
        url,
        color: 0x1da1f2,
        footer: { text: 'X · @' + USERNAME },
        timestamp: p.date || new Date().toISOString(),
      },
    ],
  };
  if (p.image) body.embeds[0].image = { url: p.image };
  const embeds = body.embeds || [];
  const base = { username: body.username || 'Datamining · X', avatar_url: body.avatar_url };
  const r = await sendEmbeds(WEBHOOK, base, embeds, { identity: 'x', label: 'x-watch ' + p.id, withDismiss: true });
  console.log('webhook', r.status, p.id);
  return r.ok;
}

async function loadSeen() {
  const set = new Set();
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      for (const id of d.ids || []) set.add(String(id));
    }
    // also merge legacy seen_x_posts.json
    const legacy = path.join(DATA, 'seen_x_posts.json');
    if (await fs.pathExists(legacy)) {
      const d = await fs.readJson(legacy);
      for (const id of d.ids || []) set.add(String(id));
    }
  } catch (e) {
    console.warn('loadSeen: failed to read legacy seen file -', e.message);
  }
  return set;
}

async function saveSeen(set) {
  const ids = [...set].sort().slice(-MAX_SEEN);
  await writeJsonAtomic(
    SEEN_FILE,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    2,
  );
}

function extractStatusId(s) {
  const m =
    String(s).match(/status\/(\d{5,})/i) || String(s).match(/(\d{15,})/);
  return m ? m[1] : null;
}

function pick(block, re) {
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupe(posts) {
  const map = new Map();
  for (const p of posts) {
    if (p && p.id) map.set(String(p.id), p);
  }
  return [...map.values()];
}


if (require.main === module) {
  main().catch((e) => {
    console.error('X watch error:', e.message || e);
    process.exit(1);
  });
}

module.exports = { parseXcliJsonl, parseSyndicationProfile };
