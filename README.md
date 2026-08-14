# Discord Canary Scraper

> Inspired by [Wumpus Central](https://github.com/Wumpus-Central) / discrapper-canary

A lightweight, automated Discord **Canary** client datamining tool.

It:
- Scrapes the public Discord Canary web client assets
- Detects new builds
- Archives JS + CSS files
- Commits changes automatically
- Sends a rich notification to a Discord webhook when a new build is found

Perfect for following Discord experiments, feature flags, and upcoming changes.

---

## Features

- Fully automated via GitHub Actions (runs every hour)
- Detects build number & asset hash changes
- Downloads all main JS/CSS assets from Canary
- Clean folder structure (`assets/`, `data/`)
- Discord webhook notifications with build info
- Easy to self-host or fork

---

## Setup

### 1. Fork or use this repo

### 2. Add Discord Webhook (optional but recommended)

1. Create a webhook in your Discord server (Channel Settings → Integrations → Webhooks)
2. Go to your repo **Settings → Secrets and variables → Actions**
3. Create a secret named `DISCORD_WEBHOOK_URL` with your webhook URL

### 3. Enable GitHub Actions

The workflow is already configured. It will run automatically every hour and also on manual trigger.

---

## Manual usage

```bash
npm install
npm run scrape
```

---

## Project structure

```
.
├── .github/workflows/scrape.yml   # Automation
├── src/
│   └── scrape.js                  # Main scraper
├── assets/                        # Downloaded JS & CSS (generated)
├── data/
│   └── build.json                 # Current build info
├── package.json
└── README.md
```

---

## Disclaimer

This project only downloads **publicly available** files served by Discord on `canary.discord.com`.

It is **not** affiliated with Discord Inc.  
All client files belong to Discord.  
Use at your own risk and for educational / research purposes only.

---

Made with ❤️ for the Discord datamining community.
