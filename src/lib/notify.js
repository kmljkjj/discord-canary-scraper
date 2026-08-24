/**
 * Discord Previews-style embeds + Wumpus-style content
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

async function notifyAll({ build, isNewBuild, diff, webhookUrl, stateDir }) {
  if (!webhookUrl) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }

  const seenPath = path.join(stateDir, 'seen.json');
  const claimPath = path.join(stateDir, 'claims.json');
  let seen = { experiments: [], stringKeys: [], routes: [] };
  let claims = {};
  try {
    if (await fs.pathExists(seenPath)) seen = await fs.readJson(seenPath);
  } catch {}
  try {
    if (await fs.pathExists(claimPath)) claims = await fs.readJson(claimPath);
  } catch {}

  const seenExp = new Set(seen.experiments || []);
  const seenStr = new Set(seen.stringKeys || []);
  const seenRt = new Set(seen.routes || []);

  const freshExps = (diff.newExperiments || []).filter((e) => !seenExp.has(e.id));
  const freshStr = {};
  for (const [k, v] of Object.entries(diff.strings.added || {})) {
    if (!seenStr.has(k)) freshStr[k] = v;
  }
  const freshRt = {};
  for (const [k, v] of Object.entries(diff.routes.added || {})) {
    if (!seenRt.has(k)) freshRt[k] = v;
  }

  const hasFresh =
    freshExps.length > 0 ||
    Object.keys(freshStr).length > 0 ||
    Object.keys(freshRt).length > 0 ||
    Object.keys(diff.strings.modified || {}).length > 0;

  console.log('Notify fresh:', {
    exp: freshExps.length,
    str: Object.keys(freshStr).length,
    routes: Object.keys(freshRt).length,
    isNewBuild,
  });

  // New build announce (once)
  if (isNewBuild) {
    const key = 'build:' + build.buildNumber;
    if (!claims[key]) {
      claims[key] = Date.now();
      await post(webhookUrl, {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'New Discord Canary Build',
            color: 0xed4245,
            fields: [
              { name: 'Build', value: String(build.buildNumber), inline: true },
              { name: 'Channel', value: 'canary', inline: true },
              {
                name: 'Hash',
                value: build.versionHash
                  ? '`' + build.versionHash.slice(0, 12) + '`'
                  : '—',
                inline: true,
              },
              {
                name: 'Delta',
                value: [
                  freshExps.length ? `Experiments +${freshExps.length}` : null,
                  Object.keys(freshStr).length
                    ? `Strings +${Object.keys(freshStr).length}`
                    : null,
                  Object.keys(freshRt).length
                    ? `Endpoints +${Object.keys(freshRt).length}`
                    : null,
                ]
                  .filter(Boolean)
                  .join('\n') || 'Build bump',
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
  }

  // Strings — Discord Previews / Wumpus style
  if (
    Object.keys(freshStr).length ||
    Object.keys(diff.strings.removed || {}).length ||
    Object.keys(diff.strings.modified || {}).length
  ) {
    const key =
      'strings:' +
      build.buildNumber +
      ':' +
      Object.keys(freshStr).sort().slice(0, 20).join(',');
    if (!claims[key] && (Object.keys(freshStr).length || Object.keys(diff.strings.modified || {}).length)) {
      claims[key] = Date.now();
      const lines = [];
      for (const [k, v] of Object.entries(freshStr).slice(0, 40))
        lines.push(`+ ${k}: ${String(v).slice(0, 120)}`);
      for (const [k, o] of Object.entries(diff.strings.modified || {}).slice(0, 15))
        lines.push(`~ ${k}: ${String(o.to).slice(0, 100)}`);
      for (const [k] of Object.entries(diff.strings.removed || {}).slice(0, 10))
        lines.push(`- ${k}`);

      if (lines.length) {
        await post(webhookUrl, {
          username: 'Canary Scraper',
          embeds: [
            {
              title: 'Strings',
              description:
                'Added · removed · modified\n```\n' +
                lines.join('\n').slice(0, 3800) +
                '\n```',
              color: 0x57f287,
              footer: { text: `Build Id - ${build.buildNumber}` },
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
    }
  }

  // Endpoints
  if (Object.keys(freshRt).length) {
    const key =
      'routes:' + build.buildNumber + ':' + Object.keys(freshRt).sort().join(',');
    if (!claims[key]) {
      claims[key] = Date.now();
      const lines = Object.entries(freshRt)
        .slice(0, 40)
        .map(([k, v]) => `+ ${k}: ${v}`);
      await post(webhookUrl, {
        username: 'Canary Scraper',
        embeds: [
          {
            title: 'Endpoints',
            description:
              'Added\n```\n' + lines.join('\n').slice(0, 3800) + '\n```',
            color: 0x5865f2,
            footer: { text: `Build Id - ${build.buildNumber}` },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
  }

  // Experiments — New Apex / New Experiment style
  for (const exp of freshExps.slice(0, 15)) {
    const key = 'exp:' + exp.id;
    if (claims[key]) continue;
    claims[key] = Date.now();
    const isApex = exp.kind === 'apex' || !String(exp.id).includes('_');
    const title = isApex ? 'New Apex Experiment' : 'New Experiment';
    const lines = [
      `+ **${exp.id}** (${exp.type || 'user'})`,
      `* Type **${exp.type || 'user'}**`,
      `Build: **${build.buildNumber}**`,
    ];
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title,
          description: lines.join('\n'),
          color: isApex ? 0xfaa61a : 0xed4245,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    seenExp.add(exp.id);
  }

  // Update permanent seen
  for (const k of Object.keys(freshStr)) seenStr.add(k);
  for (const k of Object.keys(freshRt)) seenRt.add(k);
  for (const e of freshExps) seenExp.add(e.id);

  await fs.writeJson(
    seenPath,
    {
      experiments: [...seenExp].slice(-8000),
      stringKeys: [...seenStr].slice(-25000),
      routes: [...seenRt].slice(-5000),
    },
    { spaces: 2 },
  );

  // prune claims
  const entries = Object.entries(claims);
  if (entries.length > 500) {
    entries.sort((a, b) => a[1] - b[1]);
    claims = Object.fromEntries(entries.slice(-400));
  }
  await fs.writeJson(claimPath, claims, { spaces: 2 });
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('webhook', res.status, body.embeds?.[0]?.title || '');
  if (!res.ok) {
    const t = await res.text();
    console.warn('webhook fail', t.slice(0, 200));
  }
  await new Promise((r) => setTimeout(r, 350));
}

module.exports = { notifyAll };
