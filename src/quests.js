/**
 * Discord Quests tracker
 *
 * Source: GET https://api.discordquest.com/api/quests  (public)
 * Optional: GET /api/v10/quests/@me with DISCORD_TOKEN
 *
 * Webhook (in order):
 *   1) QUEST_WEBHOOK_URL
 *   2) DISCORD_WEBHOOK_URL
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
const USE_COMPONENTS_V2 = process.env.QUEST_COMPONENTS_V2 === '1';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IS_COMPONENTS_V2 = 1 << 15;

function assetUrl(questId, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  return `https://cdn.discordapp.com/quests/${questId}/${filename}`;
}

function rewardTypeLabel(type) {
  const map = {
    1: 'In-game reward',
    2: 'Collectible',
    3: 'Virtual currency',
    4: 'Orbs',
    5: 'Fraction of Orbs',
  };
  return map[type] || `Type ${type}`;
}

function taskSummary(config) {
  const tc = config.task_config_v2 || config.task_config || {};
  const tasks = tc.tasks || {};
  const lines = [];
  for (const [key, val] of Object.entries(tasks)) {
    const target = val?.target ?? val?.target_seconds ?? '?';
    const type = val?.type || val?.event_name || key;
    lines.push(`• **${type}** — target \`${target}\``);
  }
  return lines.length ? lines.join('\n') : '_No task info_';
}

function normalizeQuest(raw) {
  const id = String(raw.id || raw.config?.id || '');
  const config = raw.config || {};
  const messages = config.messages || {};
  const assets = config.assets || {};
  const app = config.application || {};
  const rewards = config.rewards_config?.rewards || [];
  const colors = config.colors || {};

  const hero =
    assetUrl(id, assets.hero) ||
    assetUrl(id, assets.game_tile) ||
    assetUrl(id, assets.quest_bar_hero);

  let videoUrl = null;
  for (const key of ['hero_video', 'quest_bar_hero_video']) {
    if (assets[key]) {
      videoUrl = assetUrl(id, assets[key]);
      break;
    }
  }

  return {
    id,
    name: messages.quest_name || messages.game_title || app.name || `Quest ${id}`,
    gameTitle: messages.game_title || app.name || null,
    publisher: messages.game_publisher || null,
    applicationId: app.id || null,
    applicationLink: app.link || null,
    startsAt: config.starts_at || null,
    expiresAt: config.expires_at || null,
    heroImage: hero,
    gameTile: assetUrl(id, assets.game_tile),
    logotype: assetUrl(id, assets.logotype),
    videoUrl,
    primaryColor: colors.primary || null,
    rewards: rewards.map((r) => ({
      type: r.type,
      typeLabel: rewardTypeLabel(r.type),
      name: r.messages?.name || null,
      skuId: r.sku_id || null,
      orbQuantity: r.orb_quantity ?? null,
      asset: assetUrl(id, r.asset),
      assetVideo: assetUrl(id, r.asset_video),
      redemptionLink: r.redemption_link || null,
    })),
    tasksText: taskSummary(config),
    preview: !!raw.preview,
  };
}

async function fetchPublicQuests() {
  const res = await fetch(PUBLIC_QUESTS_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`public quests HTTP ${res.status}`);
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
  return (data.quests || []).map(normalizeQuest).filter((q) => q.id);
}

function parseColor(hex) {
  if (!hex || typeof hex !== 'string') return 0xfee75c;
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return Number.isFinite(n) ? n : 0xfee75c;
}

function buildClassicEmbed(quest) {
  const rewardText = (quest.rewards || [])
    .map((r) => {
      let line = `• ${r.typeLabel}`;
      if (r.name) line += `: ${r.name}`;
      if (r.orbQuantity != null) line += ` (×${r.orbQuantity})`;
      return line;
    })
    .join('\n')
    .slice(0, 1000);

  const fields = [
    quest.gameTitle && { name: 'Game', value: String(quest.gameTitle).slice(0, 256), inline: true },
    quest.publisher && {
      name: 'Publisher',
      value: String(quest.publisher).slice(0, 256),
      inline: true,
    },
    quest.startsAt && { name: 'Starts', value: quest.startsAt, inline: true },
    quest.expiresAt && { name: 'Expires', value: quest.expiresAt, inline: true },
    {
      name: 'Tasks',
      value: (quest.tasksText || '_none_').slice(0, 1024),
    },
    rewardText && { name: 'Rewards', value: rewardText },
    quest.videoUrl && { name: 'Video', value: quest.videoUrl.slice(0, 1024) },
    quest.applicationLink && {
      name: 'Link',
      value: quest.applicationLink.slice(0, 1024),
    },
  ].filter(Boolean);

  return {
    title: `New Quest — ${quest.name}`.slice(0, 256),
    description: `Quest ID: \`${quest.id}\`${quest.preview ? '\n⚠️ Preview' : ''}`,
    color: parseColor(quest.primaryColor),
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: quest.gameTile ? { url: quest.gameTile } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'Discord Quests' },
  };
}

function buildComponentsV2(quest) {
  const rewardLines = (quest.rewards || [])
    .map((r) => {
      let line = `• **${r.typeLabel}**`;
      if (r.name) line += `: ${r.name}`;
      if (r.orbQuantity != null) line += ` (×${r.orbQuantity})`;
      if (r.skuId) line += ` · \`${r.skuId}\``;
      return line;
    })
    .join('\n');

  const info = [
    `## ${quest.name}`,
    quest.gameTitle ? `**Game:** ${quest.gameTitle}` : null,
    quest.publisher ? `**Publisher:** ${quest.publisher}` : null,
    quest.startsAt ? `**Starts:** ${quest.startsAt}` : null,
    quest.expiresAt ? `**Expires:** ${quest.expiresAt}` : null,
    quest.preview ? '⚠️ **Preview quest**' : null,
  ]
    .filter(Boolean)
    .join('\n');

  const inner = [
    { type: 10, content: info },
    { type: 14, divider: true, spacing: 1 },
    { type: 10, content: `### Tasks\n${quest.tasksText}` },
  ];

  if (quest.heroImage) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({
      type: 12,
      items: [{ media: { url: quest.heroImage }, spoiler: false }],
    });
  }

  if (rewardLines) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: `### Rewards\n${rewardLines}` });
  }

  if (quest.videoUrl) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: `### Video\n${quest.videoUrl}` });
  }

  inner.push({ type: 14, divider: true, spacing: 1 });
  inner.push({ type: 10, content: `Quest ID: \`${quest.id}\`` });

  return [
    {
      type: 17,
      accent_color: parseColor(quest.primaryColor),
      spoiler: false,
      components: inner,
    },
  ];
}

async function postWebhook(body) {
  if (!WEBHOOK) return { ok: false, status: 0, text: 'no webhook' };
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
    console.warn('No QUEST_WEBHOOK_URL / DISCORD_WEBHOOK_URL — cannot notify');
    return false;
  }

  // Default: classic embed (reliable). V2 only if QUEST_COMPONENTS_V2=1
  if (USE_COMPONENTS_V2) {
    const v2 = await postWebhook({
      username: 'Discord Quests',
      flags: IS_COMPONENTS_V2,
      components: buildComponentsV2(quest),
    });
    if (v2.ok) {
      console.log(`🔔 V2 OK: ${quest.name} (${quest.id})`);
      await new Promise((r) => setTimeout(r, 500));
      return true;
    }
    console.warn('V2 failed, fallback embed', v2.status, v2.text);
  }

  const emb = await postWebhook({
    username: 'Discord Quests',
    embeds: [buildClassicEmbed(quest)],
  });
  if (emb.ok) {
    console.log(`🔔 Embed OK: ${quest.name} (${quest.id})`);
  } else {
    console.warn('Embed failed', emb.status, emb.text);
  }
  await new Promise((r) => setTimeout(r, 500));
  return emb.ok;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('🎮 Fetching Discord quests…');
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
    console.log(`Public API: ${quests.length} quests`);
  } catch (e) {
    console.error('Public API failed:', e.message);
    process.exitCode = 1;
  }

  try {
    const official = await fetchOfficialQuests();
    if (official.length) {
      const byId = new Map(quests.map((q) => [q.id, q]));
      for (const q of official) byId.set(q.id, { ...byId.get(q.id), ...q });
      quests = [...byId.values()];
      console.log(`Merged official: ${quests.length}`);
    }
  } catch (e) {
    console.warn('Official quests:', e.message);
  }

  if (!quests.length) {
    console.error('No quests fetched — abort');
    process.exit(1);
  }

  const now = Date.now();
  const active = quests.filter((q) => {
    const exp = q.expiresAt ? Date.parse(q.expiresAt) : null;
    const start = q.startsAt ? Date.parse(q.startsAt) : null;
    // keep upcoming (starts within 7d) and not expired
    if (start && start > now + 7 * 86400000) return false;
    if (exp && exp < now) return false;
    return true;
  });
  console.log(`Active/upcoming: ${active.length}`);

  let previous = { ids: [] };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }
  const prevIds = new Set(previous.ids || []);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun ? [] : active.filter((q) => !prevIds.has(q.id));
  // Keep known + currently active (don't lose history of seen ids)
  const allIds = [...new Set([...prevIds, ...active.map((q) => q.id)])];

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
    console.log(`First run — seeded ${active.length} quest ids (no flood)`);
    console.log('Next new quest will be posted to the webhook.');
    return;
  }

  console.log(`New quests: ${newQuests.length}`);
  if (!WEBHOOK && newQuests.length) {
    console.warn('New quests found but NO webhook configured');
  }
  for (const q of newQuests.slice(0, 15)) {
    await sendQuestWebhook(q);
  }
  console.log('✅ Quests check done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
