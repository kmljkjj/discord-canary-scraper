const fetch = require('node-fetch');
const { log } = require('./logger');
const {
  claim,
  wasBuildAnnounced,
  hashPayload,
  takeNew,
  canSend,
  passCooldown,
} = require('./notify_guard');
const { formatStringsEmbed } = require('./strings_extract');
const { formatEndpointsEmbed } = require('./endpoints_extract');
const {
  formatNewUiDescription,
  formatExperimentWithUi,
} = require('./ui_experiments');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

async function postWebhook(payload, dedupeKey) {
  if (!WEBHOOK_URL) return false;
  if (dedupeKey) {
    const ok = await claim(dedupeKey);
    if (!ok) {
      await log.info('Webhook skipped (duplicate)', { dedupeKey });
      return false;
    }
  }
  if (!canSend()) {
    await log.info('Webhook skipped (run budget)', { dedupeKey: dedupeKey || null });
    return false;
  }
  if (!(await passCooldown())) {
    await log.info('Webhook skipped (cooldown)', { dedupeKey: dedupeKey || null });
    return false;
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    await log.warn('Webhook failed', { status: res.status, text: text.slice(0, 200) });
  } else {
    await log.info('Webhook sent', { dedupeKey: dedupeKey || null, status: res.status });
  }
  await new Promise((r) => setTimeout(r, 250));
  return res.ok;
}

function countKeys(obj) {
  return Object.keys(obj || {}).length;
}

async function notify({ build, isNewBuild, diff, stringDiff, endpointDiff, lineDiff }) {
  if (!WEBHOOK_URL) return;

  const addedStrKeys = Object.keys(stringDiff.added || {});
  const freshStrKeys = await takeNew('stringKeys', addedStrKeys);
  const addedEp = Object.keys(endpointDiff.added || {});
  const freshEp = await takeNew('endpoints', addedEp);
  const candExps = diff.newClientExperiments || [];
  const freshExpIds = await takeNew(
    'experiments',
    candExps.map((e) => e.id),
  );
  const freshExps = candExps.filter((e) => freshExpIds.includes(e.id));

  let freshUiItems = [];
  if (process.env.UI_NOTIFY === '1') {
    const freshUi = await takeNew(
      'ui',
      (diff.newUI || []).map((u) => u.name),
    );
    freshUiItems = (diff.newUI || []).filter((u) => freshUi.includes(u.name));
  }

  const hasFresh =
    freshStrKeys.length > 0 ||
    freshEp.length > 0 ||
    freshExps.length > 0 ||
    freshUiItems.length > 0;

  const alreadyAnnounced = await wasBuildAnnounced(build.buildNumber);

  if (!isNewBuild && !hasFresh) {
    await log.info('No notify (same build, no fresh delta)');
    return;
  }
  if (isNewBuild && alreadyAnnounced && !hasFresh) {
    await log.info('No notify (build already announced, no fresh content)', {
      build: build.buildNumber,
    });
    return;
  }

  const showLines =
    isNewBuild &&
    lineDiff &&
    !lineDiff.skipped &&
    lineDiff.meaningful !== false &&
    ((lineDiff.added || 0) + (lineDiff.removed || 0) > 0) &&
    !lineDiff.wholesale;
  const added = showLines ? lineDiff.added : 0;
  const removed = showLines ? lineDiff.removed : 0;

  const needBuildCard =
    (isNewBuild && !alreadyAnnounced) || (hasFresh && isNewBuild && !alreadyAnnounced);

  if (isNewBuild && !alreadyAnnounced) {
    const deltaParts = [
      freshExps.length ? `Experiments +${freshExps.length}` : null,
      freshStrKeys.length ? `Strings +${freshStrKeys.length}` : null,
      freshEp.length ? `Endpoints +${freshEp.length}` : null,
      freshUiItems.length ? `UI +${freshUiItems.length}` : null,
      showLines ? `Lines +${added}/−${removed}` : null,
    ].filter(Boolean);

    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'New Discord Canary Build',
            color: freshExps.length ? 0xed4245 : 0x57f287,
            fields: [
              { name: 'Build', value: String(build.buildNumber), inline: true },
              { name: 'Channel', value: 'canary', inline: true },
              {
                name: 'Lines',
                value: showLines ? `+${added} · −${removed}` : '—',
                inline: true,
              },
              {
                name: 'Delta',
                value: deltaParts.join('\n') || 'Build bump',
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `build-card:${build.buildNumber}`,
    );
  } else if (hasFresh) {
    // Content-only changes without build bump — one summary max
    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'Canary Changes',
            color: 0x5865f2,
            fields: [
              { name: 'Build', value: String(build.buildNumber), inline: true },
              {
                name: 'Delta',
                value: [
                  freshExps.length ? `Experiments +${freshExps.length}` : null,
                  freshStrKeys.length ? `Strings +${freshStrKeys.length}` : null,
                  freshEp.length ? `Endpoints +${freshEp.length}` : null,
                ]
                  .filter(Boolean)
                  .join('\n') || '—',
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `changes:${build.buildNumber}:${hashPayload({ s: freshStrKeys, e: freshEp, x: freshExpIds })}`,
    );
  }

  if (freshStrKeys.length) {
    const filtered = {
      added: Object.fromEntries(
        freshStrKeys.map((k) => [k, stringDiff.added[k]]).filter(([, v]) => v != null),
      ),
      removed: {},
      modified: {},
    };
    const emb = formatStringsEmbed(filtered, build.buildNumber);
    if (emb) {
      await postWebhook(
        { username: 'Canary Scraper', embeds: [emb] },
        `strings:${build.buildNumber}:${hashPayload(freshStrKeys.sort())}`,
      );
    }
  }

  if (freshEp.length) {
    const filtered = {
      added: Object.fromEntries(freshEp.map((k) => [k, endpointDiff.added[k]])),
      removed: {},
      modified: {},
    };
    const emb = formatEndpointsEmbed(filtered, build.buildNumber);
    if (emb) {
      await postWebhook(
        { username: 'Canary Scraper', embeds: [emb] },
        `endpoints:${build.buildNumber}:${hashPayload(freshEp.sort())}`,
      );
    }
  }

  for (const exp of freshExps.slice(0, 5)) {
    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [formatExperimentWithUi(exp, build.buildNumber)],
      },
      `exp:${exp.id}`,
    );
  }

  if (freshUiItems.length) {
    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'New UI',
            color: 0xf47b67,
            description: formatNewUiDescription(freshUiItems, build.buildNumber),
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `ui:${build.buildNumber}:${hashPayload(freshUiItems.map((u) => u.name).sort())}`,
    );
  }
}

module.exports = { notify, postWebhook, countKeys };
