# discord-canary-scraper

Pipeline inspiré de **Wumpus Central** (discrapper-canary) + notifications style **Discord Previews**.

## Flow

1. Fetch `canary.discord.com` → `BUILD_NUMBER` + assets
2. Download JS (`web.*.js` + chunks)
3. Extract **strings** (clés 6 chars), **routes**, **experiments**
4. Diff vs `data/`
5. Webhook seulement si vrai delta (pas de spam)
6. Commit state

## Messages Discord

- `New Discord Canary Build`
- `Strings` (`+ key: value`)
- `Endpoints` (`+ NAME: /path`)
- `New Apex Experiment` / `New Experiment`

## Secret

`DISCORD_WEBHOOK_URL`

## Run

Actions → **Scrape Discord Canary** → Run workflow

Premier run = bootstrap (aucun flood). Ensuite seuls les vrais nouveaux trucs partent.
