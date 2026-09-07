/**
 * Suivi des quêtes Discord — embeds FR
 *
 * Source: https://api.discordquest.com/api/quests
 * Optionnel: /api/v10/quests/@me avec DISCORD_TOKEN
 *
 * Webhook:
 *   QUEST_WEBHOOK_URL (prioritaire) ou DISCORD_WEBHOOK_URL
 *
 * Username webhook: pas le mot "discord" (règle API).
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'quests.json');

const WEBHOOK =
  process.env.QUEST_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;
const PUBLIC_QUESTS_URL = 'https://api.discordquest.com/api/quests';
const OFFICIAL_QUESTS_URL = 'https://discord.com/api/v10/quests/@me';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

function assetUrl(questId, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  return 'https://cdn.discordapp.com/quests/' + questId + '/' + filename;
}

function rewardTypeFr(type) {
  const map = {
    1: 'Récompense en jeu',
    2: 'Collectible',
    3: 'Monnaie virtuelle',
    4: 'Orbes',
    5: 'Fraction d’orbes',
  };
  return map[type] || 'Type ' + type;
}

function taskLabelFr(key, val) {
  const raw = String(
    (val && (val.type || val.event_name || val.task_name)) || key || '',
  ).toUpperCase();
  const target =
    val && (val.target != null ? val.target : val.target_seconds);
  const seconds =
    target != null && Number(target) > 0 && Number(target) < 100000
      ? Number(target)
      : null;

  const labels = {
    WATCH_VIDEO: 'Regarder la vidéo',
    WATCH_VIDEO_ON_MOBILE: 'Regarder la vidéo sur mobile',
    WATCH_VIDEO_ON_DESKTOP: 'Regarder la vidéo sur bureau',
    PLAY_ON_DESKTOP: 'Jouer sur bureau',
    PLAY_ON_XBOX: 'Jouer sur Xbox',
    PLAY_ON_PLAYSTATION: 'Jouer sur PlayStation',
    PLAY_ACTIVITY: 'Jouer à l’activité',
    STREAM_ON_DESKTOP: 'Streamer sur bureau',
    STREAM_ON_XBOX: 'Streamer sur Xbox',
    STREAM_ON_PLAYSTATION: 'Streamer sur PlayStation',
    ACHIEVEMENT: 'Débloquer un succès',
  };

  let label = labels[raw] || null;
  if (!label) {
    if (/WATCH.*VIDEO.*MOBILE/i.test(raw)) label = 'Regarder la vidéo sur mobile';
    else if (/WATCH.*VIDEO/i.test(raw)) label = 'Regarder la vidéo';
    else if (/STREAM/i.test(raw)) label = 'Streamer';
    else if (/PLAY/i.test(raw)) label = 'Jouer';
    else label = String(key).replace(/_/g, ' ').toLowerCase();
  }

  if (seconds != null) label += ' (' + seconds + ' s)';
  else if (target != null) label += ' (objectif ' + target + ')';
  return label;
}

function formatTasks(config) {
  const tc = config.task_config_v2 || config.task_config || {};
  const tasks = tc.tasks || {};
  const lines = [];
  for (const [key, val] of Object.entries(tasks)) {
    lines.push('• ' + taskLabelFr(key, val));
  }
  if (!lines.length) return null;
  const join =
    tc.join_operator === 'OR' || tc.operator === 'OR'
      ? '_Une seule tâche suffit_'
      : '_Toutes les tâches listées_';
  return join + '\n' + lines.join('\n');
}

function formatDateFr(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return dd + '/' + mm + '/' + yyyy;
  } catch {
    return String(iso).slice(0, 19);
  }
}

function platformsFr(config) {
  const list =
    config.redeemable_platforms ||
    config.platforms ||
    (config.features && config.features.platforms) ||
    null;
  if (Array.isArray(list) && list.length) {
    return list
      .map((p) => {
        const s = String(p).toUpperCase();
        if (s.includes('CROSS')) return 'Multiplateforme';
        if (s.includes('DESKTOP') || s.includes('WIN')) return 'Bureau';
        if (s.includes('XBOX')) return 'Xbox';
        if (s.includes('PLAYSTATION') || s.includes('PS5') || s.includes('PS4'))
          return 'PlayStation';
        if (s.includes('MOBILE') || s.includes('IOS') || s.includes('ANDROID'))
          return 'Mobile';
        return String(p);
      })
      .join(', ');
  }
  // Heuristic from tasks
  const tasks = (config.task_config_v2 || config.task_config || {}).tasks || {};
  const keys = Object.keys(tasks).join(' ');
  if (/CROSS|DESKTOP|XBOX|PLAYSTATION|MOBILE/i.test(keys)) return 'Multiplateforme';
  return 'Multiplateforme';
}

function featuresFr(config) {
  const feats = config.features || config.feature_flags || [];
  if (Array.isArray(feats) && feats.length) {
    return feats.map((f) => '`' + f + '`').join(' ');
  }
  if (typeof feats === 'object' && feats) {
    return Object.keys(feats)
      .filter((k) => feats[k])
      .map((k) => '`' + k + '`')
      .join(' ');
  }
  return null;
}

function normalizeQuest(raw) {
  const id = String(raw.id || (raw.config && raw.config.id) || '');
  const config = raw.config || {};
  const messages = config.messages || {};
  const assets = config.assets || {};
  const app = config.application || {};
  const rewards = (config.rewards_config && config.rewards_config.rewards) || [];
  const colors = config.colors || {};

  const hero =
    assetUrl(id, assets.hero) ||
    assetUrl(id, assets.game_tile) ||
    assetUrl(id, assets.quest_bar_hero);

  let videoUrl = null;
  for (const key of [
    'hero_video',
    'quest_bar_hero_video',
    'video',
    'preview_video',
  ]) {
    if (assets[key]) {
      videoUrl = assetUrl(id, assets[key]);
      break;
    }
  }

  return {
    id,
    name:
      messages.quest_name ||
      messages.game_title ||
      app.name ||
      'Quête ' + id,
    gameTitle: messages.game_title || app.name || null,
    publisher: messages.game_publisher || null,
    applicationId: app.id || null,
    applicationName: app.name || null,
    applicationLink: app.link || null,
    startsAt: config.starts_at || null,
    expiresAt: config.expires_at || null,
    heroImage: hero,
    gameTile: assetUrl(id, assets.game_tile),
    logotype: assetUrl(id, assets.logotype),
    videoUrl,
    primaryColor: colors.primary || null,
    platforms: platformsFr(config),
    features: featuresFr(config),
    rewards: rewards.map((r) => ({
      type: r.type,
      typeLabel: rewardTypeFr(r.type),
      name: (r.messages && r.messages.name) || null,
      skuId: r.sku_id || null,
      orbQuantity: r.orb_quantity != null ? r.orb_quantity : null,
      asset: assetUrl(id, r.asset),
      assetVideo: assetUrl(id, r.asset_video),
      redemptionLink: r.redemption_link || null,
    })),
    tasksText: formatTasks(config),
    preview: !!raw.preview,
  };
}

function parseColor(hex) {
  if (!hex) return 0x5865f2;
  const s = String(hex).replace('#', '');
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? n : 0x5865f2;
}

function buildQuestEmbed(quest) {
  const duree =
    formatDateFr(quest.startsAt) && formatDateFr(quest.expiresAt)
      ? formatDateFr(quest.startsAt) + ' → ' + formatDateFr(quest.expiresAt)
      : formatDateFr(quest.startsAt) ||
        formatDateFr(quest.expiresAt) ||
        '—';

  const infoLines = [];
  infoLines.push('**Durée** · ' + duree);
  if (quest.platforms) infoLines.push('**Plateformes** · ' + quest.platforms);
  if (quest.gameTitle) infoLines.push('**Jeu** · ' + String(quest.gameTitle).slice(0, 200));
  if (quest.publisher) infoLines.push('**Éditeur** · ' + String(quest.publisher).slice(0, 120));
  if (quest.applicationId || quest.applicationName) {
    const appBit =
      (quest.applicationName || 'App') +
      (quest.applicationId ? ' (`' + quest.applicationId + '`)' : '');
    infoLines.push('**Application** · ' + appBit);
  }
  if (quest.features) infoLines.push('**Flags** · ' + quest.features);

  const fields = [];

  fields.push({
    name: 'Infos',
    value: infoLines.join('\n').slice(0, 1024),
  });

  if (quest.tasksText) {
    fields.push({
      name: 'Tâches',
      value: quest.tasksText.slice(0, 1024),
    });
  }

  const rewards = quest.rewards || [];
  if (rewards.length) {
    const rLines = [];
    for (const r of rewards.slice(0, 6)) {
      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · `' + r.orbQuantity + ' orbes`';
      if (r.skuId) line += '\n  SKU `' + r.skuId + '`';
      if (r.redemptionLink) line += '\n  [Récupérer](' + r.redemptionLink + ')';
      rLines.push(line);
    }
    fields.push({
      name: 'Récompenses',
      value: rLines.join('\n').slice(0, 1024),
    });
  }

  if (quest.videoUrl) {
    fields.push({
      name: 'Vidéo',
      value: '[Lire la vidéo](' + quest.videoUrl + ')',
    });
  }

  if (quest.applicationLink) {
    fields.push({
      name: 'Lien',
      value: quest.applicationLink.slice(0, 1024),
    });
  }

  // Reward image as thumbnail if available
  const rewardThumb =
    (rewards.find((r) => r.asset) || {}).asset || quest.gameTile || null;

  return {
    author: {
      name: 'Nouvelle quête',
      icon_url: AVATAR,
    },
    title: String(quest.name).slice(0, 256),
    url: quest.applicationLink || undefined,
    description: quest.preview ? '⚠️ Quête en aperçu (preview)' : undefined,
    color: parseColor(quest.primaryColor),
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: rewardThumb ? { url: rewardThumb } : undefined,
    footer: {
      text: 'Datamining · ID ' + quest.id,
    },
    timestamp: new Date().toISOString(),
  };
}

async function postWebhook(body) {
  if (!WEBHOOK) return { ok: false, status: 0, text: 'no webhook' };
  body.username = BOT_NAME;
  body.avatar_url = AVATAR;
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text: text.slice(0, 400) };
}

async function sendQuestWebhook(quest) {
  if (!WEBHOOK) {
    console.warn('Pas de QUEST_WEBHOOK_URL / DISCORD_WEBHOOK_URL');
    return false;
  }

  const emb = await postWebhook({
    embeds: [buildQuestEmbed(quest)],
  });
  if (emb.ok) {
    console.log('🔔 Quête envoyée: ' + quest.name + ' (' + quest.id + ')');
  } else {
    console.warn('Embed échoué', emb.status, emb.text);
  }
  await new Promise((r) => setTimeout(r, 400));
  return emb.ok;
}

async function fetchPublicQuests() {
  const res = await fetch(PUBLIC_QUESTS_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error('public quests HTTP ' + res.status);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.quests || data.data || [];
  return list.map(normalizeQuest).filter((q) => q.id);
}

async function fetchOfficialQuests() {
  if (!DISCORD_TOKEN) return [];
  const res = await fetch(OFFICIAL_QUESTS_URL, {
    headers: {
      Authorization: DISCORD_TOKEN,
      'User-Agent': UA,
      Accept: 'application/json',
    },
    timeout: 30000,
  });
  if (!res.ok) {
    console.warn('official /quests/@me', res.status);
    return [];
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.quests || [];
  return list.map(normalizeQuest).filter((q) => q.id);
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('🎮 Récupération des quêtes…');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.QUEST_WEBHOOK_URL
        ? 'QUEST_WEBHOOK_URL'
        : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );

  let quests = [];
  try {
    quests = await fetchPublicQuests();
    console.log('API publique: ' + quests.length + ' quêtes');
  } catch (e) {
    console.error('API publique échouée:', e.message);
    process.exitCode = 1;
  }

  try {
    const official = await fetchOfficialQuests();
    if (official.length) {
      const byId = new Map(quests.map((q) => [q.id, q]));
      for (const q of official)
        byId.set(q.id, Object.assign({}, byId.get(q.id) || {}, q));
      quests = Array.from(byId.values());
      console.log('Fusion officielle: ' + quests.length);
    }
  } catch (e) {
    console.warn('Quêtes officielles:', e.message);
  }

  if (!quests.length) {
    console.error('Aucune quête — abort');
    process.exit(1);
  }

  const now = Date.now();
  const active = quests.filter((q) => {
    const exp = q.expiresAt ? Date.parse(q.expiresAt) : null;
    const start = q.startsAt ? Date.parse(q.startsAt) : null;
    if (start && start > now + 7 * 86400000) return false;
    if (exp && exp < now) return false;
    return true;
  });
  console.log('Actives / à venir: ' + active.length);

  let previous = { ids: [] };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {}
  }
  const prevIds = new Set(previous.ids || []);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun
    ? []
    : active.filter((q) => !prevIds.has(q.id));
  const allIds = Array.from(
    new Set([].concat(Array.from(prevIds), active.map((q) => q.id))),
  );

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      count: active.length,
      ids: isFirstRun ? active.map((q) => q.id) : allIds,
      quests: active.map((q) => ({
        id: q.id,
        name: q.name,
        expiresAt: q.expiresAt,
        videoUrl: q.videoUrl || null,
        heroImage: q.heroImage || null,
      })),
    },
    { spaces: 2 },
  );

  if (isFirstRun) {
    console.log(
      'Premier run — seed de ' + active.length + ' ids (pas de flood)',
    );
    return;
  }

  console.log('Nouvelles quêtes: ' + newQuests.length);
  if (!WEBHOOK && newQuests.length) {
    console.warn('Nouvelles quêtes mais aucune webhook configurée');
  }
  for (const q of newQuests.slice(0, 15)) {
    await sendQuestWebhook(q);
  }
  console.log('✅ Quêtes terminé');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { normalizeQuest, buildQuestEmbed, main };
