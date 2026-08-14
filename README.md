# Discord Canary Scraper

> Inspired by [Wumpus Central](https://github.com/Wumpus-Central) / discrapper-canary

A lightweight, automated Discord **Canary** client datamining tool.

It:
- Scrapes the public Discord Canary web client assets
- Detects new builds
- Archives JS + CSS files
- **Analyzes** the code for:
  - 🧪 **New Apex Experiments**
  - 🔬 **New Experiments**
  - 🛣️ **New Routes**
  - 📝 **New / interesting Strings**
- Sends rich Discord webhook notifications
- Highlights **important** changes with a special alert embed

---

## Features

- Fully automated via GitHub Actions (runs every hour)
- Detects build number & asset changes
- Downloads all main JS/CSS assets from Canary
- Deep scan of JS for experiments, Apex experiments, routes & strings
- Diff against previous run → only reports **new** items
- Special “🚨 Important changes” notification when something real is found
- Clean folder structure (`assets/`, `data/`)

---

## Setup

### 1. Use this repo (or fork it)

### 2. Add Discord Webhook (recommended)

1. Create a webhook in your Discord server  
   (Channel Settings → Integrations → Webhooks)
2. Go to your repo **Settings → Secrets and variables → Actions**
3. Create a secret named `DISCORD_WEBHOOK_URL` with your webhook URL

### 3. Run the workflow

Go to the **Actions** tab → **Scrape Discord Canary** → **Run workflow**

It also runs automatically every hour.

---

## What gets notified?

| Type | When it appears |
|------|-----------------|
| 🚨 Important changes | New Apex experiment, new experiment, new route, or several new strings |
| 🧪 New Apex Experiments | Detected Apex experiment IDs |
| 🔬 New Experiments | Classic experiment IDs |
| 🛣️ New Routes | New API / client routes |
| 📝 New Strings | Interesting UI / feature-related strings |
| 🚀 New Build | Simple new build (no major findings) |

First run only creates a baseline (no spam). After that, only **new** findings are reported.

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
├── .github/workflows/scrape.yml   # Automation (hourly)
├── src/
│   └── scrape.js                  # Scraper + analyzer
├── assets/                        # Downloaded JS & CSS
├── data/
│   ├── build.json                 # Current build info
│   └── findings.json              # Previous experiments/routes/strings
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
