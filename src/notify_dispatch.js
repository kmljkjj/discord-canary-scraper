const fetch = require('node-fetch');
const { log } = require('./logger');
const {
  claim,
  wasBuildAnnounced,
  hashPayload,
  takeNew,
  canSend,
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
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    await log.warn('Webhook failed', {
      status: res.status,
      text: text.slice(0, 200),
    });
  } else {
    await log.info('Webhook sent', {
      dedupeKey: dedupeKey || null,
      status: res.status,
    });
  }
  await new Promise((r) => setTimeout(r, 400));
  return res.ok;
}

/**
 * Send real notifications:
 * - New build card (if not already announced by watch_build)
 * - Strings / Endpoints / Experiments that were NEVER seen before
 */
async function notify({ build, isNewBuild, diff, stringDiff, endpointDiff, lineDiff }) {
  if (!WEBHOOK_URL) {
    await log.warn('No DISCORD_WEBHOOK_URL');
    return;
  }

  // Permanent memory filter
  const freshStrKeys = await takeNew(
    'stringKeys',
    Object.keys(stringDiff.added || {}),
  );
  const freshEp = await takeNew(
    'endpoints',
    Object.keys(endpointDiff.added || {}),
  );
  const candExps = diff.newClientExperiments || [];
  const freshExpIds = await takeNew(
    'experiments',
    candExps.map((e) => e.id),
  );
  const freshExps = candExps.filter((e) => freshExpIds.includes(String(e.id)));

  let freshUiItems = [];
  if (process.env.UI_NOTIFY === '1') {
    const freshUi = await takeNew(
      'ui',
      (diff.newUI || []).map((u) => u.name),
    );
    freshUiItems = (diff.newUI || []).filter((u) =>
      freshUi.includes(String(u.name)),
    );
  }

  const hasFresh =
    freshStrKeys.length > 0 ||
    freshEp.length > 0 ||
    freshExps.length > 0 ||
    freshUiItems.length > 0;

  const alreadyAnnounced = await wasBuildAnnounced(build.buildNumber);

  await log.info('notify decision', {
    isNewBuild,
    alreadyAnnounced,
    freshStr: freshStrKeys.length,
    freshEp: freshEp.length,
    freshExp: freshExps.length,
    freshUi: freshUiItems.length,
  });

  if (!isNewBuild && !hasFresh) {
    await log.info('No notify (nothing new)');
    return;
  }

  const showLines =
    isNewBuild &&
    lineDiff &&
    !lineDiff.skipped &&
    lineDiff.meaningful !== false &&
    (lineDiff.added || 0) + (lineDiff.removed || 0) > 0 &&
    !lineDiff.wholesale;

  // Build summary once if new build and watch_build did not already post
  if (isNewBuild && !alreadyAnnounced) {
    const deltaParts = [
      freshExps.length ? `Experiments +${freshExps.length}` : null,
      freshStrKeys.length ? `Strings +${freshStrKeys.length}` : null,
      freshEp.length ? `Endpoints +${freshEp.length}` : null,
      showLines
        ? `Lines +${lineDiff.added}/−${lineDiff.removed}`
        : null,
    ].filter(Boolean);

    await postWebhook(
      {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'New Discord Canary Build',
            color: 0xed4245,
            fields: [
              { name: 'Build', value: String(build.buildNumber), inline: true },
              { name: 'Channel', value: 'canary', inline: true },
              {
                name: 'Lines',
                value: showLines
                  ? `+${lineDiff.added} · −${lineDiff.removed}`
                  : '—',
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
  }

  // Strings
  if (freshStrKeys.length) {
    const filtered = {
      added: Object.fromEntries(
        freshStrKeys
          .map((k) => [k, stringDiff.added[k]])
          .filter(([, v]) => v != null),
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

  // Endpoints
  if (freshEp.length) {
    const filtered = {
      added: Object.fromEntries(
        freshEp.map((k) => [k, endpointDiff.added[k]]),
      ),
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

  // Experiments — up to 12 per run
  for (const exp of freshExps.slice(0, 12)) {
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
            description: formatNewUiDescription(
              freshUiItems,
              build.buildNumber,
            ),
            timestamp: new Date().toISOString(),
          },
        ],
      },
      `ui:${build.buildNumber}:${hashPayload(
        freshUiItems.map((u) => u.name).sort(),
      )}`,
    );
  }
}

module.exports = { notify, postWebhook };
