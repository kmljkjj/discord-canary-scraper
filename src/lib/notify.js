/**
 * Messages Discord Previews style:
 * - New Discord Canary Build
 * - Strings
 * - Endpoints
 * - New Apex Experiment / New Experiment
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

async function notifyAll({ build, isNewBuild, diff, webhookUrl, stateDir }) {
  if (!webhookUrl) {
    console.log('No webhook');
    return;
  }

  const sentPath = path.join(stateDir, 'sent.json');
  let sent = { builds: [], experiments: [], strings: [], routes: [] };
  try {
    if (await fs.pathExists(sentPath)) sent = await fs.readJson(sentPath);
  } catch {}

  const sentBuilds = new Set(sent.builds || []);
  const sentExp = new Set(sent.experiments || []);
  const sentStr = new Set(sent.strings || []);
  const sentRt = new Set(sent.routes || []);

  // 1) Nouveau build
  if (isNewBuild) {
    const key = String(build.buildNumber);
    if (!sentBuilds.has(key)) {
      const nExp = (diff.newExperiments || []).length;
      const nStr = Object.keys((diff.strings && diff.strings.added) || {}).length;
      const nRt = Object.keys((diff.routes && diff.routes.added) || {}).length;
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
                  ? '`' + String(build.versionHash).slice(0, 12) + '`'
                  : '—',
                inline: true,
              },
              {
                name: 'Delta',
                value:
                  [
                    nExp ? `Experiments +${nExp}` : null,
                    nStr ? `Strings +${nStr}` : null,
                    nRt ? `Endpoints +${nRt}` : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || 'Build bump',
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
      sentBuilds.add(key);
      console.log('Sent: New Discord Canary Build', key);
    }
  }

  // 2) Strings
  const addedStr = (diff.strings && diff.strings.added) || {};
  const modStr = (diff.strings && diff.strings.modified) || {};
  const remStr = (diff.strings && diff.strings.removed) || {};
  const strLines = [];
  for (const [k, v] of Object.entries(addedStr)) {
    if (sentStr.has(k)) continue;
    strLines.push(`+ ${k}: ${String(v).slice(0, 120)}`);
    sentStr.add(k);
  }
  for (const [k, o] of Object.entries(modStr)) {
    strLines.push(`~ ${k}: ${String(o.to || o).slice(0, 100)}`);
  }
  for (const [k] of Object.entries(remStr).slice(0, 15)) {
    strLines.push(`- ${k}`);
  }
  if (strLines.length) {
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Strings',
          description:
            'Added · removed · modified\n```\n' +
            strLines.slice(0, 45).join('\n').slice(0, 3800) +
            '\n```',
          color: 0x57f287,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent: Strings', strLines.length);
  }

  // 3) Endpoints
  const addedRt = (diff.routes && diff.routes.added) || {};
  const rtLines = [];
  for (const [k, v] of Object.entries(addedRt)) {
    if (sentRt.has(k)) continue;
    rtLines.push(`+ ${k}: ${v}`);
    sentRt.add(k);
  }
  if (rtLines.length) {
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Endpoints',
          description:
            'Added\n```\n' + rtLines.slice(0, 40).join('\n').slice(0, 3800) + '\n```',
          color: 0x5865f2,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent: Endpoints', rtLines.length);
  }

  // 4) Experiments — un message par experiment (style Discord Previews)
  const exps = diff.newExperiments || [];
  let sentCount = 0;
  for (const exp of exps) {
    const id = exp.id || exp;
    if (sentExp.has(id)) continue;
    const isApex = exp.kind === 'apex' || !String(id).includes('_');
    const title = isApex ? 'New Apex Experiment' : 'New Experiment';
    const type = exp.type || (/guild|server/i.test(id) ? 'guild' : 'user');
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title,
          description: [
            `+ **${id}** (${type})`,
            `* Type **${type}**`,
            `Build: **${build.buildNumber}**`,
          ].join('\n'),
          color: isApex ? 0xfaa61a : 0xed4245,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    sentExp.add(id);
    sentCount++;
    if (sentCount >= 20) break; // anti flood d'un coup
  }
  if (sentCount) console.log('Sent: Experiments', sentCount);

  await fs.writeJson(
    sentPath,
    {
      builds: [...sentBuilds].slice(-200),
      experiments: [...sentExp].slice(-8000),
      strings: [...sentStr].slice(-20000),
      routes: [...sentRt].slice(-5000),
    },
    { spaces: 2 },
  );
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const title = body.embeds && body.embeds[0] && body.embeds[0].title;
    console.log('webhook', res.status, title || '');
    if (!res.ok) {
      const t = await res.text();
      console.warn('webhook fail', t.slice(0, 250));
    }
  } catch (e) {
    console.warn('webhook error', e.message);
  }
  await new Promise((r) => setTimeout(r, 400));
}

module.exports = { notifyAll };
