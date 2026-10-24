/**
 * ⚠️ DISCLAIMER / AVERTISSEMENT — SOURCE DES DONNÉES DE ROLLOUTS ⚠️
 *
 * EN — The rollout percentage data (user + guild experiments) served by this
 * module comes from the community rollouts gist maintained by agnonotdev —
 * the same data source that is collected and published by Wumpus Central.
 * Full credit for that data belongs to agnonotdev and Wumpus Central; this
 * repository only reads and formats it.
 *
 * FR — Les pourcentages de rollouts (expériences user + guild) servis par ce
 * module proviennent du gist communautaire maintenu par agnonotdev — la même
 * source de données que celle collectée et publiée par Wumpus Central. Tout
 * le crédit de ces données revient à agnonotdev et à Wumpus Central ; ce
 * dépôt ne fait que les lire et les formater.
 *
 * NOTE — Everything else in this repository (code, murmur3 sampling,
 * watchers, notifications, exact percentages computed from the Discord API
 * in apex_rollouts.js) is our own work and is NOT affiliated with Wumpus
 * Central in any way.
 *
 * NOTE — Tout le reste de ce dépôt (code, sampling murmur3, watchers,
 * notifications, pourcentages exacts calculés depuis l'API Discord dans
 * apex_rollouts.js) est de notre cru et n'a aucune affiliation avec
 * Wumpus Central.
 */

/**
 * Gist communautaire (agnonotdev) — source FRAÎCHE, sans cache CDN.
 *
 * Problème : l'URL raw (gist.githubusercontent.com) est servie avec
 * Cache-Control: max-age=300 (5 minutes). Un rollout publié dans le gist
 * peut donc rester invisible jusqu'à 5 minutes — c'est l'essentiel de notre
 * retard sur les trackers concurrents (Wumpus Central & co) qui lisent une
 * source à jour.
 *
 * Solution : lire via l'API GitHub (api.github.com/gists/{id}) — toujours à
 * jour, aucun cache intermédiaire. Avec GITHUB_TOKEN (token Actions), la
 * limite est très large (bien assez pour un poll toutes les 15 s).
 * Fallback : URL raw + cache-buster (?t=epoch) si l'API échoue.
 *
 * Override : USER_ROLLOUT_COMMUNITY_URL / GUILD_ROLLOUT_COMMUNITY_URL
 * reste respecté (utilise alors le raw + cache-buster).
 */
const { fetchWithRetry } = require('./http');
const { DEFAULT_UA } = require('./utils');

const DEFAULT_GIST_ID = 'fb2b6a7ba1301733aa5c2050b3e59a18';
const DEFAULT_RAW_URL =
  'https://gist.githubusercontent.com/agnonotdev/' + DEFAULT_GIST_ID + '/raw/rollouts.json';

function gistApiUrl() {
  return process.env.ROLLOUTS_GIST_API || 'https://api.github.com/gists/' + DEFAULT_GIST_ID;
}

function gistRawUrl() {
  const base =
    process.env.GUILD_ROLLOUT_COMMUNITY_URL ||
    process.env.USER_ROLLOUT_COMMUNITY_URL ||
    DEFAULT_RAW_URL;
  return base + (base.includes('?') ? '&' : '?') + 't=' + Date.now(); // cache-buster
}

function isOverridden() {
  return !!(process.env.GUILD_ROLLOUT_COMMUNITY_URL || process.env.USER_ROLLOUT_COMMUNITY_URL);
}

/**
 * Contenu texte du rollouts.json du gist, toujours frais.
 * @returns {Promise<string>} contenu brut du fichier
 * @throws si API ET fallback raw échouent tous les deux
 */
async function fetchCommunityText() {
  // 1. API GitHub — toujours frais, pas de cache CDN.
  if (!isOverridden()) {
    const token = process.env.GITHUB_TOKEN;
    try {
      const res = await fetchWithRetry(gistApiUrl(), {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': DEFAULT_UA,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        timeout: 15000,
        maxAttempts: 2,
        label: 'gist api',
      });
      if (res.ok) {
        const data = await res.json();
        const files = (data && data.files) || {};
        const key =
          Object.keys(files).find((k) => /rollouts\.json$/i.test(k)) || Object.keys(files)[0];
        const f = key ? files[key] : null;
        const content = f && f.content;
        if (f && f.truncated) {
          console.warn('gist api: fichier tronqué — fallback raw');
        } else if (typeof content === 'string' && content.trim()) {
          return content;
        } else {
          console.warn('gist api: contenu introuvable — fallback raw');
        }
      } else {
        console.warn('gist api: HTTP', res.status, '— fallback raw');
      }
    } catch (e) {
      console.warn('gist api fail:', String((e && e.message) || e).slice(0, 120), '— fallback raw');
    }
  }

  // 2. Fallback : raw + cache-buster (query param unique → jamais servi
  //    depuis le cache CDN).
  const res = await fetchWithRetry(gistRawUrl(), {
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
    timeout: 20000,
    maxAttempts: 3,
    label: 'gist raw',
  });
  if (!res.ok) throw new Error('community gist HTTP ' + res.status);
  const text = await res.text();
  if (!text || !text.trim()) throw new Error('community gist vide');
  return text;
}

/**
 * Contenu parsé du gist (tableau des rollouts user + guild).
 * @returns {Promise<Array>} entrées du gist ([] si JSON invalide)
 * @throws si aucune source n'est joignable
 */
async function fetchCommunityJson() {
  const text = await fetchCommunityText();
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('community gist JSON invalide:', String((e && e.message) || e).slice(0, 100));
    return [];
  }
}

module.exports = { fetchCommunityText, fetchCommunityJson, DEFAULT_GIST_ID, DEFAULT_RAW_URL };
