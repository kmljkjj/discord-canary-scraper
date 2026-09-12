/**
 * Watch @DiscordNEW8r on X → Discord webhook
 *
 * REQUIRED for reliability:
 *   Secrets → X_BEARER_TOKEN  (X Developer Portal → Bearer Token)
 *   Secrets → X_NEWS_WEBHOOK_URL
 *
 * Without X_BEARER_TOKEN, public RSS/Nitter are almost always blocked in 2026
 * and new posts will NOT be detected.
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'seen_x_posts.json');
const SCREEN_NAME = process.env.X_SCREEN_NAME || 'DiscordNEW8r';
const USER_ID = process.env.X_USER_ID || '2073982489836584960';
const WEBHOOK =
  process.env.X_NEWS_WEBHOOK_URL ||
  process.env.X_WEBHOOK_URL ||
  process.env.DISCORD_X_WEBHOOK_URL ||
  '';
const BEARER =
  process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
const MAX_NOTIFY = 8;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const RSS_MIRRORS = [
  `https://rsshub.rssforever.com/twitter/user/${SCREEN_NAME}`,
  `https://rsshub.app/twitter/user/${SCREEN_NAME}`,
  `https://nitter.privacyredirect.com/${SCREEN_NAME}/rss`,
  `https://nitter.poast.org/${SCREEN_NAME}/rss`,
  `https://xcancel.com/${SCREEN_NAME}/rss`,
];

async function main() {
  console.log('=== X News Watch · @' + SCREEN_NAME + ' ===');
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Bearer:', BEARER ? 'set (' + BEARER.slice(0, 8) + '…)' : 'MISSING');

  if (!WEBHOOK) {
    console.warn('Missing X_NEWS_WEBHOOK_URL — soft skip');
    process.exit(0);
  }

  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  console.log('Seen posts:', seen.ids.length);

  let posts = [];
  let source = 'none';

  if (BEARER) {
    try {
      posts = await fetchFromApi(BEARER);
      if (posts.length) source = 'x-api-v2';
    } catch (e) {
      console.warn('API error', e.message);
    }
  } else {
    console.warn(
      '⚠️  No X_BEARER_TOKEN secret — public RSS almost always fails. Add it in GitHub → Settings → Secrets.',
    );
  }

  if (!posts.length) {
    posts = await fetchFromRss();
    if (posts.length) source = 'rss';
  }

  console.log('Fetched', posts.length, 'posts via', source);
  if (!posts.length) {
    console.warn(
      'No posts fetched. Action required: add secret X_BEARER_TOKEN from https://developer.x.com',
    );
    // Soft exit — do not red the workflow, but do not touch seen file
    process.exit(0);
  }

  // First run: seed only
  if (!seen.ids.length) {
    seen.ids = uniq(posts.map((p) => p.id)).slice(-300);
    await saveSeen(seen);
    console.log('Seeded', seen.ids.length, 'ids — no notify on first run');
    return;
  }

  const known = new Set(seen.ids.map(String));
  const fresh = posts
    .filter((p) => p.id && !known.has(String(p.id)))
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));

  console.log('New posts:', fresh.length);
  if (!fresh.length) {
    console.log('Nothing new');
    return;
  }

  let sent = 0;
  for (const p of fresh.slice(0, MAX_NOTIFY)) {
    const ok = await postWebhook(p);
    if (ok) {
      known.add(String(p.id));
      seen.ids.push(String(p.id));
      sent++;
      await sleep(400);
    } else {
      console.warn('Webhook failed for', p.id, '— will retry next run');
      // do NOT mark as seen
    }
  }

  seen.ids = uniq(seen.ids).slice(-300);
  await saveSeen(seen);
  console.log('Sent', sent, '/', fresh.length, '· seen now', seen.ids.length);
}

async function fetchFromApi(bearer) {
  let uid = USER_ID;
  try {
    const uRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${SCREEN_NAME}`,
      {
        headers: {
          Authorization: 'Bearer ' + bearer,
          'User-Agent': 'canary-x-news',
        },
        timeout: 15000,
      },
    );
    if (uRes.ok) {
      const uj = await uRes.json();
      if (uj.data && uj.data.id) {
        uid = String(uj.data.id);
        console.log('Resolved user id', uid);
      }
    } else {
      console.warn('username lookup', uRes.status, (await uRes.text()).slice(0, 120));
    }
  } catch (e) {
    console.warn('username lookup fail', e.message);
  }

  const url =
    `https://api.twitter.com/2/users/${uid}/tweets` +
    `?max_results=10` +
    `&exclude=replies` +
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
    throw new Error('API ' + res.status + ' ' + t.slice(0, 250));
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
        headers: {
          'User-Agent': UA,
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: 12000,
      });
      if (!res.ok) {
        console.warn('RSS', res.status, url);
        continue;
      }
      const xml = await res.text();
      if (
        /not yet whitelist|Error 404|403 Forbidden|Making sure you're not a bot|Attention Required|cloudflare/i.test(
          xml,
        ) &&
        !/status\/\d{10,}/i.test(xml)
      ) {
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
    if (/whitelist/i.test(title)) continue;
    const link = strip(pick(block, 'link')) || strip(pick(block, 'guid'));
    if (!link) continue;
    const idMatch =
      link.match(/status\/(\d+)/) ||
      link.match(/statuses\/(\d+)/) ||
      (pick(block, 'guid') || '').match(/(\d{15,})/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) continue;
    items.push({
      id: String(id),
      text: title || '',
      url: `https://x.com/${SCREEN_NAME}/status/${id}`,
      createdAt: strip(pick(block, 'pubDate')) || null,
      image: null,
    });
  }
  return items;
}

function pick(block, tag) {
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
        username: 'Datamining · X',
        embeds: [embed],
        content: p.url,
      }),
      timeout: 15000,
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
  try {
    const alt = path.join(DATA, 'x_seen_ids.json');
    if (await fs.pathExists(alt)) {
      const d = await fs.readJson(alt);
      return { ids: (d.ids || []).map(String) };
    }
  } catch {}
  return { ids: [] };
}

async function saveSeen(seen) {
  await writeJsonAtomic(SEEN_FILE, {
    updatedAt: new Date().toISOString(),
    ids: seen.ids,
  });
}

function uniq(arr) {
  return [...new Set(arr.map(String))];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.warn('X news soft error:', e.message || e);
  process.exit(0);
});
