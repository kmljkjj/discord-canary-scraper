/**
 * Discord Canary scraper
 * Strings = Discord i18n UI messages (hashed keys like KdgI4k or SCREAMING_SNAKE)
 * NOT webpack meta (release / discord_web-hash / etc.)
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {
  extractUiAndExperiments,
  formatNewUiDescription,
  formatExperimentWithUi,
} = require('./ui_experiments');

const CANARY_APP = 'https://canary.discord.com/app';
const EXPERIMENTS_API =
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true';
const DEFINITIONS_URL =
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');
const STRINGS_FILE = path.join(DATA_DIR, 'strings.json');
const STRINGS_NEW_FILE = path.join(DATA_DIR, 'strings_new.json');
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
