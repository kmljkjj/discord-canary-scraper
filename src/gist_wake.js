#!/usr/bin/env node
/**
 * Réveille le suivi du gist user (gist-user-rollouts.yml) dès que le gist d'agnonotdev change.
 *
 * Pourquoi : le cron GitHub (toutes les 30 min) du suivi est best-effort. Le 28/10/2026 il n'a tourné que
 * deux fois en 7 h (07:17 puis 14:22) : un changement du gist à 12:04 n'a été vu qu'à 14:22
 * (+2 h 18). Ce script tourne dans user-rollouts.yml, déjà déclenché toutes les ~2 minutes :
 * une requête légère compare la révision distante du gist à celle du dernier état et envoie
 * un repository_dispatch `trigger-gist-user-rollouts` uniquement si elle a changé (ou si
 * le dernier calcul date de plus de GIST_WAKE_MAX_AGE_MIN minutes : filet de sécurité).
 *
 * Lecture seule côté gist ; n'écrit aucun fichier ; n'envoie aucune notification Discord.
 * Un échec ne doit jamais bloquer l'échantillonnage (étape continue-on-error + exit 0).
 *
 * Env : GITHUB_TOKEN, GITHUB_REPOSITORY, GIST_WAKE_MAX_AGE_MIN (25), GIST_WAKE_DRY_RUN=1.
 */
'use strict';
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const STATE = path.join(__dirname, '..', 'data', 'gist_user_rollouts.json');
const DEFAULT_GIST = 'e3e99062983e6bd0feaef833f14fd931';
const EVENT = 'trigger-gist-user-rollouts';

/**
 * Décision pure.
 * @returns {{wake: boolean, reason: string}}
 */
function decide({ localRevision, localFetchedAt, remoteRevision, now, maxAgeMin }) {
  if (!remoteRevision) return { wake: false, reason: 'remote_unknown' };
  if (!localRevision) return { wake: true, reason: 'no_local_revision' };
  if (remoteRevision !== localRevision) return { wake: true, reason: 'revision_changed' };
  const t = Date.parse(localFetchedAt || '');
  if (!Number.isFinite(t)) return { wake: true, reason: 'no_local_timestamp' };
  const ageMin = (now - t) / 60000;
  if (ageMin > maxAgeMin) return { wake: true, reason: 'stale_state' };
  return { wake: false, reason: 'up_to_date' };
}

async function remoteRevisionOf(gistId, token, fetchImpl) {
  // Le gist est public : lecture anonyme (le GITHUB_TOKEN d'installation n'a pas accès aux gists).
  const res = await fetchImpl('https://api.github.com/gists/' + encodeURIComponent(gistId), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'canary-gist-wake' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error('gist HTTP ' + res.status);
  const j = await res.json();
  const v = j && Array.isArray(j.history) && j.history[0] && j.history[0].version;
  return typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v : null;
}

async function dispatch(repo, token, fetchImpl) {
  const res = await fetchImpl('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'canary-gist-wake',
    },
    body: JSON.stringify({ event_type: EVENT }),
    timeout: 15000,
  });
  if (res.status !== 204 && !res.ok) throw new Error('dispatch HTTP ' + res.status);
  return res.status;
}

async function main(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const token = deps.token !== undefined ? deps.token : process.env.GITHUB_TOKEN || '';
  const repo = deps.repo || process.env.GITHUB_REPOSITORY || '';
  const dry = deps.dryRun !== undefined ? deps.dryRun : process.env.GIST_WAKE_DRY_RUN === '1';
  const maxAgeMin = Number(deps.maxAgeMin ?? process.env.GIST_WAKE_MAX_AGE_MIN) > 0 ? Number(deps.maxAgeMin ?? process.env.GIST_WAKE_MAX_AGE_MIN) : 25;
  let state = {};
  try { state = await fs.readJson(deps.stateFile || STATE); } catch { state = {}; }
  const src = (state && state.source) || {};
  const gistId = src.gistId || DEFAULT_GIST;
  const remoteRevision = await remoteRevisionOf(gistId, token, fetchImpl);
  const d = decide({ localRevision: src.revision || null, localFetchedAt: src.fetchedAt || state.scrapedAt || null,
    remoteRevision, now: deps.now ?? Date.now(), maxAgeMin });
  const out = { ...d, gistId, localRevision: src.revision || null, remoteRevision, dispatched: false };
  if (d.wake && !dry) {
    if (!token || !repo) { out.reason += '+no_token_or_repo'; }
    else { await dispatch(repo, token, fetchImpl); out.dispatched = true; }
  }
  console.log('gist-wake:', JSON.stringify(out));
  return out;
}

if (require.main === module) {
  main().catch((e) => { console.warn('gist-wake: échec non bloquant:', e.message); }).finally(() => { process.exitCode = 0; });
}
module.exports = { decide, remoteRevisionOf, dispatch, main, EVENT };
