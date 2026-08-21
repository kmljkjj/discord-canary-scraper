/**
 * Discord Quests tracker
 *
 * Source (public, no user token):
 *   GET https://api.discordquest.com/api/quests
 * Assets CDN:
 *   https://cdn.discordapp.com/quests/{questId}/{filename}
 *
 * Official (optional, needs user token):
 *   GET /api/v10/quests/@me
 *
 * Notifications → QUEST_WEBHOOK_URL (separate from canary scraper webhook)
 * Payload: Components V2 (flag IS_COMPONENTS_V2 = 1<<15)
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'quests.json');

const QUEST_WEBHOOK = process.env.QUEST_WEBHOOK_URL || null;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || null;
const PUBLIC_QUESTS_URL = 'https://api.discordquest.com/api/quests';
const OFFICIAL_QUESTS_URL = 'https://discord.com/api/v10/quests/@me';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// MessageFlags.IS_COMPONENTS_V2
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
  const video =
    assetUrl(id, assets.hero_video) ||
    assetUrl(id, assets.quest_bar_hero_video) ||
    assetUrl(id, assets.quest_bar_hero?.endsWith?.('.webm') ? assets.quest_bar_hero : null);

  // Prefer explicit video filenames
  let videoUrl = null;
  for (const key of ['hero_video', 'quest_bar_hero_video']) {
    if (assets[key]) {
      videoUrl = assetUrl(id, assets[key]);
      break;
    }
  }
  if (!videoUrl && assets.quest_bar_hero && /\.webm$/i.test(assets.quest_bar_hero)) {
    videoUrl = assetUrl(id, assets.quest_bar_hero);
  }

  return {
    id,
    name: messages.quest_name || messages.game_title || app.name || id,
    gameTitle: messages.game_title || app.name || null,
    publisher: messages.game_publisher || null,
    applicationId: app.id || null,
    applicationName: app.name || null,
    applicationLink: app.link || null,
    startsAt: config.starts_at || null,
    expiresAt: config.expires_at || null,
    heroImage: hero,
    videoUrl,
    logotype: assetUrl(id, assets.logotype),
    gameTile: assetUrl(id, assets.game_tile),
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
  if (!res.ok) throw new Error(`public quests ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.quests || [];
  return list.map(normalizeQuest).filter((q) => q.id);
}

async function fetchOfficialQuests() {
  if (!DISCORD_TOKEN) return [];
  const res = await fetch(OFFICIAL_QUESTS_URL, {
    headers: {
      Authorization: DISCORD_TOKEN.startsWith('Bot ') ? DISCORD_TOKEN : DISCORD_TOKEN,
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
  if (!hex || typeof hex !== 'string') return 0x5865f2;
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return Number.isFinite(n) ? n : 0x5865f2;
}

/** Components V2 payload (container + text + media gallery) */
function buildComponentsV2(quest) {
  const rewardLines = (quest.rewards || [])
    .map((r) => {
      let line = `• **${r.typeLabel}**`;
      if (r.name) line += `: ${r.name}`;
      if (r.orbQuantity != null) line += ` (×${r.orbQuantity})`;
      if (r.skuId) line += ` · \\`${r.skuId}\\``;
      return line;
    })
    .join('\n');

  const info = [
    `## ${quest.name}`,
    quest.gameTitle ? `**Game:** ${quest.gameTitle}` : null,
    quest.publisher ? `**Publisher:** ${quest.publisher}` : null,
    quest.startsAt ? `**Starts:** ${quest.startsAt}` : null,
    quest.expiresAt ? `**Expires:** ${quest.expiresAt}` : null,
    quest.applicationId ? `**App ID:** \\`${quest.applicationId}\\`` : null,
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

  // Reward images
  const rewardMedia = (quest.rewards || [])
    .map((r) => r.asset || r.assetVideo)
    .filter(Boolean)
    .slice(0, 4)
    .map((url) => ({ media: { url }, spoiler: false }));
  if (rewardMedia.length) {
    inner.push({ type: 12, items: rewardMedia });
  }

  if (quest.videoUrl) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: '### Video' });
    inner.push({
      type: 12,
      items: [{ media: { url: quest.videoUrl }, spoiler: false }],
    });
  }

  inner.push({ type: 14, divider: true, spacing: 1 });
  inner.push({ type: 10, content: `Quest ID: \\`${quest.id}\\`` });

  if (quest.applicationLink) {
    inner.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'Game / link',
          url: quest.applicationLink,
        },
      ],
    });
  }

  return [
    {
      type: 17,
      accent_color: parseColor(quest.primaryColor),
      spoiler: false,
      components: inner,
    },
  ];
}

async function sendQuestWebhook(quest) {
  if (!QUEST_WEBHOOK) {
    console.log('No QUEST_WEBHOOK_URL — skip notify');
    return;
  }

  const payload = {
    username: 'Discord Quests',
    flags: IS_COMPONENTS_V2,
    components: buildComponentsV2(quest),
  };

  const res = await fetch(QUEST_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn('Quest webhook failed', res.status, text.slice(0, 400));
    // Fallback classic embed if Components V2 rejected
    if (res.status === 400) {
      await sendQuestEmbedFallback(quest);
    }
  } else {
    console.log(`🔔 Quest notified: ${quest.name} (${quest.id})`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

async function sendQuestEmbedFallback(quest) {
  const fields = [
    quest.gameTitle && { name: 'Game', value: quest.gameTitle, inline: true },
    quest.publisher && { name: 'Publisher', value: quest.publisher, inline: true },
    quest.expiresAt && { name: 'Expires', value: quest.expiresAt, inline: true },
    { name: 'Tasks', value: quest.tasksText.slice(0, 1000) },
    quest.rewards?.length && {
      name: 'Rewards',
      value: quest.rewards
        .map((r) => `${r.typeLabel}${r.name ? `: ${r.name}` : ''}`)
        .join('\n')
        .slice(0, 1000),
    },
    quest.videoUrl && { name: 'Video', value: quest.videoUrl },
  ].filter(Boolean);

  const embed = {
    title: quest.name,
    description: `Quest ID: \\`${quest.id}\\``,
    color: parseColor(quest.primaryColor),
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: quest.gameTile ? { url: quest.gameTile } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: 'Discord Quests' },
  };

  await fetch(QUEST_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Discord Quests', embeds: [embed] }),
  });
  console.log(`🔔 Fallback embed: ${quest.name}`);
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('🎮 Fetching Discord quests…');

  let quests = [];
  try {
    quests = await fetchPublicQuests();
    console.log(`Public API: ${quests.length} quests`);
  } catch (e) {
    console.warn('Public API failed:', e.message);
  }

  try {
    const official = await fetchOfficialQuests();
    if (official.length) {
      const byId = new Map(quests.map((q) => [q.id, q]));
      for (const q of official) byId.set(q.id, { ...byId.get(q.id), ...q });
      quests = [...byId.values()];
      console.log(`Merged with official: ${quests.length}`);
    }
  } catch (e) {
    console.warn('Official quests:', e.message);
  }

  // Focus on “current” quests: started and not expired (or ending far future still listed)
  const now = Date.now();
  const active = quests.filter((q) => {
    const exp = q.expiresAt ? Date.parse(q.expiresAt) : null;
    const start = q.startsAt ? Date.parse(q.startsAt) : null;
    if (start && start > now + 86400000) return false; // starts >1d in future optional keep
    if (exp && exp < now) return false;
    return true;
  });

  let previous = { ids: [] };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }
  const prevIds = new Set(previous.ids || []);

  // First run: seed state without flooding
  const isFirstRun = !previous.ids || previous.ids.length === 0;
  const newQuests = isFirstRun
    ? []
    : active.filter((q) => !prevIds.has(q.id));

  const allIds = [...new Set([...active.map((q) => q.id), ...prevIds])];

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
        videoUrl: q.videoUrl,
      })),
    },
    { spaces: 2 },
  );

  if (isFirstRun) {
    console.log(`First run — seeded ${active.length} quest ids (no notify flood)`);
    return;
  }

  console.log(`New quests: ${newQuests.length}`);
  for (const q of newQuests.slice(0, 15)) {
    await sendQuestWebhook(q);
  }
  console.log('✅ Quests check done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
