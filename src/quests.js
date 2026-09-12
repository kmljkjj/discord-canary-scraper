/**
 * Suivi des quêtes Discord — embeds FR riches
 *
 * API publique (plat, sans .config) :
 *   https://api.discordquest.com/api/quests
 * Optionnel token : /api/v10/quests/@me
 *
 * Webhook : QUEST_WEBHOOK_URL (prioritaire) ou DISCORD_WEBHOOK_URL
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

const CDN = 'https://cdn.discordapp.com/';

/** Resolve Discord CDN asset path */
function assetUrl(questId, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  // Already full path: quests/ID/file.ext
  if (/^quests\//i.test(filename)) return CDN + filename.replace(/^\//, '');
  // Bare filename
  if (questId) return CDN + 'quests/' + questId + '/' + filename.replace(/^\//, '');
  return CDN + filename.replace(/^\//, '');
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

function formatDurationSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60) return n + ' s';
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (s === 0) return m + ' min';
  return m + ' min ' + s + ' s';
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
  const dur = formatDurationSeconds(seconds);

  const labels = {
    WATCH_VIDEO: 'Regarder la vidéo',
    WATCH_VIDEO_ON_MOBILE: 'Regarder la vidéo (mobile)',
    WATCH_VIDEO_ON_DESKTOP: 'Regarder la vidéo (bureau)',
    PLAY_ON_DESKTOP: 'Jouer sur bureau',
    PLAY_ON_XBOX: 'Jouer sur Xbox',
    PLAY_ON_PLAYSTATION: 'Jouer sur PlayStation',
    PLAY_ACTIVITY: 'Jouer à l’activité',
    STREAM_ON_DESKTOP: 'Streamer sur bureau',
    STREAM_ON_XBOX: 'Streamer sur Xbox',
    STREAM_ON_PLAYSTATION: 'Streamer sur PlayStation',
    ACHIEVEMENT: 'Débloquer un succès',
    ACHIEVEMENT_IN_ACTIVITY: 'Succès dans une activité',
  };

  let label = labels[raw] || null;
  if (!label) {
    if (/WATCH.*VIDEO.*MOBILE/i.test(raw)) label = 'Regarder la vidéo (mobile)';
    else if (/WATCH.*VIDEO/i.test(raw)) label = 'Regarder la vidéo';
    else if (/STREAM/i.test(raw)) label = 'Streamer';
    else if (/PLAY/i.test(raw)) label = 'Jouer';
    else label = String(key).replace(/_/g, ' ').toLowerCase();
  }

  if (dur) label += ' · **' + dur + '**';
  else if (target != null) label += ' · objectif `' + target + '`';

  const videoTitle =
    val && val.messages && (val.messages.video_title || val.messages.title);
  if (videoTitle) label += '\n　_' + String(videoTitle).slice(0, 80) + '_';

  return label;
}

function formatTasks(root) {
  const tc = root.task_config_v2 || root.task_config || {};
  const tasks = tc.tasks || {};
  const lines = [];
  for (const [key, val] of Object.entries(tasks)) {
    lines.push('• ' + taskLabelFr(key, val));
  }
  if (!lines.length) return null;
  const join =
    String(tc.join_operator || tc.operator || '').toUpperCase() === 'OR'
      ? '_Une seule tâche suffit_'
      : '_Toutes les tâches listées_';
  return join + '\n' + lines.join('\n');
}

function extractTaskVideos(root, questId) {
  const tc = root.task_config_v2 || root.task_config || {};
  const tasks = tc.tasks || {};
  const out = [];
  for (const [key, val] of Object.entries(tasks)) {
    const assets = (val && val.assets) || {};
    for (const ak of ['video', 'video_low_res', 'video_hls']) {
      const v = assets[ak];
      const url = v && (v.url || v);
      if (!url) continue;
      const full = assetUrl(questId, typeof url === 'string' ? url : null);
      if (full && !out.includes(full)) out.push(full);
    }
  }
  return out;
}

function formatDateFr(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi + ' UTC';
  } catch {
    return String(iso).slice(0, 19);
  }
}

function platformsFr(root) {
  const list =
    root.redeemable_platforms ||
    root.platforms ||
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
  const tasks = (root.task_config_v2 || root.task_config || {}).tasks || {};
  const keys = Object.keys(tasks).join(' ');
  const bits = [];
  if (/WATCH_VIDEO_ON_MOBILE|MOBILE|IOS|ANDROID/i.test(keys)) bits.push('Mobile');
  if (/DESKTOP|PLAY_ON_DESKTOP|STREAM_ON_DESKTOP|WATCH_VIDEO(?!_ON_MOBILE)/i.test(keys))
    bits.push('Bureau');
  if (/XBOX/i.test(keys)) bits.push('Xbox');
  if (/PLAYSTATION|PS5/i.test(keys)) bits.push('PlayStation');
  return bits.length ? bits.join(', ') : 'Multiplateforme';
}

/**
 * API publique = objet plat (pas de .config).
 * /quests/@me = parfois { id, config: {...}, preview }.
 */
function normalizeQuest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root =
    raw.config && typeof raw.config === 'object'
      ? { ...raw.config, id: raw.config.id || raw.id, preview: raw.preview }
      : raw;

  const id = String(root.id || raw.id || '');
  if (!id) return null;

  const messages = root.messages || {};
  const assets = root.assets || {};
  const app = root.application || {};
  const rewards =
    (root.rewards_config && root.rewards_config.rewards) ||
    root.rewards ||
    [];
  const colors = root.colors || {};

  const hero =
    assetUrl(id, assets.hero) ||
    assetUrl(id, assets.quest_bar_hero) ||
    assetUrl(id, assets.game_tile) ||
    assetUrl(id, assets.game_tile_dark) ||
    assetUrl(id, assets.game_tile_light);

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
  const taskVideos = extractTaskVideos(root, id);
  if (!videoUrl && taskVideos.length) videoUrl = taskVideos[0];

  return {
    id,
    name:
      messages.quest_name ||
      messages.questName ||
      messages.game_title ||
      app.name ||
      'Quête ' + id,
    gameTitle: messages.game_title || messages.gameTitle || app.name || null,
    publisher: messages.game_publisher || messages.gamePublisher || null,
    applicationId: app.id || null,
    applicationName: app.name || null,
    applicationLink: app.link || null,
    startsAt: root.starts_at || root.startsAt || null,
    expiresAt: root.expires_at || root.expiresAt || null,
    heroImage: hero,
    gameTile:
      assetUrl(id, assets.game_tile) ||
      assetUrl(id, assets.game_tile_dark) ||
      assetUrl(id, assets.game_tile_light),
    logotype:
      assetUrl(id, assets.logotype) ||
      assetUrl(id, assets.logotype_dark) ||
      assetUrl(id, assets.logotype_light),
    videoUrl,
    taskVideos,
    primaryColor: colors.primary || null,
    platforms: platformsFr(root),
    features: Array.isArray(root.features)
      ? root.features.map((f) => '`' + f + '`').join(' ')
      : null,
    rewards: (Array.isArray(rewards) ? rewards : []).map((r) => ({
      type: r.type,
      typeLabel: rewardTypeFr(r.type),
      name: (r.messages && (r.messages.name || r.messages.title)) || null,
      skuId: r.sku_id || r.skuId || null,
      orbQuantity:
        r.orb_quantity != null
          ? r.orb_quantity
          : r.orbQuantity != null
            ? r.orbQuantity
            : null,
      asset: assetUrl(id, r.asset),
      assetVideo: assetUrl(id, r.asset_video || r.assetVideo),
      redemptionLink: r.redemption_link || r.redemptionLink || null,
    })),
    tasksText: formatTasks(root),
    preview: !!(raw.preview || root.preview),
  };
}

function parseColor(hex) {
  if (!hex) return 0x5865f2;
  const s = String(hex).replace('#', '');
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? n : 0x5865f2;
}

function buildQuestEmbed(quest) {
  const start = formatDateFr(quest.startsAt);
  const end = formatDateFr(quest.expiresAt);
  let duree = '—';
  if (start && end) duree = start + ' → ' + end;
  else if (start) duree = 'À partir du ' + start;
  else if (end) duree = 'Jusqu’au ' + end;

  // Description style Discord Previews / modèle FR
  const desc = [];
  desc.push('**Durée**');
  desc.push(duree);
  desc.push('');
  desc.push('**Plateformes** · ' + (quest.platforms || 'Multiplateforme'));
  if (quest.gameTitle) desc.push('**Jeu** · ' + String(quest.gameTitle).slice(0, 180));
  if (quest.publisher) desc.push('**Éditeur** · ' + String(quest.publisher).slice(0, 120));
  if (quest.applicationName || quest.applicationId) {
    desc.push(
      '**Application** · ' +
        (quest.applicationName || 'App') +
        (quest.applicationId ? ' · `' + quest.applicationId + '`' : ''),
    );
  }
  if (quest.preview) desc.push('⚠️ _Quête en aperçu (preview)_');

  const fields = [];

  if (quest.tasksText) {
    fields.push({
      name: 'Tâches',
      value: quest.tasksText.slice(0, 1024),
      inline: false,
    });
  }

  const rewards = quest.rewards || [];
  if (rewards.length) {
    const rLines = [];
    for (const r of rewards.slice(0, 8)) {
      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';
      if (r.skuId) line += '\n　SKU `' + r.skuId + '`';
      if (r.redemptionLink) line += '\n　[Récupérer](' + r.redemptionLink + ')';
      rLines.push(line);
    }
    fields.push({
      name: 'Récompenses',
      value: rLines.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  const mediaLines = [];
  if (quest.videoUrl) mediaLines.push('[Vidéo principale](' + quest.videoUrl + ')');
  for (const v of (quest.taskVideos || []).slice(0, 4)) {
    if (v !== quest.videoUrl) mediaLines.push('[Vidéo tâche](' + v + ')');
  }
  if (mediaLines.length) {
    fields.push({
      name: 'Médias',
      value: mediaLines.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (quest.applicationLink) {
    fields.push({
      name: 'Lien',
      value: quest.applicationLink.slice(0, 1024),
      inline: false,
    });
  }

  fields.push({
    name: 'ID',
    value: '`' + quest.id + '`',
    inline: true,
  });

  const rewardThumb =
    (rewards.find((r) => r.asset) || {}).asset ||
    quest.gameTile ||
    quest.logotype ||
    null;

  return {
    author: {
      name: 'Nouvelle quête',
      icon_url: AVATAR,
    },
    title: String(quest.name).slice(0, 256),
    url: quest.applicationLink || undefined,
    description: desc.join('\n').slice(0, 4090),
    color: parseColor(quest.primaryColor),
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: rewardThumb ? { url: rewardThumb } : undefined,
    footer: {
      text: 'Datamining · Quêtes · ID ' + quest.id,
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
  const emb = await postWebhook({ embeds: [buildQuestEmbed(quest)] });
  if (emb.ok) {
    console.log('🔔 Quête envoyée:', quest.name, '(' + quest.id + ')');
  } else {
    console.warn('Embed échoué', emb.status, emb.text);
  }
  await new Promise((r) => setTimeout(r, 450));
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
  return list.map(normalizeQuest).filter(Boolean);
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
  return list.map(normalizeQuest).filter(Boolean);
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
    console.log('API publique:', quests.length, 'quêtes');
    const sample = quests.find((q) => q.name && !q.name.startsWith('Quête '));
    if (sample) {
      console.log('Sample OK:', sample.name, '| tasks:', !!sample.tasksText, '| rewards:', (sample.rewards || []).length, '| image:', !!sample.heroImage);
    } else {
      console.warn('Sample: noms/champs peut-être vides — vérifier normalize');
    }
  } catch (e) {
    console.error('API publique échouée:', e.message);
    process.exitCode = 1;
  }

  try {
    const official = await fetchOfficialQuests();
    if (official.length) {
      const byId = new Map(quests.map((q) => [q.id, q]));
      for (const q of official) {
        const prev = byId.get(q.id) || {};
        byId.set(q.id, { ...prev, ...q, rewards: q.rewards?.length ? q.rewards : prev.rewards });
      }
      quests = Array.from(byId.values());
      console.log('Fusion officielle:', quests.length);
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
    if (start && start > now + 14 * 86400000) return false;
    if (exp && exp < now) return false;
    return true;
  });
  console.log('Actives / à venir:', active.length);

  let previous = { ids: [] };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {}
  }
  const prevIds = new Set(previous.ids || []);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));
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
        rewardCount: (q.rewards || []).length,
      })),
    },
    { spaces: 2 },
  );

  if (isFirstRun) {
    console.log('Premier run — seed de', active.length, 'ids (pas de flood)');
    return;
  }

  console.log('Nouvelles quêtes:', newQuests.length);
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
