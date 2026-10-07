/**
 * User experiment rollouts v10 — EXACT percentages + filter-aware segments.
 *
 * Key changes vs v9:
 *  - Populations filtrées (feature, member_count, range_by_hash, id, hub_type)
 *    analysées et affichées à part (snippet Apex Research / Comunidade Escoteiros)
 *  - % globaux (sans filtres) restent la source principale des notifs
 *  - Embeds enrichis : scope global/filtré + résumé des filtres
 *  - Fingerprint sampling + fallback estimation inchangés
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..5
 *   APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 80
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 300
 *   APEX_MIN_PCT_DELTA         default 3
 *   USER_ROLLOUT_NOTIFY_HASH   default 0 (do not notify unknown hash names)
 *   USER_ROLLOUT_MIN_OK        default 25 (min successful samples before any %)
 */
