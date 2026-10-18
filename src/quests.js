/**
 * Suivi des quêtes Discord — Components V2 (média + layout)
 *
 * - flags IS_COMPONENTS_V2 (32768)
 * - Container + TextDisplay + Separator + MediaGallery + link buttons
 * - Vidéo / images CDN dans MediaGallery (plus seulement un lien)
 * - Webhook: ?with_components=true
 *
 * Fallback: embed classique si V2 refuse le payload
 */
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds, sendWebhook } = require('./lib/webhook');
const { writeJsonAtomic } = require('./lib/atomic');
const { fetchJsonWithRetry } = require('./lib/http');
const { sleep, DEFAULT_UA, DEFAULT_BOT_NAME: BOT_NAME, DEFAULT_MOBILE_AVATAR: AVATAR } = require('./lib/utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'quests.json');

const REGIONS_URL = 'https://api.discordquest.com/api/regions';

const WEBHOOK =
  process.env.QUEST_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.DISCORD_USER_TOKEN ||
  process.env.DISCORD_USER_TOKEN_1 ||
  null;
const PUBLIC_QUESTS_URL = 'https://api.discordquest.com/api/quests';

const CDN = 'https://cdn.discordapp.com/';
const IS_COMPONENTS_V2 = 1 << 15; // 32768

function assetUrl(questId, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  if (/^quests\//i.test(filename)) return CDN + filename.replace(/^\//, '');
  if (questId) return CDN + 'quests/' + questId + '/' + filename.replace(/^\//, '');
  return CDN + filename.replace(/^\//, '');
}
