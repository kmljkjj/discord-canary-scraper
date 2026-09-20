/**
 * Discord Shop / Collectibles tracker
 * Source: official API with user token (fresher than third-party mirrors)
 *
 * Env:
 *   SHOP_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   DISCORD_TOKEN | DISCORD_USER_TOKEN | DISCORD_USER_TOKEN_1
 *   ORBIT_BOT_NAME, ORBIT_AVATAR_URL
 *
 * Flow: FETCH (token) → NORMALIZE → COMPARE → NOTIFY → SAVE known ids (only after success)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'shop_items.json');

const WEBHOOK =
  process.env.SHOP_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;

const TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.DISCORD_USER_TOKEN ||
  process.env.DISCORD_USER_TOKEN_1 ||
  null;

const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/assets/datamining-avatar.jpg';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HOSTS = [
  'https://canary.discord.com/api/v9',
  'https://discord.com/api/v9',
];

const ITEM_TYPES = ['0', '1', '2', '3'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(msg) {
  return String(msg || '')
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{10,}/g, '[REDACTED]')
    .replace(/mfa\.[\w-]{20,}/gi, '[REDACTED]');
}

function authHeaders() {
  return {
    Authorization: TOKEN,
    'User-Agent': UA,
    Accept: 'application/json',
  };
}

async function apiGet(pathAndQuery) {
  let lastErr = null;
  for (const host of HOSTS) {
    const url = host + pathAndQuery;
    try {
      const res = await fetch(url, { headers: authHeaders(), timeout: 25000 });
      if (res.status === 401 || res.status === 403) {
        throw new Error('AUTH_FAILED HTTP ' + res.status);
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 3);
        await sleep(Math.min(20, ra) * 1000);
        continue;
      }
      if (!res.ok) {
        lastErr = 'HTTP ' + res.status;
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e.message;
      if (String(e.message).includes('AUTH_FAILED')) throw e;
    }
  }
  throw new Error(lastErr || 'apiGet failed');
}

function walkCollect(obj, out, depth = 0) {
  if (!obj || depth > 12) return;
  if (Array.isArray(obj)) {
    for (const x of obj) walkCollect(x, out, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;

  const sku =
    obj.sku_id ||
    obj.skuId ||
    (obj.sku && (obj.sku.id || obj.sku)) ||
    null;
  const name =
    obj.name ||
    obj.title ||
    (obj.sku && obj.sku.name) ||
    (obj.product && obj.product.name) ||
    null;

  if (sku && name) {
    const id = String(sku);
    if (!out.has(id)) {
      out.set(id, normalizeItem(obj, id, String(name)));
    }
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') walkCollect(v, out, depth + 1);
  }
}

function pickImage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = [
    'featured_block_url',
    'catalog_banner_url',
    'hero_banner_url',
    'mobile_banner_url',
    'logo_url',
    'pdp_bg_url',
    'thumbnail',
    'image',
    'asset',
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  if (Array.isArray(obj.items) && obj.items[0]) {
    const it = obj.items[0];
    if (it.asset && typeof it.asset === 'string') {
      if (/^https?:\/\//i.test(it.asset)) return it.asset;
      return (
        'https://cdn.discordapp.com/avatar-decoration-presets/' +
        it.asset.replace(/^\//, '') +
        '.png'
      );
    }
  }
  if (obj.sku_id) {
    return (
      'https://cdn.discordapp.com/media/v1/collectibles-shop/' +
      obj.sku_id +
      '/static'
    );
  }
  return null;
}

function normalizeItem(raw, id, name) {
  const type =
    raw.type != null
      ? raw.type
      : raw.product_type != null
        ? raw.product_type
        : raw.category_type != null
          ? raw.category_type
          : null;
  const summary =
    raw.summary || raw.description || (raw.sku && raw.sku.summary) || null;
  const image = pickImage(raw);
  let price = null;
  try {
    const prices = raw.prices || (raw.sku && raw.sku.prices) || null;
    if (prices && typeof prices === 'object') {
      const first = Object.values(prices)[0];
      if (first && first.amount != null) price = first;
      else if (Array.isArray(first) && first[0]) price = first[0];
    }
  } catch (_) {}
  return {
    id,
    name: String(name).slice(0, 200),
    type,
    summary: summary ? String(summary).slice(0, 400) : null,
    image,
    price,
    storeListingId: raw.store_listing_id || raw.storeListingId || null,
    source: 'collectibles',
  };
}

async function fetchShopCatalog() {
  const map = new Map();
  try {
    const data = await apiGet(
      '/collectibles-shop?tab=home&include_bundles=true&include_dynamic_blocks=true&variants_return_style=2',
    );
    walkCollect(data, map);
    console.log('collectibles-shop items:', map.size);
  } catch (e) {
    console.warn('collectibles-shop:', redact(e.message));
  }

  for (const itype of ITEM_TYPES) {
    try {
      const data = await apiGet(
        '/shop/search?item_types=' +
          itype +
          '&offset=0&limit=50&sort_type=1&sort_direction=desc',
      );
      walkCollect(data, map);
      await sleep(250);
    } catch (e) {
      console.warn('shop/search type', itype, redact(e.message));
    }
  }

  try {
    const data = await apiGet('/collectibles-categories');
    walkCollect(data, map);
  } catch (e) {
    console.warn('collectibles-categories:', redact(e.message));
  }

  return [...map.values()];
}

function buildEmbed(item) {
  const fields = [];
  if (item.type != null)
    fields.push({ name: 'Type', value: '`' + item.type + '`', inline: true });
  if (item.id)
    fields.push({ name: 'SKU', value: '`' + item.id + '`', inline: true });
  if (item.summary) {
    fields.push({ name: 'Description', value: item.summary.slice(0, 1024) });
  }
  return {
    author: { name: 'Boutique Discord · Nouvel item', icon_url: AVATAR },
    title: String(item.name).slice(0, 256),
    description: 'Nouvel article détecté dans la boutique collectibles.',
    color: 0x5865f2,
    fields,
    image: item.image ? { url: item.image } : undefined,
    thumbnail: item.image ? { url: item.image } : undefined,
    footer: { text: 'Shop tracker · token API' },
    timestamp: new Date().toISOString(),
  };
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  let last = { ok: true, status: 204, text: '' };
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: BOT.slice(0, 80),
        avatar_url: AVATAR,
        embeds: embeds.slice(i, i + 10),
      }),
    });
    const text = await res.text().catch(() => '');
    last = { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    if (!res.ok) return last;
    await sleep(500);
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA);
  console.log('🛒 Discord Shop tracker');
  console.log('Token:', TOKEN ? 'configured' : 'MISSING');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.SHOP_WEBHOOK_URL
        ? 'SHOP_WEBHOOK_URL'
        : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );

  if (!TOKEN) {
    console.error('DISCORD_TOKEN / DISCORD_USER_TOKEN required for shop catalog');
    process.exit(1);
  }

  let items = [];
  try {
    items = await fetchShopCatalog();
  } catch (e) {
    console.error('Shop fetch failed:', redact(e.message));
    process.exit(1);
  }
  console.log('Catalog items:', items.length);
  if (!items.length) {
    console.error('Empty catalog — abort (do not wipe state)');
    process.exit(1);
  }

  let prev = { ids: [], items: [], announced: {} };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const prevIds = new Set(prev.ids || []);
  const isFirst = prevIds.size === 0;

  const newItems = isFirst ? [] : items.filter((it) => !prevIds.has(it.id));
  console.log(isFirst ? 'Seed run — no notify' : 'New items: ' + newItems.length);

  const allIds = items.map((i) => i.id);

  if (isFirst) {
    await fs.writeJson(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        count: items.length,
        ids: allIds,
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          image: i.image,
        })),
        announced: {},
      },
      { spaces: 2 },
    );
    console.log('Seed', allIds.length, 'SKUs');
    return;
  }

  if (!newItems.length) {
    await fs.writeJson(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        count: items.length,
        ids: allIds,
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          image: i.image,
        })),
        announced: prev.announced || {},
      },
      { spaces: 2 },
    );
    console.log('No new shop items');
    return;
  }

  const toNotify = newItems.slice(0, 15);
  const embeds = toNotify.map(buildEmbed);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (!sent.ok) {
    console.warn('NOTIFY_FAIL shop — ids NOT marked; will retry next run');
    process.exitCode = 2;
    return;
  }

  const announced = { ...(prev.announced || {}) };
  for (const it of toNotify) {
    announced[it.id] = new Date().toISOString();
  }

  await fs.writeJson(
    STATE,
    {
      scrapedAt: new Date().toISOString(),
      count: items.length,
      ids: allIds,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        image: i.image,
      })),
      announced,
      lastNew: toNotify.map((i) => i.id),
    },
    { spaces: 2 },
  );
  console.log('✅ Shop done — announced', toNotify.length);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(redact(e.message || e));
    process.exit(1);
  });
}

module.exports = { main, fetchShopCatalog, normalizeItem };
