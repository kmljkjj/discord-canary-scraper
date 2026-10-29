/**
 * Actus générales → Discord webhook
 *
 * Catégories : monde · réseaux sociaux · football · iPhone & Android · Spotify
 * Sources : flux RSS publics uniquement — aucune API, aucun token.
 *   monde           : BBC World, Al Jazeera, Google News FR
 *   réseaux sociaux : TechCrunch Social, Google News FR
 *   football        : BBC Sport, Sky Sports, Google News FR
 *   iPhone & Android : iPhon.fr, Frandroid, 9to5Mac, 9to5Google
 *   Spotify         : Google News FR + EN
 *
 * Consigne du salon : informations importantes, PAS de politique →
 * blocklist anti-politique (globale + spécifique « monde »).
 *
 * Anti-spam : 1 actu = 1 message, mais plafonds par run — total, par
 * catégorie, par source. Tout ce qui n'est pas retenu est marqué vu :
 * pas de rattrapage différé au run suivant.
 *
 * Secret : NEWS_WEBHOOK_URL (soft-exit 0 s'il n'existe pas).
 * État : data/seen_news.json (commité par le workflow).
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { createHash } = require('crypto');
const { sendEmbeds } = require('./lib/webhook');
const { writeJsonAtomic } = require('./lib/atomic');
const { fetchTextWithRetry } = require('./lib/http');
const { DEFAULT_UA } = require('./lib/utils');

const WEBHOOK = process.env.NEWS_WEBHOOK_URL || '';

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'seen_news.json');
const MAX_SEEN = 800;

// Anti-spam — plafonds par run (le workflow tourne toutes les 10 minutes)
const MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 6);
const MAX_PER_CATEGORY = Number(process.env.NEWS_MAX_PER_CATEGORY || 2);
const MAX_PER_SOURCE = Number(process.env.NEWS_MAX_PER_SOURCE || 2);
const MAX_AGE_HOURS = Number(process.env.NEWS_MAX_AGE_HOURS || 12);

const CATEGORY = {
  monde: { label: 'Monde', color: 0x5865f2, identity: 'newsMonde' },
  social: { label: 'Réseaux sociaux', color: 0xeb459e, identity: 'newsSocial' },
  foot: { label: 'Football', color: 0x57f287, identity: 'newsFoot' },
  tech: { label: 'iPhone & Android', color: 0x3498db, identity: 'newsTech' },
  spotify: { label: 'Spotify', color: 0x1db954, identity: 'newsSpotify' },
};

const googleNews = (q, lang) =>
  lang === 'fr'
    ? 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=fr&gl=FR&ceid=FR:fr'
    : 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';

const SOURCES = [
  // Monde (hors politique, voir POLITICS_*)
  { id: 'bbc-world', cat: 'monde', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'aljazeera', cat: 'monde', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'gn-monde-fr', cat: 'monde', name: 'Google News', url: googleNews('actualités internationales', 'fr') },
  // Réseaux sociaux
  { id: 'tc-social', cat: 'social', name: 'TechCrunch', url: 'https://techcrunch.com/category/social/feed/' },
  { id: 'gn-social-fr', cat: 'social', name: 'Google News', url: googleNews('réseaux sociaux OR Instagram OR TikTok OR Snapchat OR WhatsApp', 'fr') },
  // Football
  { id: 'bbc-foot', cat: 'foot', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { id: 'sky-foot', cat: 'foot', name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040' },
  { id: 'gn-foot-fr', cat: 'foot', name: 'Google News', url: googleNews('football', 'fr') },
  // iPhone & Android
  { id: 'iphonfr', cat: 'tech', name: 'iPhon.fr', url: 'https://www.iphon.fr/feed' },
  { id: 'frandroid', cat: 'tech', name: 'Frandroid', url: 'https://www.frandroid.com/feed' },
  { id: '9to5mac', cat: 'tech', name: '9to5Mac', url: 'https://9to5mac.com/feed/' },
  { id: '9to5google', cat: 'tech', name: '9to5Google', url: 'https://9to5google.com/feed/' },
  // Spotify
  { id: 'gn-spotify-fr', cat: 'spotify', name: 'Google News', url: googleNews('Spotify', 'fr') },
  { id: 'gn-spotify-en', cat: 'spotify', name: 'Google News', url: googleNews('Spotify', 'en') },
];

// — Filtre anti-politique —
// Blocklist globale (toutes catégories). « politique de » est toléré
// (« politique de confidentialité », « politique de prix »...).
const POLITICS_GLOBAL = [
  /\bpolitics\b/i,
  /\bpolitical\b/i,
  /\bpolitique\b(?!\s+de\b)/i,
  /\bpoliticien\w*/i,
  /\b(élection|election|élections|elections)\b/i,
  /\b(référendum|referendum)\b/i,
  /\b(sénat|senate|sénateur|senator|senateur)\b/i,
  /\bcongress(man|woman)?\b/i,
  /\bcongrès\b/i,
  /\b(parlement|parliament|député|depute)\w*/i,
  /\b(législativ\w*|legislativ\w*)/i,
  /\b(ministre|minister|ministry)\b/i,
  /\b(gouvernement|government)\b/i,
  /\bassemblée nationale\b/i,
  /\b(prime minister|premier ministre)\b/i,
];
// Mots strictement politiques mais ambigus ailleurs — « président » d'un club
// de foot reste une actu légitime. Appliqué à « monde » seulement.
const POLITICS_MONDE = [
  /\b(président|president)\b/i,
  /\b(white house|élysée|downing street)\b/i,
  /\b(macron|trump|biden|poutine|putin|scholz|merkel)\b/i,
];

function isPolitical(title, desc, cat) {
  const text = (String(title || '') + ' ' + String(desc || '')).toLowerCase();
  for (const re of POLITICS_GLOBAL) if (re.test(text)) return true;
  if (cat === 'monde') for (const re of POLITICS_MONDE) if (re.test(text)) return true;
  return false;
}

// — Parsing RSS / Atom (items uniquement) —
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1].trim() : null;
}

function parseRssItems(xml) {
  const out = [];
  const blocks = [...String(xml || '').matchAll(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  for (const block of blocks) {
    const title = stripHtml(decodeXml(pickTag(block, 'title') || ''));
    let link = decodeXml(pickTag(block, 'link') || '');
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = decodeXml(m[1]);
    }
    const dateRaw =
      pickTag(block, 'pubDate') || pickTag(block, 'published') || pickTag(block, 'updated') || null;
    const desc = stripHtml(
      decodeXml(pickTag(block, 'description') || pickTag(block, 'summary') || ''),
    );
    const sourceTag = stripHtml(decodeXml(pickTag(block, 'source') || ''));
    if (!title || !link) continue;
    out.push({ title, link, dateRaw, desc, sourceTag });
  }
  return out;
}

// — Dédup : URL normalisée + titre normalisé (croisé entre sources) —
function normalizeUrl(u) {
  let s = String(u || '').trim();
  try {
    const url = new URL(s);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid']) {
      url.searchParams.delete(p);
    }
    s = url.toString();
  } catch {}
  return s;
}

function normalizeTitle(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function key(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 20);
}

function buildItem(raw, src, now) {
  const title = raw.title.trim();
  let finalTitle = title;
  // Google News : « Titre - Site » → on garde le titre
  if (raw.sourceTag && title.toLowerCase().endsWith(' - ' + raw.sourceTag.toLowerCase())) {
    const cut = title.slice(0, title.length - raw.sourceTag.length - 3).trim();
    if (cut) finalTitle = cut;
  }
  const url = normalizeUrl(raw.link);
  const t = Date.parse(raw.dateRaw || '');
  if (!finalTitle || !url || !Number.isFinite(t)) return null;
  const date = new Date(t).getTime();
  if (now - date > MAX_AGE_HOURS * 3600 * 1000) return null;
  return {
    cat: src.cat,
    sourceId: src.id,
    sourceName: src.name,
    title: finalTitle,
    url,
    desc: (raw.desc || '').slice(0, 300),
    date,
    keys: [key('u:' + url), key('t:' + normalizeTitle(finalTitle))],
  };
}

// — Plafonds anti-spam (items triés du plus récent au plus ancien) —
function pickItems(items, opts = {}) {
  const o = {
    maxPerRun: MAX_PER_RUN,
    maxPerCategory: MAX_PER_CATEGORY,
    maxPerSource: MAX_PER_SOURCE,
    ...opts,
  };
  const perSource = new Map();
  const perCategory = new Map();
  const picked = [];
  for (const it of items) {
    if (picked.length >= o.maxPerRun) break;
    const s = perSource.get(it.sourceId) || 0;
    if (s >= o.maxPerSource) continue;
    const c = perCategory.get(it.cat) || 0;
    if (c >= o.maxPerCategory) continue;
    perSource.set(it.sourceId, s + 1);
    perCategory.set(it.cat, c + 1);
    picked.push(it);
  }
  return picked;
}

async function loadSeen() {
  const set = new Set();
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      for (const k of d.ids || []) set.add(String(k));
    }
  } catch (e) {
    console.warn('loadSeen fail:', e.message);
  }
  return set;
}

async function saveSeen(set) {
  const ids = [...set].sort().slice(-MAX_SEEN);
  await writeJsonAtomic(SEEN_FILE, { updatedAt: new Date().toISOString(), count: ids.length, ids }, 2);
}

async function fetchAll(now) {
  const all = [];
  for (const src of SOURCES) {
    try {
      const xml = await fetchTextWithRetry(src.url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        timeout: 15000,
        maxAttempts: 2,
        label: src.id,
      });
      if (!xml) continue;
      const items = parseRssItems(xml)
        .map((raw) => buildItem(raw, src, now))
        .filter(Boolean);
      console.log('source', src.id, items.length);
      all.push(...items);
    } catch (e) {
      console.warn('source fail', src.id, String(e.message || e).slice(0, 120));
    }
  }
  return all;
}

async function postWebhook(it) {
  const cat = CATEGORY[it.cat];
  const embed = {
    author: { name: it.sourceName },
    title: it.title.length > 250 ? it.title.slice(0, 250) + '…' : it.title,
    url: it.url,
    description: it.desc ? (it.desc.length > 300 ? it.desc.slice(0, 300) + '…' : it.desc) : undefined,
    color: cat.color,
    footer: { text: 'Actus · ' + cat.label },
    timestamp: new Date(it.date).toISOString(),
  };
  const r = await sendEmbeds(WEBHOOK, {}, [embed], {
    identity: cat.identity,
    label: 'news ' + it.cat,
    timeoutMs: 15000,
    minGapMs: 100,
    withDismiss: true,
  });
  console.log('webhook', r.status, it.cat, it.title.slice(0, 60));
  return r.ok;
}

async function main() {
  console.log('=== Actus — monde · réseaux sociaux · foot · iPhone & Android · Spotify ===');
  if (!WEBHOOK) {
    console.warn('NEWS_WEBHOOK_URL manquant — soft skip');
    process.exit(0);
  }
  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  const now = Date.now();
  const all = await fetchAll(now);
  console.log('Items:', all.length, '· vus:', seen.size);
  if (!all.length) {
    console.warn('Aucun item fetché (soft)');
    return { ok: true, fetched: 0, sent: 0 };
  }

  const fresh = all.filter((it) => !it.keys.some((k) => seen.has(k)));
  const isFirstRun = seen.size === 0;
  if (isFirstRun) {
    for (const it of all) for (const k of it.keys) seen.add(k);
    await saveSeen(seen);
    console.log('Seed', seen.size, 'clés — aucun envoi au premier run');
    return { ok: true, seeded: seen.size };
  }
  console.log('Fresh:', fresh.length);

  const clean = fresh.filter((it) => !isPolitical(it.title, it.desc, it.cat));
  clean.sort((a, b) => b.date - a.date);
  const picked = pickItems(clean);

  let sentOk = 0;
  let sentFail = 0;
  for (const it of picked) {
    const ok = await postWebhook(it);
    if (ok) {
      sentOk++;
      for (const k of it.keys) seen.add(k);
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL', it.title.slice(0, 60), '- retry au prochain run');
    }
  }
  // Anti-spam : tout ce qui n'est pas retenu (plafonné ou politique) est
  // marqué vu — pas de rattrapage différé au run suivant.
  const pickedSet = new Set(picked);
  for (const it of clean) {
    if (!pickedSet.has(it)) for (const k of it.keys) seen.add(k);
  }
  const cleanSet = new Set(clean);
  for (const it of fresh) {
    if (!cleanSet.has(it)) for (const k of it.keys) seen.add(k);
  }
  await saveSeen(seen);
  console.log('Done. Fresh', fresh.length, '· envoyés', sentOk, '· échecs', sentFail);
  if (sentFail > 0 && sentOk === 0 && picked.length > 0) process.exitCode = 2;
  return { ok: sentFail === 0, fetched: all.length, fresh: fresh.length, sent: sentOk };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('News error:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  main,
  isPolitical,
  pickItems,
  parseRssItems,
  normalizeTitle,
  normalizeUrl,
};
