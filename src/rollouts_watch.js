/**
 * Rollouts watcher V2 — passes de mesure rapprochées.
 *
 * V13 : plus AUCUNE source externe à surveiller (fini le long-poll du gist).
 * La mesure EST notre sampling de l'API Discord : ce watcher enchaîne des
 * passes user_rollouts toutes les ROLLOUTS_FULL_PASS_MS (défaut 4 min)
 * pendant ROLLOUTS_WATCH_MS (~19 min, cron toutes les 20 min). Chaque passe
 * ajoute ses échantillons à la fenêtre glissante (USER_ROLLOUT_WINDOW_H)
 * → la précision s'affine en continu, ~15 passes par heure.
 *
 * (Un cron GitHub classique est décalé de 0 à 10+ min aux heures de pointe :
 * le watcher garantit des passes régulières même avec un schedule en retard.)
 *
 * Comportement :
 *  - passe complète au démarrage (couvre le trou entre deux jobs)
 *  - passes périodiques jusqu'à la fin du budget temps
 *  - état rechargé depuis origin avant chaque passe (dispatch manuels),
 *    commit + push après chaque passe
 *
 * Env :
 *   ROLLOUTS_WATCH_MS        default 19 min (durée du watch)
 *   ROLLOUTS_FULL_PASS_MS    default 4 min (intervalle entre passes)
 *   ROLLOUTS_MAX_PASSES      optionnel — borne le nombre de passes (tests)
 */
const { execFileSync } = require('child_process');
const { sleep } = require('./lib/utils');
const userRollouts = require('./user_rollouts');

const WATCH_MS = Math.max(60000, Number(process.env.ROLLOUTS_WATCH_MS || 19 * 60 * 1000));
const PASS_MS = Math.max(60000, Number(process.env.ROLLOUTS_FULL_PASS_MS || 4 * 60 * 1000));
const MAX_PASSES = Number(process.env.ROLLOUTS_MAX_PASSES || 0); // 0 = illimité

// Sampling des passes du watcher : plus léger qu'un run complet, mais assez
// dense pour la mesure (la fenêtre cumule les passes entre elles).
process.env.USER_ROLLOUT_SAMPLES = process.env.USER_ROLLOUT_SAMPLES || '120';
process.env.USER_ROLLOUT_CONCURRENCY = process.env.USER_ROLLOUT_CONCURRENCY || '2';
process.env.USER_ROLLOUT_DELAY_MS = process.env.USER_ROLLOUT_DELAY_MS || '150';
process.env.USER_ROLLOUT_MIN_OK = process.env.USER_ROLLOUT_MIN_OK || '30';
process.env.USER_ROLLOUT_PLATEAU = process.env.USER_ROLLOUT_PLATEAU || '25';
process.env.USER_ROLLOUT_MAX_MS = process.env.USER_ROLLOUT_MAX_MS || '45000';

const STATE_FILES = ['data/user_rollouts.json'];

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

/** Passe de mesure : user rollouts, état rafraîchi puis commité. */
async function detectionPass(reason) {
  console.log('── Passage mesure (' + reason + ') ──');
  gitRefreshState();
  process.exitCode = undefined; // exitCode 2 (webhook KO) est géré par passe
  try {
    await userRollouts.main();
  } catch (e) {
    console.warn('user pass fail:', String((e && e.message) || e).slice(0, 120));
  }
  commitState();
}

async function main() {
  const deadline = Date.now() + WATCH_MS;
  let passes = 0;
  console.log(
    'Rollouts watcher V2 — passes de mesure toutes les',
    Math.round(PASS_MS / 1000) + 's, watch',
    Math.round(WATCH_MS / 60000) + 'min',
  );
  while (Date.now() < deadline) {
    if (MAX_PASSES > 0 && passes >= MAX_PASSES) break;
    await detectionPass(passes === 0 ? 'démarrage (couvre le trou entre jobs)' : 'périodique');
    passes++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(PASS_MS, remaining));
  }
  console.log('Watcher terminé —', passes, 'passes');
  // exitCode laissé tel quel : 2 si le dernier passage a eu un webhook KO.
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { main, detectionPass, gitRefreshState, commitState };
