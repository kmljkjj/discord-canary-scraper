/**
 * Orbit webhook embeds — clean identity, fast delivery
 */
const fetch = require('node-fetch');

const BOT = process.env.ORBIT_BOT_NAME || 'Orbit';
// Clean indigo mark (Discord-adjacent palette)
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://api.dicebear.com/9.x/shapes/png?seed=orbit-canary&backgroundColor=5865f2&shape1Color=ffffff&shape2Color=eb459e&shape3Color=57f287&size=128';

const C = {
  build: 0x5865f2,
  exp: 0x57f287,
  str: 0xeb459e,
  route: 0xfee75c,
};

async function notifyAll({
  build,
  isNewBuild,
  expDiff,
  strDiff,
  rtDiff,
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

  const exp = normalizeExpDiff(expDiff);
  const str = normalizeMapDiff(strDiff);
  const rt = normalizeMapDiff(rtDiff);

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
    const parts = [];
    if (nExp)
      parts.push(
        'Experiments ' +
          signed(exp.added.length, exp.modified.length, exp.removed.length),
      );
    if (nStr)
      parts.push(
        'Strings ' +
          signed(
            Object.keys(str.added).length,
            Object.keys(str.modified).length,
            Object.keys(str.removed).length,
          ),
      );
    if (nRt)
      parts.push(
        'Routes ' +
          signed(
            Object.keys(rt.added).length,
            Object.keys(rt.modified).length,
            Object.keys(rt.removed).length,
          ),
      );

    await post(webhookUrl, {
      embeds: [
        {
          author: { name: 'Discord Canary', icon_url: AVATAR },
          title: 'Build ' + bn,
          description:
            (parts.length
              ? parts.map((p) => '• ' + p).join('\n')
              : '• Client bump — no catalog changes') +
            (hash ? '\n• Hash `' + hash + '`' : ''),
          color: C.build,
          footer: { text: 'Orbit' },
          timestamp: ts,
        },
      ],
    });
  }

  if (nExp) await sendExperiments(webhookUrl, bn, exp, ts);
  if (nStr) await sendCatalog(webhookUrl, bn, str, ts, 'strings');
  if (nRt) await sendCatalog(webhookUrl, bn, rt, ts, 'routes');
}

function signed(a, m, r) {
  const bits = [];
  if (a) bits.push('+' + a);
  if (m) bits.push('~' + m);
  if (r) bits.push('-' + r);
  return bits.join(' ') || '0';
}

function normalizeExpDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
    };
  }
  return { added: [], modified: [], removed: [] };
}

function normalizeMapDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: diff.added && typeof diff.added === 'object' ? diff.added : {},
      modified:
        diff.modified && typeof diff.modified === 'object' ? diff.modified : {},
      removed:
        diff.removed && typeof diff.removed === 'object' ? diff.removed : {},
    };
  }
  return { added: {}, modified: {}, removed: {} };
}

function expLine(e) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const label = e && e.label ? String(e.label).slice(0, 64) : null;
  let depth = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    depth = e.treatments.length + ' treatments';
  else if (e && e.variations && typeof e.variations === 'object')
    depth = Object.keys(e.variations).length + ' variations';
  else if (e && e.treatmentCount) depth = e.treatmentCount + ' treatments';

  let line = '`+' + id + '` · ' + kind;
  if (label) line += '\n' + label;
  if (depth) line += ' · _' + depth + '_';
  return line;
}

async function sendExperiments(webhookUrl, bn, exp, ts) {
  const lines = [];
  if (exp.added.length) {
    lines.push('**Added · ' + exp.added.length + '**');
    for (const e of exp.added.slice(0, 16)) lines.push(expLine(e));
    if (exp.added.length > 16)
      lines.push('_… +' + (exp.added.length - 16) + ' more_');
  }
  if (exp.modified.length) {
    if (lines.length) lines.push('');
    lines.push('**Updated · ' + exp.modified.length + '**');
    for (const e of exp.modified.slice(0, 10)) lines.push(expLine(e));
    if (exp.modified.length > 10)
      lines.push('_… +' + (exp.modified.length - 10) + ' more_');
  }
  if (exp.removed.length) {
    if (lines.length) lines.push('');
    lines.push('**Removed · ' + exp.removed.length + '**');
    for (const e of exp.removed.slice(0, 12)) {
      const id = typeof e === 'string' ? e : e.id;
      lines.push('`- ' + id + '`');
    }
    if (exp.removed.length > 12)
      lines.push('_… +' + (exp.removed.length - 12) + ' more_');
  }
  lines.push('');
  lines.push('Build `' + bn + '`');

  await post(webhookUrl, {
    embeds: [
      {
        author: { name: 'Experiments', icon_url: AVATAR },
        title: 'Canary experiments',
        description: lines.join('\n').slice(0, 3900),
        color: C.exp,
        footer: { text: 'Orbit' },
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
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);
  const lines = [];

  if (a.length) {
    lines.push('**Added · ' + a.length + '**');
    for (const k of a.slice(0, 22)) {
      const v = String(diff.added[k]).replace(/\s+/g, ' ').slice(0, 90);
      lines.push(
        isRoutes ? '`' + k + '` → `' + v + '`' : '`+' + k + '`  ' + v,
      );
    }
    if (a.length > 22) lines.push('_… +' + (a.length - 22) + ' more_');
  }
  if (m.length) {
    if (lines.length) lines.push('');
    lines.push('**Updated · ' + m.length + '**');
    for (const k of m.slice(0, 18)) {
      const v = String(diff.modified[k]).replace(/\s+/g, ' ').slice(0, 90);
      lines.push(
        isRoutes ? '`' + k + '` → `' + v + '`' : '`~' + k + '`  ' + v,
      );
    }
    if (m.length > 18) lines.push('_… +' + (m.length - 18) + ' more_');
  }
  if (r.length) {
    if (lines.length) lines.push('');
    lines.push('**Removed · ' + r.length + '**');
    for (const k of r.slice(0, 18)) lines.push('`- ' + k + '`' );
    if (r.length > 18) lines.push('_… +' + (r.length - 18) + ' more_');
  }
  lines.push('');
  lines.push('Build `' + bn + '`');

  await post(webhookUrl, {
    embeds: [
      {
        author: {
          name: isRoutes ? 'API routes' : 'Strings',
          icon_url: AVATAR,
        },
        title: isRoutes ? 'Canary routes' : 'Canary strings',
        description: lines.join('\n').slice(0, 3900),
        color: isRoutes ? C.route : C.str,
        footer: { text: 'Orbit' },
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
  body.username = BOT;
  body.avatar_url = AVATAR;
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
  await new Promise((r) => setTimeout(r, 80));
}

module.exports = { notifyAll };
