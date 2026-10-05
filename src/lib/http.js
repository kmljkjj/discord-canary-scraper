/**
 * Helper réseau partagé — fetch robuste avec retry, timeout et validation JSON.
 *
 * Problèmes résolus :
 * - .json() qui plante quand l'API renvoie du HTML (Cloudflare 429, page d'erreur)
 * - fetch sans timeout (peut bloquer indéfiniment)
 * - pas de retry sur 429 / 5xx / erreurs réseau
 * - duplication de la logique de retry dans chaque script
 *
 * Usage :
 *   const { fetchJsonWithRetry, fetchTextWithRetry } = require('./lib/http');
 *   const data = await fetchJsonWithRetry(url, { headers, timeout: 15000 });
 */
const fetch = require('node-fetch');
const { sleep, redactSecrets } = require('./utils');

const DEFAULTS = {
  maxAttempts: 3,
  timeoutMs: 20000,
  baseDelayMs: 500,
  maxDelayMs: 15000,
};

/**
 * Détermine si un statut HTTP mérite un retry.
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Calcule le délai de retry (backoff exponentiel + jitter).
 * @param {number} attempt - tentative actuelle (0-indexed)
 * @param {object} opts
 * @returns {number} délai en ms
 */
function backoffMs(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Extrait le retry-after d'une réponse (header ou JSON body).
 * @param {object} res - réponse fetch
 * @param {object} [bodyJson] - body JSON parsé si disponible
 * @returns {number} délai en ms (0 si inconnu)
 */
function extractRetryAfterMs(res, bodyJson) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    return v == null || v === '' ? NaN : Number(v);
  };
  const candidates = [
    bodyJson && Number(bodyJson.retry_after),
    h('retry-after'),
    h('x-ratelimit-reset-after'),
  ].filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return 0;
  return Math.ceil(Math.max(...candidates) * 1000);
}

/**
 * Fetch robuste avec retry, timeout et gestion des erreurs réseau.
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options fetch + config retry
 * @param {object} [options.headers] - headers HTTP
 * @param {number} [options.timeout=20000] - timeout en ms
 * @param {number} [options.maxAttempts=3] - nombre max de tentatives
 * @param {number} [options.baseDelayMs=500] - délai de base pour le backoff
 * @param {number} [options.maxDelayMs=15000] - délai max de backoff
 * @param {string} [options.label] - label pour les logs
 * @returns {Promise<object>} réponse fetch (avec .ok, .status, .text(), .json())
 */
async function fetchWithRetry(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { headers, timeout: timeoutMs, maxAttempts, label } = opts;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        timeout: timeoutMs,
      });

      if (res.ok || !isRetryableStatus(res.status)) {
        return res;
      }

      // Retryable: 429 ou 5xx
      let bodyJson = null;
      try {
        bodyJson = await res.json();
      } catch {}
      const retryAfter = extractRetryAfterMs(res, bodyJson);
      const delay = retryAfter || backoffMs(attempt, opts);

      if (attempt < maxAttempts - 1) {
        const tag = label ? `[${label}] ` : '';
        console.warn(
          `${tag}HTTP ${res.status} — retry ${attempt + 1}/${maxAttempts} dans ${Math.round(delay / 1000)}s`,
        );
        await sleep(Math.min(delay, opts.maxDelayMs));
      }
    } catch (e) {
      // Erreur réseau (timeout, DNS, connexion refusée)
      lastError = e;
      if (attempt < maxAttempts - 1) {
        const delay = backoffMs(attempt, opts);
        const tag = label ? `[${label}] ` : '';
        console.warn(
          `${tag}erreur réseau: ${String(e.message || e).slice(0, 100)} — retry ${attempt + 1}/${maxAttempts}`,
        );
        await sleep(delay);
      }
    }
  }

  // Toutes les tentatives ont échoué
  const tag = label ? `[${label}] ` : '';
  const msg = lastError
    ? `${tag}échec après ${maxAttempts} tentatives: ${redactSecrets(String(lastError.message || lastError)).slice(0, 150)}`
    : `${tag}échec après ${maxAttempts} tentatives`;
  throw new Error(msg);
}

/**
 * Fetch + parse JSON avec retry, timeout et validation du content-type.
 * Évite le crash quand l'API renvoie du HTML (Cloudflare, page d'erreur).
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options (mêmes que fetchWithRetry)
 * @returns {Promise<object|null>} JSON parsé, ou null si la réponse n'est pas du JSON valide
 */
async function fetchJsonWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }

  // Valide le content-type avant de parser
  const ct = res.headers.get('content-type') || '';
  if (ct && !ct.includes('application/json') && !ct.includes('text/plain')) {
    // Content-type inattendu (HTML, etc.) — probablement une erreur
    const text = await res.text().catch(() => '');
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(
      `${tag}content-type inattendu: "${ct}" — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }

  try {
    return await res.json();
  } catch {
    // Le body n'est pas du JSON valide (HTML de Cloudflare, page d'erreur, etc.)
    const text = await res.text().catch(() => '');
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(
      `${tag}JSON invalide — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }
}

/**
 * Fetch + texte avec retry et timeout.
 *
 * @param {string} url - URL à fetcher
 * @param {object} [options] - options (mêmes que fetchWithRetry)
 * @returns {Promise<string|null>} texte de la réponse, ou null si échec
 */
async function fetchTextWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) {
    const tag = options.label ? `[${options.label}] ` : '';
    console.warn(`${tag}HTTP ${res.status} — réponse non-OK`);
    return null;
  }
  return await res.text();
}

/**
 * Parse le JSON d'une réponse fetch de manière sûre.
 * Évite le crash quand le body n'est pas du JSON valide (HTML de Cloudflare, etc.).
 *
 * @param {object} res - réponse fetch
 * @returns {Promise<object|null>} JSON parsé, ou null si invalide
 */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    const ct = res.headers && res.headers.get('content-type') || '';
    console.warn(
      `JSON invalide (content-type: "${ct}") — body: ${String(text).slice(0, 100)}`,
    );
    return null;
  }
}

module.exports = {
  fetchWithRetry,
  fetchJsonWithRetry,
  fetchTextWithRetry,
  safeJson,
  isRetryableStatus,
  extractRetryAfterMs,
  backoffMs,
};
