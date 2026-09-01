/**
 * Canary Pulse — notifications for Discord Canary changes.
 * Original embed layout (not a third-party bot clone).
 * Caller must only pass items absent from the committed baseline.
 */
const fetch = require('node-fetch');

const BOT_NAME = 'Canary Pulse';
const COLORS = {
  build: 0x5865f2, // blurple
  apex: 0xf0b232, // gold
  exp: 0x57f287, // green
  strings: 0xeb459e, // pink
  routes: 0x3498db, // blue
};

async function notifyAll({
  build,
  isNewBuild,
  freshExps,
  freshStrings,
  freshRoutes,
  webhookUrl,
}) {
  if (!webhookUrl) {
    console.log('No webhook');
    return;
  }

  const expList = Array.isArray(freshExps) ? freshExps : [];
  const strMap =
    freshStrings && typeof freshStrings === 'object' ? freshStrings : {};
  const routeMap =
    freshRoutes && typeof freshRoutes === 'object' ? freshRoutes : {};
  const strKeys = Object.keys(strMap);
  const routeKeys = Object.keys(routeMap);
  const bn = String(build.buildNumber || '?');
  const hash = build.versionHash
    ? String(build.versionHash).slice(0, 12)
    : null;

  // ── Build summary ─────────────────────────────────────
  if (isNewBuild) {
    const deltaParts = [];
    if (expList.length) deltaParts.push('`' + expList.length + '` experiments');
    if (strKeys.length) deltaParts.push('`' + strKeys.length + '` strings');
    if (routeKeys.length) deltaParts.push('`' + routeKeys.length + '` routes');

    await post(webhookUrl, {
      username: BOT_NAME,
      embeds: [
        {
          author: { name: 'Discord Canary' },
          title: 'Build ' + bn,
          description: deltaParts.length
            ? deltaParts.join(' · ')
            : 'Client bump — no tracked catalog changes',
          color: COLORS.build,
          fields: [
            { name: 'Channel', value: '`canary`', inline: true },
            {
              name: 'Hash',
              value: hash ? '`' + hash + '`' : '—',
              inline: true,
            },
            {
              name: 'Detected',
              value: '<t:' + Math.floor(Date.now() / 1000) + ':R>',
              inline: true,
            },
          ],
          footer: { text: 'Canary Pulse · web client' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent build', bn);
  }

  // ── Experiments (batched) ─────────────────────────────
  if (expList.length) {
    const apex = [];
    const other = [];
    for (const e of expList) {
      const id = String(e.id);
      const type =
        e.type || e.kind || (/guild|server/i.test(id) ? 'guild' : 'user');
      const line =
        '**' +
        id +
        '**\n' +
        '└ scope `' +
        type +
        '`' +
        (e.label ? ' · ' + String(e.label).slice(0, 60) : '');
      if (e.kind === 'apex' || !id.includes('_')) apex.push(line);
      else other.push(line);
    }

    if (apex.length) {
      await post(webhookUrl, {
        username: BOT_NAME,
        embeds: [
          {
            title: 'Apex experiments · ' + apex.length + ' new',
            description:
              apex.slice(0, 25).join('\n\n') +
              (apex.length > 25 ? '\n\n_+' + (apex.length - 25) + ' more_' : '') +
              '\n\nBuild `' +
              bn +
              '`',
            color: COLORS.apex,
            footer: { text: 'Canary Pulse · experiments' },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
    if (other.length) {
      await post(webhookUrl, {
        username: BOT_NAME,
        embeds: [
          {
            title: 'Experiments · ' + other.length + ' new',
            description:
              other.slice(0, 25).join('\n\n') +
              (other.length > 25
                ? '\n\n_+' + (other.length - 25) + ' more_'
                : '') +
              '\n\nBuild `' +
              bn +
              '`',
            color: COLORS.exp,
            footer: { text: 'Canary Pulse · experiments' },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
    console.log('Sent experiments', expList.length);
  }

  // ── Strings ───────────────────────────────────────────
  if (strKeys.length) {
    const lines = [];
    for (const k of strKeys.slice(0, 35)) {
      const v = String(strMap[k]).replace(/\s+/g, ' ').trim().slice(0, 110);
      lines.push('`' + k + '` ' + v);
    }
    const more =
      strKeys.length > 35 ? '\n_+' + (strKeys.length - 35) + ' more_' : '';
    await post(webhookUrl, {
      username: BOT_NAME,
      embeds: [
        {
          title: 'Strings · +' + strKeys.length,
          description: lines.join('\n') + more + '\n\nBuild `' + bn + '`',
          color: COLORS.strings,
          footer: { text: 'Canary Pulse · i18n' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent strings', strKeys.length);
  }

  // ── Routes / endpoints ────────────────────────────────
  if (routeKeys.length && routeKeys.length <= 40) {
    const lines = [];
    for (const k of routeKeys.slice(0, 30)) {
      const path = String(routeMap[k]).slice(0, 80);
      lines.push('`' + k + '`\n→ `' + path + '`');
    }
    const more =
      routeKeys.length > 30 ? '\n_+' + (routeKeys.length - 30) + ' more_' : '';
    await post(webhookUrl, {
      username: BOT_NAME,
      embeds: [
        {
          title: 'API routes · +' + routeKeys.length,
          description: lines.join('\n\n') + more + '\n\nBuild `' + bn + '`',
          color: COLORS.routes,
          footer: { text: 'Canary Pulse · routes' },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent routes', routeKeys.length);
  } else if (routeKeys.length > 40) {
    console.log('Skip routes notify (too many):', routeKeys.length);
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
  await new Promise((r) => setTimeout(r, 450));
}

module.exports = { notifyAll };
