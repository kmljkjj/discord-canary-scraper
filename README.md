# discord-canary-scraper

## Problème résolu (hébergement 50s)

Avant : dispatch toutes les 50s **annulait** le scrape long → jamais de fin → rien dans Discord.

Maintenant :

1. **`scripts/trigger_host.py` (smart)**  
   - Toutes les 50s : lit le `BUILD_NUMBER` Canary  
   - **Dispatch GitHub seulement si le build a changé**  
   - Sinon : aucun Actions (économie + pas de file)

2. **Actions**  
   - `cancel-in-progress: false` → un full scrape **termine**  
   - Même build déjà connu → `FAST SKIP` ~10s

## Setup hébergement

```bash
export GITHUB_TOKEN="ghp_xxx"   # classic : repo + workflow
export INTERVAL=50
python3 scripts/trigger_host.py
```

Logs attendus :
```
build 599999 inchangé — pas de dispatch
NOUVEAU build 599999 → 600001 — dispatch Actions
DISPATCH OK 204
```

## Secret GitHub

`DISCORD_WEBHOOK_URL`

## Premier run manuel

Actions → **Scrape Discord Canary** → Run workflow **une fois**  
Attends la fin (vert). Log : `BOOTSTRAP saved N experiments` ou `Extracted`.

Ensuite laisse le host tourner.
