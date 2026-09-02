/**
 * Watch @DiscordNEW8r on X → Discord webhook
 *
 * Secrets:
 *   X_NEWS_WEBHOOK_URL  — Discord webhook (required)
 *   X_BEARER_TOKEN      — Twitter/X API v2 Bearer (recommended)
 *
 * Without X_BEARER_TOKEN, tries public RSS mirrors (often unreliable).
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'seen_x_posts.json');
const SCREEN_NAME = process.env.X_SCREEN_NAME || 'DiscordNEW8r';
const USER_ID = process.env.X_USER_ID || '2073982489836584960'; // DiscordNEW8r
const WEBHOOK = process.env.X_NEWS_WEBHOOK_URL || process.env.DISCORD_X_WEBHOOK_URL;
const BEARER = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;
const MAX_NOTIFY = 5;

const RSS_MIRRORS = [
  `https://nitter.poast.org/${SCREEN_NAME}/rss`,
  `https://nitter.privacyredirect.com/${SCREEN_NAME}/rss`,
  `https://nitter.lucabased.xyz/${SCREEN_NAME}/rss`,
  `https://xcancel.com/${SCREEN_NAME}/rss`,
];

async function main() {
  console.log('=== X News Watch · @' + SCREEN_NAME + ' ===');
  if (!WEBHOOK) {
    console.error('Missing X_NEWS_WEBHOOK_URL secret');
    process.exit(1);
  }

  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  console.log('Seen posts:', seen.ids.length);

  let posts = [];
  if (BEARER) {
    console.log('Source: X API v2');
    posts = await fetchFromApi(BEARER);
  } else {
    console.log('No X_BEARER_TOKEN — trying RSS mirrors');
    posts = await fetchFromRss();
  }

  console.log('Fetched', posts.length, 'posts');
  if (!posts.length) {
    console.warn('No posts fetched — check token / RSS');
    process.exit(0);
  }

  // First run: seed all, no flood
  if (!seen.ids.length) {
    for (const p of posts) seen.ids.push(p.id);
    seen.ids = uniq(seen.ids).slice(-200);
    await saveSeen(seen);
    console.log('Seeded', seen.ids.length, 'ids — no notify');
    return;
  }

  const known = new Set(seen.ids.map(String));
  const fresh = posts.filter((p) => !known.has(String(p.id)));
  // API returns newest first
  fresh.sort((a, b) => String(b.id).localeCompare(String(a.id)));

  console.log('New posts:', fresh.length);

  let sent = 0;
  for (const p of fresh.slice(0, MAX_NOTIFY)) {
    const ok = await postWebhook(p);
    if (ok) {
      known.add(String(p.id));
      sent++;
      await sleep(400);
    }
  }

  for (const p of posts) known.add(String(p.id));
  seen.ids = uniq([...known]).slice(-200);
  await saveSeen(seen);
  console.log('Sent', sent, '· seen now', seen.ids.length);
}

async function fetchFromApi(bearer) {
  const url =
    `https://api.twitter.com/2/users/${USER_ID}/tweets` +
    `?max_results=10` +
    `&tweet.fields=created_at,text,entities,attachments` +
    `&expansions=attachments.media_keys` +
    `&media.fields=url,preview_image_url,type`;

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + bearer,
      'User-Agent': 'canary-x-news',
    },
    timeout: 25000,
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('API', res.status, t.slice(0, 300));
    // fallback RSS
    return fetchFromRss();
  }
  const data = await res.json();
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
      url: `https://x.com/${SCREEN_NAME}/status/${t.id}`,
      createdAt: t.created_at || null,
      image,
    });
  }
  return out;
}

async function fetchFromRss() {
  for (const url of RSS_MIRRORS) {
    try {
      console.log('RSS try', url);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 canary-x-news', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        timeout: 15000,
      });
      if (!res.ok) {
        console.warn('RSS', res.status, url);
        continue;
      }
      const xml = await res.text();
      if (/not yet whitelisted|Error 404|403 Forbidden/i.test(xml)) {
        console.warn('RSS blocked', url);
        continue;
      }
      const posts = parseRss(xml);
      if (posts.length) {
        console.log('RSS OK', posts.length, 'from', url);
        return posts;
      }
    } catch (e) {
      console.warn('RSS fail', url, e.message);
    }
  }
  return [];
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const block of blocks) {
    const title = strip(pick(block, 'title'));
    const link = strip(pick(block, 'link')) || strip(pick(block, 'guid'));
    if (!link) continue;
    const idMatch =
      link.match(/status\/(\d+)/) ||
      link.match(/statuses\/(\d+)/) ||
      (pick(block, 'guid') || '').match(/(\d{15,})/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) continue;
    // Normalize to x.com link
    const url = `https://x.com/${SCREEN_NAME}/status/${id}`;
    items.push({
      id: String(id),
      text: title || '',
      url,
      createdAt: strip(pick(block, 'pubDate')) || null,
      image: null,
    });
  }
  return items;
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(
    new RegExp(
      '<' +
        tag +
        '[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</' +
        tag +
        '>',
      'i',
    ),
  );
  if (!m) return '';
  return m[1] != null && m[1] !== '' ? m[1] : m[2] || '';
}

function strip(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function postWebhook(p) {
  const text = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 350);
  const embed = {
    author: {
      name: '@' + SCREEN_NAME,
      url: 'https://x.com/' + SCREEN_NAME,
      icon_url:
        'https://pbs.twimg.com/profile_images/2088274756466286592/ZU7Jl8B-_normal.jpg',
    },
    title: 'Nouveau post',
    url: p.url,
    description: text ? text + '\n\n' + p.url : p.url,
    color: 0x1da1f2,
    footer: { text: 'X · @' + SCREEN_NAME },
    timestamp: p.createdAt
      ? new Date(p.createdAt).toISOString()
      : new Date().toISOString(),
  };
  if (p.image) embed.image = { url: p.image };

  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'X · DiscordNEW8r',
        embeds: [embed],
        content: p.url, // lien clair dans le salon
      }),
    });
    console.log('webhook', res.status, p.id);
    if (!res.ok) console.warn(await res.text());
    return res.ok;
  } catch (e) {
    console.warn('webhook error', e.message);
    return false;
  }
}

async function loadSeen() {
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      return { ids: (d.ids || []).map(String) };
    }
  } catch {}
  return { ids: [] };
}

async function saveSeen(seen) {
  await fs.writeJson(
    SEEN_FILE,
    { updatedAt: new Date().toISOString(), ids: seen.ids },
    { spaces: 2 },
  );
}

function uniq(arr) {
  return [...new Set(arr.map(String))];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
