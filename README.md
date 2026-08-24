# discord-canary-scraper

Scraper Canary style **Wumpus Central** + notifs style **Discord Previews**.

## Deux modes

### 1) GitHub seul (simple)
Cron toutes les **20 min** + bouton Actions.

### 2) Ton hébergement (plus rapide) ← recommandé

Ton VPS / Termux / bot appelle GitHub toutes les **~90 s**.

```bash
# Sur ton hébergement
export GITHUB_TOKEN="ghp_xxx"   # PAT classic : repo + workflow
export INTERVAL=90
python3 scripts/trigger_host.py
```

| Situation | Comportement |
|-----------|----------------|
| Même build | **FAST SKIP** ~10 s, **aucun** message Discord |
| Nouveau build | Download + extract + embeds (Build / Strings / Experiments / Endpoints) |

## Secret GitHub

`DISCORD_WEBHOOK_URL` = webhook du salon

## Messages

- `New Discord Canary Build`
- `Strings` (`+ key: value`)
- `Endpoints`
- `New Apex Experiment` / `New Experiment`

## Premier run

Bootstrap silencieux (enregistre la baseline, pas de flood).
Ensuite seuls les **vrais** deltas partent.
