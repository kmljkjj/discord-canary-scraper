/**
 * User experiment rollouts v9 — ESTIMATED (honest sampling) + recent-first
 *
 * Discord hash space = 0..9999 (SCALE 10000) — official.
 * User % cannot be exact from public API; we estimate via fingerprint sampling.
 *
 * v9 improvements:
 *  - Stronger multi-source hash→id map (local + remote official/community)
 *  - Prefer RECENT experiments (2025+) for notifications
 *  - Better confidence gates so noisy low-sample % don't spam
 *  - Higher quality default sampling (more ok samples before estimate)
 *  - Recent experiments sorted first in embeds
 *  - TRANSACTIONAL announced (unchanged)
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..8
 *   APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 150
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 280
 *   APEX_MIN_PCT_DELTA         default 1
 *   USER_ROLLOUT_NOTIFY_HASH   default 0
 *   USER_ROLLOUT_MIN_OK        default 35
 *   APEX_RECENT_YEAR           default 2025
 */
