/**
 * Canary Pulse — notifications
 * Supports: added (+) · modified (~) · removed (−)
 * for experiments, strings, routes
 */
const fetch = require('node-fetch');

const BOT_NAME = 'Canary Pulse';
const COLORS = {
  build: 0x5865f2,
  exp: 0x57f287,
  apex: 0xf0b232,
  strings: 0xeb459e,
  routes: 0x3498db,
  mixed: 0x9b59b6,
};

/**
 * @param {object} opts
 * @param {object} opts.build
 * @param {boolean} opts.isNewBuild
 * @param {object} opts.expDiff  { added:[], modified:[], removed:[] }
 * @param {object} opts.strDiff  { added:{}, modified:{}, removed:{} }
 * @param {object} opts.rtDiff   { added:{}, modified:{}, removed:{} }
 * @param {string} opts.webhookUrl
 */
async function notifyAll({
  build,
  isNewBuild,
  expDiff,
  strDiff,
  rtDiff,
  // legacy fallbacks
  freshExps,
  freshStrings,
  freshRoutes,
  webhookUrl,
}) {
  if (!webhookUrl) {
    console.log('No webhook');
    return;
  }

  const bn = String(build.buildNumber || '?');
  const hash = build.versionHash
    ? String(build.versionHash).slice(0, 12)
    : null;

  // Normalize diffs (support old callers)
  const exp = normalizeExpDiff(expDiff, freshExps);
  const str = normalizeMapDiff(strDiff, freshStrings);
  const rt = normalizeMapDiff(rtDiff, freshRoutes);

  const nExp =
    exp.added.length + exp.modified.length + exp.removed.length;
  const nStr =
    Object.keys(str.added).length +
    Object.keys(str.modified).length +
    Object.keys(str.removed).length;
  const nRt =
    Object.keys(rt.added).length +
    Object.keys(rt.modified).length +
    Object.keys(rt.removed).length;

  // ── Build card ────────────────────────────────────────
  if (isNewBuild) {
    const parts = [];
    if (nExp)
      parts.push(
        '`exp` +' +
          exp.added.length +
          ' ~' +
          exp.modified.length +
          ' −' +
          exp.removed.length,
      );
    if (nStr)
      parts.push(
        '`str` +' +
          Object.keys(str.added).length +
          ' ~' +
          Object.keys(str.modified).length +
          ' −' +
          Object.keys(str.removed).length,
      );
    if (nRt)
      parts.push(
        '`rt` +' +
          Object.keys(rt.added).length +
          ' ~' +
          Object.keys(rt.modified).length +
          ' −' +
          Object.keys(rt.removed).length,
      );

    await post(webhookUrl, {
      username: BOT_NAME,
      embeds: [
        {
          author: { name: 'Discord Canary' },
          title: 'Build ' + bn,
          description: parts.length
            ? parts.join(' · ')
            : 'Client bump — no catalog delta',
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

  // ── Experiments ───────────────────────────────────────
  if (nExp) {
    await sendExpDiff(webhookUrl, bn, exp);
  }

  // ── Strings ───────────────────────────────────────────
  if (nStr) {
    await sendMapDiff(webhookUrl, bn, str, {
      title: 'Strings',
      color: COLORS.strings,
      footer: 'Canary Pulse · i18n',
    });
  }

  // ── Routes ────────────────────────────────────────────
  if (nRt) {
    await sendMapDiff(webhookUrl, bn, rt, {
      title: 'API routes',
      color: COLORS.routes,
      footer: 'Canary Pulse · routes',
      valuePrefix: true,
    });
  }
}

function normalizeExpDiff(diff, legacy) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
    };
  }
  return {
    added: Array.isArray(legacy) ? legacy : [],
    modified: [],
    removed: [],
  };
}

function normalizeMapDiff(diff, legacy) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: diff.added && typeof diff.added === 'object' ? diff.added : {},
      modified:
        diff.modified && typeof diff.modified === 'object' ? diff.modified : {},
      removed:
        diff.removed && typeof diff.removed === 'object' ? diff.removed : {},
    };
  }
  return {
    added: legacy && typeof legacy === 'object' ? legacy : {},
    modified: {},
    removed: {},
  };
}

async function sendExpDiff(webhookUrl, bn, exp) {
  const blocks = [];

  if (exp.added.length) {
    blocks.push('**Added · ' + exp.added.length + '**');
    for (const e of exp.added.slice(0, 20)) {
      const id = typeof e === 'string' ? e : e.id;
      const type =
        (e && (e.type || e.kind)) ||
        (/guild|server/i.test(id) ? 'guild' : 'user');
      blocks.push('+ **' + id + '** (`' + type + '`)');
    }
    if (exp.added.length > 20)
      blocks.push('_+' + (exp.added.length - 20) + ' more_');
  }

  if (exp.modified.length) {
    blocks.push('');
    blocks.push('**Modified · ' + exp.modified.length + '**');
    for (const e of exp.modified.slice(0, 15)) {
      const id = typeof e === 'string' ? e : e.id;
      blocks.push('~ **' + id + '**');
    }
    if (exp.modified.length > 15)
      blocks.push('_+' + (exp.modified.length - 15) + ' more_');
  }

  if (exp.removed.length) {
    blocks.push('');
    blocks.push('**Removed · ' + exp.removed.length + '**');
    for (const e of exp.removed.slice(0, 15)) {
      const id = typeof e === 'string' ? e : e.id;
      blocks.push('− **' + id + '**');
    }
    if (exp.removed.length > 15)
      blocks.push('_+' + (exp.removed.length - 15) + ' more_');
  }

  blocks.push('');
  blocks.push('Build `' + bn + '`');

  const apexHeavy =
    exp.added.filter((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return id && !String(id).includes('_');
    }).length >=
    exp.added.length / 2;

  await post(webhookUrl, {
    username: BOT_NAME,
    embeds: [
      {
        title: 'Experiments',
        description: blocks.join('\n').slice(0, 3900),
        color: apexHeavy ? COLORS.apex : COLORS.exp,
        footer: { text: 'Canary Pulse · experiments · + ~ −' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
  console.log('Sent experiments diff', {
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
  });
}

async function sendMapDiff(webhookUrl, bn, diff, { title, color, footer, valuePrefix }) {
  const lines = [];
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);

  if (a.length) {
    lines.push('**Added · ' + a.length + '**');
    for (const k of a.slice(0, 25)) {
      const v = String(diff.added[k]).replace(/\s+/g, ' ').slice(0, 100);
      lines.push(
        valuePrefix
          ? '+ `' + k + '`\n→ `' + v + '`'
          : '+ `' + k + '` ' + v,
      );
    }
    if (a.length > 25) lines.push('_+' + (a.length - 25) + ' more_');
  }

  if (m.length) {
    lines.push('');
    lines.push('**Modified · ' + m.length + '**');
    for (const k of m.slice(0, 20)) {
      const v = String(diff.modified[k]).replace(/\s+/g, ' ').slice(0, 100);
      lines.push(
        valuePrefix
          ? '~ `' + k + '`\n→ `' + v + '`'
          : '~ `' + k + '` ' + v,
      );
    }
    if (m.length > 20) lines.push('_+' + (m.length - 20) + ' more_');
  }

  if (r.length) {
    lines.push('');
    lines.push('**Removed · ' + r.length + '**');
    for (const k of r.slice(0, 20)) {
      lines.push('− `' + k + '`');
    }
    if (r.length > 20) lines.push('_+' + (r.length - 20) + ' more_');
  }

  lines.push('');
  lines.push('Build `' + bn + '`');

  await post(webhookUrl, {
    username: BOT_NAME,
    embeds: [
      {
        title: title,
        description: lines.join('\n').slice(0, 3900),
        color,
        footer: { text: footer + ' · + ~ −' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
  console.log('Sent', title, { added: a.length, modified: m.length, removed: r.length });
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
