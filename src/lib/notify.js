/**
 * Webhook notifs — Wumpus-style: only real baseline diffs.
 * Never re-sends: caller must only pass items not already in baseline JSON.
 */
const fetch = require('node-fetch');

async function notifyAll({ build, isNewBuild, freshExps, freshStrings, webhookUrl }) {
  if (!webhookUrl) {
    console.log('No webhook');
    return;
  }

  const expList = Array.isArray(freshExps) ? freshExps : [];
  const strMap =
    freshStrings && typeof freshStrings === 'object' ? freshStrings : {};
  const strKeys = Object.keys(strMap);

  // 1) Build card (once per build number is caller's job)
  if (isNewBuild) {
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
                  expList.length ? `Experiments +${expList.length}` : null,
                  strKeys.length ? `Strings +${strKeys.length}` : null,
                ]
                  .filter(Boolean)
                  .join('\n') || 'Build bump',
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent build', build.buildNumber);
  }

  // 2) Experiments — ONE batched message only if truly new
  if (expList.length) {
    const lines = expList.slice(0, 40).map((e) => {
      const id = String(e.id);
      const type =
        e.type || e.kind || (/guild|server/i.test(id) ? 'guild' : 'user');
      return `+ **${id}** (${type})`;
    });
    const more =
      expList.length > 40 ? `\n… +${expList.length - 40} more` : '';
    const apex = expList.every(
      (e) => e.kind === 'apex' || (e.id && !String(e.id).includes('_')),
    );
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: apex ? 'New Apex Experiments' : 'New Experiments',
          description:
            lines.join('\n') + more + `\n\n**Build:** ${build.buildNumber}`,
          color: apex ? 0xfaa61a : 0xed4245,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent experiments', expList.length);
  }

  // 3) Strings — ONE message only if truly new
  if (strKeys.length) {
    const lines = [];
    for (const k of strKeys.slice(0, 40)) {
      const v = String(strMap[k]).replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`+ ${k}: ${v}`);
    }
    const more =
      strKeys.length > 40 ? `\n… +${strKeys.length - 40} more` : '';
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Strings',
          description:
            `Added (${strKeys.length})\n` +
            '```\n' +
            lines.join('\n') +
            more +
            '\n```',
          color: 0x57f287,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent strings', strKeys.length);
  }
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('webhook', res.status, body.embeds?.[0]?.title || '');
    if (!res.ok) console.warn('webhook fail', (await res.text()).slice(0, 200));
  } catch (e) {
    console.warn('webhook error', e.message);
  }
  await new Promise((r) => setTimeout(r, 400));
}

module.exports = { notifyAll };
