/**
 * Rollouts watcher — mode « long poll » pour battre la latence des crons.
 *
 * Problème : GitHub Actions décale les schedules (0 à 10+ min aux heures de
 * pointe) et un job met ~40 s à démarrer. Résultat : nos % arrivaient ~6 min
 * après les trackers qui lisent le même gist depuis un serveur dédié.
 *
 * Solution : UN job qui reste vivant ~19 min (cron toutes les 20 min, cf.
 * rollouts-watch.yml) et re-poll le gist toutes les 15 s via l'API GitHub
 * (source fraîche, pas de cache CDN — cf. lib/community.js). Dès que le
 * contenu bouge : détection + webhook immédiat → notification ~20-45 s
 * après la mise à jour du gist, compétitive avec un poll serveur.
 *
 * Comportement :
 *  - au démarrage : un passage complet (couvre les changements survenus
 *    pendant l'éventuel trou entre deux jobs)
 *  - gist changé → passage détection immédiat (guild puis user)
 *  - sinon, passage périodique toutes les ROLLOUTS_FULL_PASS_MS (4 min) pour
 *    la détection par sampling / token snapshot
 *  - état rechargé depuis origin avant chaque passage (dispatch manuels,
 *    reprises), commit + push après chaque passage
 *
 * Env :
 *   ROLLOUTS_WATCH_MS        default 19 min (durée du watch)
 *   ROLLOUTS_POLL_MS         default 15 s (intervalle de poll du gist)
 *   ROLLOUTS_FULL_PASS_MS    default 4 min (passe détection périodique)
 *   ROLLOUTS_MAX_POLLS       optionnel — borne le nombre de polls (tests)
 *   GITHUB_TOKEN             pour l'API gist (limite large)
 */
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { sleep } = require('./lib/utils');
const { fetchCommunityText } = require('./lib/community');

const WATCH_MS = Math.max(60000, Number(process.env.ROLLOUTS_WATCH_MS || 19 * 60 * 1000));
const POLL_MS = Math.max(10, Number(process.env.ROLLOUTS_POLL_MS || 15000));
const FULL_PASS_MS = Math.max(60000, Number(process.env.ROLLOUTS_FULL_PASS_MS || 4 * 60 * 1000));
const MAX_POLLS = Number(process.env.ROLLOUTS_MAX_POLLS || 0); // 0 = illimité

// Sampling léger pour les passes détection : le gist reste LA source des %,
// le sampling ne sert qu'à détecter les expériences sans ranges (~22 requêtes
// par passe grâce à la sortie plateau, au lieu de 100 tous les 2 min avant).
process.env.USER_ROLLOUT_SAMPLES = process.env.USER_ROLLOUT_SAMPLES || '30';
process.env.USER_ROLLOUT_CONCURRENCY = process.env.USER_ROLLOUT_CONCURRENCY || '2';
process.env.USER_ROLLOUT_DELAY_MS = process.env.USER_ROLLOUT_DELAY_MS || '150';
process.env.USER_ROLLOUT_MIN_OK = process.env.USER_ROLLOUT_MIN_OK || '20';
process.env.USER_ROLLOUT_PLATEAU = process.env.USER_ROLLOUT_PLATEAU || '20';
process.env.USER_ROLLOUT_MAX_MS = process.env.USER_ROLLOUT_MAX_MS || '30000';

const guildRollouts = require('./guild_rollouts');
const userRollouts = require('./user_rollouts');

const STATE_FILES = ['data/user_rollouts.json', 'data/guild_rollouts.json'];

function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Rafraîchit l'état depuis origin (reprises / dispatch manuels). */
function gitRefreshState() {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...STATE_FILES], {
      encoding: 'utf8',
    });
    if (dirty.trim()) return; // état local non poussé — ne pas l'écraser
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['checkout', 'origin/main', '--', ...STATE_FILES], { stdio: 'ignore' });
  } catch (e) {
    console.warn('git refresh skip:', String((e && e.message) || e).slice(0, 80));
  }
}

/** Commit + push de l'état (soft-fail : rejoué au prochain passage si KO). */
function commitState() {
  try {
    execFileSync('bash', ['scripts/commit-state.sh', 'rollouts watch: state', ...STATE_FILES], {
      env: { ...process.env, COMMIT_SOFT_FAIL: '1' },
      stdio: 'inherit',
    });
  } catch (e) {
    console.warn('commit-state fail (rejoué au prochain passage):', String((e && e.message) || e).slice(0, 80));
  }
}

/** Passe de détection : guild puis user, état rafraîchi puis commité. */
async function detectionPass(reason) {
  console.log('── Passage détection (' + reason + ') ──');
  gitRefreshState();
  process.exitCode = undefined; // exitCode 2 (webhook KO) est géré par passe
  try {
    await guildRollouts.main();
  } catch (e) {
    console.warn('guild pass fail:', String((e && e.message) || e).slice(0, 120));
  }
  try {
    await userRollouts.main();
  } catch (e) {
    console.warn('user pass fail:', String((e && e.message) || e).slice(0, 120));
  }
  commitState();
}

async function main() {
  const deadline = Date.now() + WATCH_MS;
  let lastHash = null;
  let lastFull = 0;
  let polls = 0;
  console.log(
    'Rollouts watcher — poll', Math.round(POLL_MS / 1000) + 's, passe périodique',
    Math.round(FULL_PASS_MS / 60000) + ' min, watch', Math.round(WATCH_MS / 60000) + 'min',
  );
  while (Date.now() < deadline) {
    if (MAX_POLLS > 0 && polls >= MAX_POLLS) break;
    polls++;

    let h = null;
    try {
      h = hashOf(await fetchCommunityText());
    } catch (e) {
      console.warn('poll fail:', String((e && e.message) || e).slice(0, 100));
    }

    const first = lastHash == null;
    const changed = !first && h != null && h !== lastHash;
    if (changed) console.log('Gist changé → passage immédiat');
    if (h != null) lastHash = h;

    const now = Date.now();
    const due = now - lastFull >= FULL_PASS_MS;

    if (first || changed || due) {
      await detectionPass(first ? 'démarrage (couvre le trou entre jobs)' : changed ? 'gist changé' : 'périodique');
      lastFull = now;
    }

    await sleep(POLL_MS);
  }
  console.log('Watcher terminé —', polls, 'polls');
  // exitCode laissé tel quel : 2 si le dernier passage a eu un webhook KO.
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { main, detectionPass, gitRefreshState, commitState, hashOf };
