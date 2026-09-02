/**
 * Watch @DiscordNEW8r on X — post new tweet links to Discord webhook.
 *
 * Secret: X_WEBHOOK_URL (or DISCORD_X_WEBHOOK_URL)
 * State: data/x_seen_ids.json
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const USERNAME = process.env.X_USERNAME || 'DiscordNEW8r';
const WEBHOOK =
  process.env.X_WEBHOOK_URL ||
  process.env.DISCORD_X_WEBHOOK_URL ||
  '';
const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'x_seen_ids.json');
const MAX_SEEN = 200;
const MAX_NOTIFY = 5; // per run

// Public X bearer used by the web client (not a secret user token)
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const RSS_SOURCES = [
  `https://nitter.space/${USERNAME}/rss`,
  `https://nitter.privacyredirect.com/${USERNAME}/rss`,
  `https://nitter.1d4.us/${USERNAME}/rss`,
  `https://rsshub.rssforever.com/twitter/user/${USERNAME}`,
  `https://rsshub.pseudoyu.com/twitter/user/${USERNAME}`,
];

async function main() {
  console.log('=== X Watch @' + USERNAME + ' ===');
  if (!WEBHOOK) {
    console.error('Missing X_WEBHOOK_URL secret — abort');
    process.exit(1);
  }

  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  console.log('Seen ids:', seen.size);

  let posts = [];
  // 1) Guest GraphQL (best when it works)
  try {
    posts = await fetchViaGuestApi();
    console.log('Guest API posts:', posts.length);
  } catch (e) {
    console.warn('Guest API fail:', e.message);
  }

  // 2) RSS mirrors
  if (posts.length < 1) {
    posts = await fetchViaRss();
    console.log('RSS posts:', posts.length);
  }

  // 3) Lightweight HTML scrape of x.com profile (last resort)
  if (posts.length < 1) {
    try {
      posts = await fetchViaHtml();
      console.log('HTML posts:', posts.length);
    } catch (e) {
      console.warn('HTML fail:', e.message);
    }
  }

  if (!posts.length) {
    console.error('No posts fetched from any source');
    process.exit(1);
  }

  // Newest first
  posts.sort((a, b) => String(b.id).localeCompare(String(a.id)));

  const isFirstRun = seen.size === 0;
  const fresh = [];
  for (const p of posts) {
    if (!p.id || seen.has(String(p.id))) continue;
    fresh.push(p);
  }

  console.log('Fresh:', fresh.length, isFirstRun ? '(first run → seed only)' : '');

  if (isFirstRun) {
    // Seed without flooding the channel
    for (const p of posts) seen.add(String(p.id));
    await saveSeen(seen);
    console.log('Seeded', seen.size, 'ids — no webhook');
    return;
  }

  const toSend = fresh.slice(0, MAX_NOTIFY);
  for (const p of toSend) {
    await postWebhook(p);
    seen.add(String(p.id));
  }
  // Mark any other fresh as seen so we don't backlog later
  for (const p of fresh) seen.add(String(p.id));
  await saveSeen(seen);
  console.log('Done. Sent', toSend.length);
}

async function loadSeen() {
  const set = new Set();
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      for (const id of d.ids || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function saveSeen(set) {
  const ids = [...set].sort().slice(-MAX_SEEN);
  await fs.writeJson(
    SEEN_FILE,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    { spaces: 2 },
  );
}

async function postWebhook(p) {
  const url = p.url || `https://x.com/${USERNAME}/status/${p.id}`;
  const text = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const body = {
    username: 'X · DiscordNEW8r',
    content: url,
    embeds: [
      {
        author: {
          name: '@' + USERNAME,
          url: `https://x.com/${USERNAME}`,
          icon_url:
            'https://pbs.twimg.com/profile_images/2088274756466286592/ZU7Jl8B-.jpg',
        },
        description: text || undefined,
        url,
        color: 0x1da1f2,
        footer: { text: 'X watcher · discord-canary-scraper' },
        timestamp: p.date || new Date().toISOString(),
      },
    ],
  };
  if (p.image) {
    body.embeds[0].image = { url: p.image };
  }
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('webhook', res.status, p.id);
    if (!res.ok) console.warn(await res.text());
  } catch (e) {
    console.warn('webhook error', e.message);
  }
  await sleep(500);
}

// ── Sources ───────────────────────────────────────────

async function fetchViaRss() {
  const posts = [];
  for (const src of RSS_SOURCES) {
    try {
      const res = await fetch(src, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        timeout: 15000,
      });
      if (!res.ok) {
        console.warn('RSS', src, res.status);
        continue;
      }
      const xml = await res.text();
      if (/whitelist|cloudflare|Attention Required/i.test(xml) && !/<item/i.test(xml))
        continue;
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      for (const m of items) {
        const block = m[1];
        const link = pick(block, /<link>([^<]+)<\/link>/i);
        const title = decodeXml(pick(block, /<title>([^<]+)<\/title>/i) || '');
        const desc = decodeXml(pick(block, /<description>([\s\S]*?)<\/description>/i) || '');
        const guid = pick(block, /<guid[^>]*>([^<]+)<\/guid>/i) || link;
        const date = pick(block, /<pubDate>([^<]+)<\/pubDate>/i);
        const id = extractStatusId(link || guid || '');
        if (!id) continue;
        posts.push({
          id,
          url: `https://x.com/${USERNAME}/status/${id}`,
          text: stripHtml(title || desc).slice(0, 400),
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

async function fetchViaGuestApi() {
  // Activate guest
  const gtRes = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + BEARER,
      'User-Agent': UA,
    },
    timeout: 15000,
  });
  if (!gtRes.ok) throw new Error('guest activate ' + gtRes.status);
  const { guest_token } = await gtRes.json();
  if (!guest_token) throw new Error('no guest_token');

  // User by screen name
  const userUrl =
    'https://api.twitter.com/graphql/G3KFjX99QRVbM1zKs_UNHA/UserByScreenName?' +
    new URLSearchParams({
      variables: JSON.stringify({
        screen_name: USERNAME,
        withSafetyModeUserFields: true,
      }),
      features: JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      }),
    });

  const userRes = await fetch(userUrl, {
    headers: {
      Authorization: 'Bearer ' + BEARER,
      'x-guest-token': guest_token,
      'User-Agent': UA,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
    timeout: 15000,
  });
  if (!userRes.ok) throw new Error('user ' + userRes.status);
  const userJson = await userRes.json();
  const restId =
    userJson?.data?.user?.result?.rest_id ||
    userJson?.data?.user?.result?.id;
  if (!restId) throw new Error('no rest_id');

  // User tweets timeline
  const tlUrl =
    'https://api.twitter.com/graphql/V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets?' +
    new URLSearchParams({
      variables: JSON.stringify({
        userId: restId,
        count: 20,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true,
      }),
      features: JSON.stringify({
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        articles_preview_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        tweet_awards_web_tipping_enabled: false,
        creator_subscriptions_quote_tweet_preview_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        rweb_video_timestamps_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      }),
    });

  const tlRes = await fetch(tlUrl, {
    headers: {
      Authorization: 'Bearer ' + BEARER,
      'x-guest-token': guest_token,
      'User-Agent': UA,
      'x-twitter-active-user': 'yes',
    },
    timeout: 20000,
  });
  if (!tlRes.ok) throw new Error('timeline ' + tlRes.status);
  const tl = await tlRes.json();

  const posts = [];
  const instructions =
    tl?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
    tl?.data?.user?.result?.timeline?.timeline?.instructions ||
    [];

  for (const inst of instructions) {
    const entries = inst.entries || [];
    for (const en of entries) {
      const t =
        en?.content?.itemContent?.tweet_results?.result ||
        en?.content?.itemContent?.tweet_results?.result?.tweet;
      if (!t || !t.rest_id) continue;
      const legacy = t.legacy || t.tweet?.legacy || {};
      const text = legacy.full_text || legacy.text || '';
      let image = null;
      const media = legacy.entities?.media || legacy.extended_entities?.media;
      if (media && media[0] && media[0].media_url_https)
        image = media[0].media_url_https;
      posts.push({
        id: String(t.rest_id),
        url: `https://x.com/${USERNAME}/status/${t.rest_id}`,
        text,
        image,
        date: legacy.created_at
          ? new Date(legacy.created_at).toISOString()
          : null,
      });
    }
  }
  return dedupe(posts);
}

async function fetchViaHtml() {
  const res = await fetch(`https://x.com/${USERNAME}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
    },
    timeout: 20000,
  });
  if (!res.ok) throw new Error('html ' + res.status);
  const html = await res.text();
  const ids = new Set();
  const re = new RegExp(
    `/(?:${USERNAME}|i)/status/(\d{5,})`,
    'gi',
  );
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  // also bare status links
  const re2 = /status\/(\d{15,})/g;
  while ((m = re2.exec(html)) !== null) ids.add(m[1]);
  return [...ids].map((id) => ({
    id,
    url: `https://x.com/${USERNAME}/status/${id}`,
    text: '',
    date: null,
  }));
}

// ── helpers ───────────────────────────────────────────

function extractStatusId(s) {
  const m = String(s).match(/status\/(\d{5,})/i) || String(s).match(/(\d{15,})/);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
