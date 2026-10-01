/**
 * Envoi robuste de webhooks Discord, partagé par tous les scripts.
 *
 * - 429 : respecte Retry-After (header), retry_after (JSON) et X-RateLimit-Reset-After
 * - 5xx / erreurs réseau / timeout : backoff exponentiel avec jitter
 * - 4xx (hors 429) : échec immédiat (payload invalide → inutile de réessayer)
 * - X-RateLimit-Remaining: 0 → attend le reset avant la requête suivante
 * - découpe les embeds en messages ≤ 10 embeds ET ≤ 6000 caractères (limites Discord)
 * - masque le token du webhook dans les logs
 */
const fetch = require('node-fetch');
const { sleep } = require('./utils');
const { IS_COMPONENTS_V2_FLAG, embedsToComponents } = require('./components_v2');

const DEFAULTS = {
  maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5),
  timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS || 20000),
  baseDelayMs: 300,
  maxDelayMs: 30000,
  minGapMs: 200,
};

// Limites officielles Discord
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 6000;

// Pause partagée si Discord signale un bucket épuisé
let bucketResetAt = 0;

// File d'attente par URL : sérialise les envois vers le même webhook
// pour éviter les 429 quand plusieurs appels parallèles ciblent le même webhook.
const urlQueues = new Map();

/**
 * Exécute un envoi webhook en respectant l'ordre par URL.
 * Les appels parallèles vers le même webhook sont automatiquement sérialisés.
 */
function enqueue(url, fn) {
  const prev = urlQueues.get(url) || Promise.resolve();
  const next = prev.then(fn, fn); // fn s'exécute même si le précédent a échoué
  urlQueues.set(url, next.catch(() => {})); // ne jamais casser la chaîne
  return next;
}

function maskWebhook(url) {
  return String(url || '')
    .replace(/(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***')
    .replace(/(webhooks\/\d+\/)[\w-]{20,}/gi, '$1***');
}

function sanitizeLogText(text, url) {
  let s = maskWebhook(String(text || ''));
  if (url) {
    const m = String(url).match(/\/webhooks\/\d+\/([\w-]+)/i);
    if (m && m[1] && m[1].length >= 10) s = s.split(m[1]).join('***');
  }
  return s.slice(0, 400);
}

function isWebhookUrl(url) {
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i.test(
    String(url || ''),
  );
}

function backoff(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** Délai demandé par Discord (ms), ou 0 si inconnu. */
function retryAfterMs(res, json) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    return v == null || v === '' ? NaN : Number(v);
  };
  const candidates = [
    json && Number(json.retry_after),
    h('retry-after'),
    h('x-ratelimit-reset-after'),
  ].filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return 0;
  // Discord renvoie des secondes (float)
  return Math.ceil(Math.max(...candidates) * 1000);
}

/** Longueur « comptée » par Discord pour la limite de 6000 caractères. */
function embedChars(e) {
  if (!e || typeof e !== 'object') return 0;
  let n = 0;
  n += String(e.title || '').length;
  n += String(e.description || '').length;
  if (e.footer) n += String(e.footer.text || '').length;
  if (e.author) n += String(e.author.name || '').length;
  for (const f of e.fields || []) {
    n += String(f.name || '').length + String(f.value || '').length;
  }
  return n;
}

/** Découpe une liste d'embeds en groupes compatibles avec les limites Discord. */
function chunkEmbeds(embeds, maxPerMsg = MAX_EMBEDS_PER_MESSAGE, maxChars = MAX_EMBED_CHARS_PER_MESSAGE) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const e of embeds || []) {
    if (!e) continue;
    const c = embedChars(e);
    if (cur.length && (cur.length >= maxPerMsg || chars + c > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Envoie un message webhook.
 * Les appels parallèles vers la même URL sont automatiquement sérialisés
 * pour éviter les 429 liés au rate-limiting Discord.
 * @returns {Promise<{ok:boolean,status:number,text:string,attempts:number,json?:any}>}
 */
async function sendWebhook(url, body, options = {}) {
  return enqueue(url, () => _sendWebhook(url, body, options));
}

async function _sendWebhook(url, body, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!url) return { ok: false, status: 0, text: 'no webhook url', attempts: 0 };
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const label = opts.label || '';
  let last = { ok: false, status: 0, text: '', attempts: 0 };

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const waitBucket = bucketResetAt - Date.now();
    if (waitBucket > 0) await sleep(Math.min(waitBucket, opts.maxDelayMs));

    let res;
    try {
      res = await (opts.fetchImpl || fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeout: opts.timeoutMs,
      });
    } catch (e) {
      last = { ok: false, status: 0, text: sanitizeLogText(e && (e.message || e), url), attempts: attempt + 1 };
      const d = backoff(attempt, opts);
      console.warn(`webhook network error (${attempt + 1}/${opts.maxAttempts}) ${label}`, last.text, `wait ${d}ms`);
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    last = { ok: res.ok, status: res.status, text: text.slice(0, 500), attempts: attempt + 1, json };

    const remaining = res.headers && res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const ra = retryAfterMs(res, null);
      if (ra > 0) bucketResetAt = Date.now() + ra;
    }

    if (res.ok) {
      if (opts.minGapMs) await sleep(opts.minGapMs);
      return last;
    }

    if (res.status === 429 || res.status >= 500) {
      const ra = res.status === 429 ? retryAfterMs(res, json) : 0;
      const d = Math.min(opts.maxDelayMs, ra > 0 ? ra + 100 : backoff(attempt, opts));
      console.warn(`webhook ${res.status} (${attempt + 1}/${opts.maxAttempts}) ${label} wait ${d}ms`);
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    // 4xx : payload invalide / webhook supprimé → pas de retry
    console.warn(`webhook fail ${res.status} ${label} ${maskWebhook(url)}`, sanitizeLogText(last.text, url));
    return last;
  }

  console.warn(`webhook gave up after ${last.attempts} attempts ${label}`, last.status, sanitizeLogText(last.text, url));
  return last;
}

/**
 * Ajoute with_components=true à l'URL du webhook (requis pour Components V2).
 */
function withComponentsUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('with_components', 'true');
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'with_components=true';
  }
}

/**
 * Envoie une liste d'embeds en les convertissant automatiquement en Components V2.
 * Les embeds sont transformés en Container + TextDisplay, ce qui :
 * - Supporte du texte bien plus long (4000 chars par TextDisplay vs 1024 par field)
 * - Évite les erreurs de limite de 6000 chars par embed
 * - Gère automatiquement le dépassement en multipliant les messages
 * Arrête au premier échec (retourne le résultat de l'échec).
 */
async function sendEmbeds(url, base, embeds, options = {}) {
  if (!url || !embeds || !embeds.length)
    return { ok: false, status: 0, text: 'skip', attempts: 0, sent: 0 };

  // Convertir les embeds en messages Components V2 avec bouton dismiss
  const withDismiss = options.withDismiss !== false;
  const messages = embedsToComponents(embeds, withDismiss);
  if (!messages.length)
    return { ok: false, status: 0, text: 'no components', attempts: 0, sent: 0 };

  const componentUrl = withComponentsUrl(url);
  let last = { ok: true, status: 204, text: '', attempts: 0 };
  let sent = 0;

  for (const components of messages) {
    const body = {
      ...base,
      flags: IS_COMPONENTS_V2_FLAG,
      components,
    };
    // Supprimer embeds/content qui ne fonctionnent pas avec Components V2
    delete body.embeds;
    delete body.content;

    last = await sendWebhook(componentUrl, body, options);
    if (!last.ok) return { ...last, sent };
    sent += components.length;
  }
  return { ...last, sent };
}

function _resetBucket() {
  bucketResetAt = 0;
}

module.exports = {
  sendWebhook,
  sendEmbeds,
  sendComponentsV2: sendEmbeds, // alias pour clarté
  withComponentsUrl,
  chunkEmbeds,
  embedChars,
  retryAfterMs,
  maskWebhook,
  sanitizeLogText,
  isWebhookUrl,
  MAX_EMBEDS_PER_MESSAGE,
  MAX_EMBED_CHARS_PER_MESSAGE,
  _resetBucket,
};
