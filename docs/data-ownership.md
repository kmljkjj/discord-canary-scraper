# Data ownership

Each automated writer should only touch its own files under `data/`.

| Domain | Primary files | Workflow |
|--------|---------------|----------|
| Canary scrape | `build.json`, `experiments.json`, `current_experiments.json`, `known_*`, `last_extract_*`, `strings.json`, `routes.json`, `findings.json`, `generation.json`, `notify_dedupe.json`, `announced_builds.json`, `removed_experiments.json`, `last_run_meta.json` | `scrape.yml` |
| Quests | `quests.json` | `quests.yml` |
| Apex rollouts | `apex_rollouts.json`, `apex_experiments.json` | `apex-rollouts.yml` |
| User rollouts | `user_rollouts.json` | `rollouts-watch.yml`, `user-rollouts.yml` |
| Shop | `shop_items.json` | `shop.yml` |
| Blog | `blog_tracker.json` | `blog-tracker.yml` |
| X news / watch | `seen_x_posts.json`, `x_seen_ids.json` | `x-news.yml`, `x-watch.yml` |
| Mobile | `mobile_versions.json`, `external_versions.json`, `known_mobile_experiment_ids.json`, `mobile_experiments.json`, `experiment_rollouts.json` | `mobile-versions.yml` |

## Rules

1. Do not commit another domain's files from a workflow.
2. `commit-state.sh` (if used) must only stage the domain's paths.
3. Shared files (`notify_dedupe.json`) are owned by the canary scrape notify path; other jobs must not rewrite them.
4. Prefer appending to known-id lists; never truncate experiment ids.
