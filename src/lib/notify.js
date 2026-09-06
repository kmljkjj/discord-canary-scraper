/**
 * Orbit — original Discord embeds for Canary findings
 * Custom layout (not shared with other scrapers).
 */
const fetch = require('node-fetch');

const BOT = 'Orbit';
const PALETTE = {
  neon: 0x7c5cff,
  mint: 0x3dffb5,
  coral: 0xff6b8a,
  sky: 0x4fc3f7,
  ink: 0x1a1a2e,
};

async function notifyAll({
  build,
  isNewBuild,
  expDiff,
  strDiff,
  rtDiff,
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
  const ts = new Date().toISOString();
  const rel = '<t:' + Math.floor(Date.now() / 1000) + ':R>';

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

  if (isNewBuild) {
    const chips = [];
    if (nExp)
      chips.push(
        'experiments **' +
          signed(exp.added.length, exp.modified.length, exp.removed.length) +
          '**',
      );
    if (nStr)
      chips.push(
        'strings **' +
          signed(
            Object.keys(str.added).length,
            Object.keys(str.modified).length,
            Object.keys(str.removed).length,
          ) +
          '**',
      );
    if (nRt)
      chips.push(
        'routes **' +
          signed(
            Object.keys(rt.added).length,
            Object.keys(rt.modified).length,
            Object.keys(rt.removed).length,
          ) +
          '**',
      );

    await post(webhookUrl, {
      username: BOT,
      embeds: [
        {
          title: '◈ Canary · ' + bn,
          description:
            (chips.length
              ? chips.map((c) => '› ' + c).join('\n')
              : '› client bump — catalogs unchanged') +
            '\n\n' +
            'spotted ' +
            rel,
          color: PALETTE.neon,
          fields: [
            {
              name: 'channel',
              value: '`canary`',
              inline: true,
            },
            {
              name: 'hash',
              value: hash ? '`' + hash + '`' : '`—`',
              inline: true,
            },
            {
              name: 'build',
              value: '`' + bn + '`',
              inline: true,
            },
          ],
          footer: { text: 'Orbit · live canary radar' },
          timestamp: ts,
        },
      ],
    });
    console.log('Sent build', bn);
  }

  if (nExp) await sendExperiments(webhookUrl, bn, exp, ts);
  if (nStr) await sendCatalog(webhookUrl, bn, str, ts, 'strings');
  if (nRt) await sendCatalog(webhookUrl, bn, rt, ts, 'routes');
}

function signed(a, m, r) {
  const bits = [];
  if (a) bits.push('+' + a);
  if (m) bits.push('~' + m);
  if (r) bits.push('−' + r);
  return bits.join(' ') || '0';
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

function expCard(e) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const label = e && e.label ? String(e.label).slice(0, 72) : null;
  let depth = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    depth = e.treatments.length + ' treatments';
  else if (e && e.variations && typeof e.variations === 'object')
    depth = Object.keys(e.variations).length + ' variations';
  else if (e && e.treatmentCount) depth = e.treatmentCount + ' treatments';

  let body = '**`' + id + '`** · `' + kind + '`';
  if (label) body += '\n' + label;
  if (depth) body += '\n_' + depth + '_';
  return body;
}

async function sendExperiments(webhookUrl, bn, exp, ts) {
  const sections = [];

  if (exp.added.length) {
    sections.push('**◉ arrived · ' + exp.added.length + '**');
    for (const e of exp.added.slice(0, 16)) sections.push(expCard(e));
    if (exp.added.length > 16)
      sections.push('_… ' + (exp.added.length - 16) + ' more_');
  }

  if (exp.modified.length) {
    sections.push('');
    sections.push('**◎ shifted · ' + exp.modified.length + '**');
    for (const e of exp.modified.slice(0, 10)) sections.push(expCard(e));
    if (exp.modified.length > 10)
      sections.push('_… ' + (exp.modified.length - 10) + ' more_');
  }

  if (exp.removed.length) {
    sections.push('');
    sections.push('**◌ gone · ' + exp.removed.length + '**');
    for (const e of exp.removed.slice(0, 12)) {
      const id = typeof e === 'string' ? e : e.id;
      sections.push('`' + id + '`');
    }
    if (exp.removed.length > 12)
      sections.push('_… ' + (exp.removed.length - 12) + ' more_');
  }

  sections.push('');
  sections.push('build `' + bn + '`');

  await post(webhookUrl, {
    username: BOT,
    embeds: [
      {
        title: '◈ experiment radar',
        description: sections.join('\n').slice(0, 3900),
        color: PALETTE.mint,
        footer: { text: 'Orbit · experiment radar' },
        timestamp: ts,
      },
    ],
  });
  console.log('Sent experiments', {
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
  });
}

async function sendCatalog(webhookUrl, bn, diff, ts, kind) {
  const isRoutes = kind === 'routes';
  const title = isRoutes ? '◈ route map' : '◈ string lattice';
  const color = isRoutes ? PALETTE.sky : PALETTE.coral;
  const foot = isRoutes ? 'Orbit · route map' : 'Orbit · string lattice';

  const lines = [];
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);

  if (a.length) {
    lines.push('**◉ new · ' + a.length + '**');
    for (const k of a.slice(0, 22)) {
      const v = String(diff.added[k]).replace(/\s+/g, ' ').slice(0, 90);
      lines.push(
        isRoutes
          ? '`'+k+'`\n→ `'+v+'`'
          : '`'+k+'`  ' + v,
      );
    }
    if (a.length > 22) lines.push('_… ' + (a.length - 22) + ' more_');
  }

  if (m.length) {
    lines.push('');
    lines.push('**◎ rewritten · ' + m.length + '**');
    for (const k of m.slice(0, 18)) {
      const v = String(diff.modified[k]).replace(/\s+/g, ' ').slice(0, 90);
      lines.push(
        isRoutes
          ? '`'+k+'`\n→ `'+v+'`'
          : '`'+k+'`  ' + v,
      );
    }
    if (m.length > 18) lines.push('_… ' + (m.length - 18) + ' more_');
  }

  if (r.length) {
    lines.push('');
    lines.push('**◌ dropped · ' + r.length + '**');
    for (const k of r.slice(0, 18)) lines.push('`' + k + '`');
    if (r.length > 18) lines.push('_… ' + (r.length - 18) + ' more_');
  }

  lines.push('');
  lines.push('build `' + bn + '`');

  await post(webhookUrl, {
    username: BOT,
    embeds: [
      {
        title,
        description: lines.join('\n').slice(0, 3900),
        color,
        footer: { text: foot },
        timestamp: ts,
      },
    ],
  });
  console.log('Sent', kind, {
    added: a.length,
    modified: m.length,
    removed: r.length,
  });
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
  await new Promise((r) => setTimeout(r, 200));
}

module.exports = { notifyAll };
