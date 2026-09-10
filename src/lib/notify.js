/**
 * Datamining — priority notify
 * URGENT = experiments (+ flash already sent)
 * NORMAL = strings / routes / optional summary
 */
const fetch = require('node-fetch');

const BOT = process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

const COLOR = {
  build: 0x5865f2,
  added: 0x57f287,
  modified: 0xe67e22,
  removed: 0xed4245,
};

function envEmoji(key) {
  const v = (process.env[key] || '').trim();
  if (/^<a?:[\w~]+:\d+>$/.test(v)) return v;
  return '';
}

const E = {
  added: envEmoji('EMOJI_ADDED'),
  modified: envEmoji('EMOJI_MODIFIED'),
  removed: envEmoji('EMOJI_REMOVED'),
  build: envEmoji('EMOJI_BUILD'),
  exp: envEmoji('EMOJI_EXP'),
  str: envEmoji('EMOJI_STR'),
  route: envEmoji('EMOJI_ROUTE'),
};

function label(emoji, text) {
  return emoji ? `${emoji} ${text}` : text;
}

const FIELD_MAX = 1000;
const LINE_VAL_MAX = 120;

/** Full pipeline (legacy) */
async function notifyAll(opts) {
  await notifyUrgent(opts);
  await notifyNormal(opts);
}

/** URGENT — experiments first */
async function notifyUrgent({
  build,
  expDiff,
  webhookUrl,
  isNewBuild,
  catchUp,
  prevBuild,
}) {
  if (!webhookUrl) return;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const exp = normalizeExpDiff(expDiff);
  const nExp =
    exp.added.length + exp.modified.length + exp.removed.length;

  if (nExp) {
    await sendExperiments(webhookUrl, bn, exp, ts);
  } else {
    console.log('Urgent: no experiment diff');
  }
}

/** NORMAL — strings + routes (+ light summary if needed) */
async function notifyNormal({
  build,
  strDiff,
  rtDiff,
  webhookUrl,
  isNewBuild,
}) {
  if (!webhookUrl) return;
  const bn = String(build.buildNumber || '?');
  const hash = build.versionHash
    ? String(build.versionHash).slice(0, 12)
    : null;
  const ts = new Date().toISOString();

  const str = normalizeMapDiff(strDiff);
  const rt = normalizeMapDiff(rtDiff);
  const nStr =
    Object.keys(str.added).length +
    Object.keys(str.modified).length +
    Object.keys(str.removed).length;
  const nRt =
    Object.keys(rt.added).length +
    Object.keys(rt.modified).length +
    Object.keys(rt.removed).length;

  if (isNewBuild && (nStr || nRt)) {
    await post(webhookUrl, {
      embeds: [
        {
          author: { name: 'Datamining', icon_url: AVATAR },
          title: label(E.build, `Catalog · ${bn}`),
          description: [
            hash ? `Hash \`${hash}\`` : null,
            channelLine(0, nStr, nRt),
          ]
            .filter(Boolean)
            .join('\n'),
          color: COLOR.build,
          footer: { text: `Build ${bn} · Datamining · normal` },
          timestamp: ts,
        },
      ],
    });
  }

  if (nStr) await sendMapDiff(webhookUrl, bn, str, ts, 'Strings');
  if (nRt) await sendMapDiff(webhookUrl, bn, rt, ts, 'Routes');
}

function channelLine(nExp, nStr, nRt) {
  const bits = [];
  if (nExp) bits.push(`${label(E.exp, 'Experiments')} **${nExp}**`);
  if (nStr) bits.push(`${label(E.str, 'Strings')} **${nStr}**`);
  if (nRt) bits.push(`${label(E.route, 'Routes')} **${nRt}**`);
  return bits.length ? bits.join(' · ') : '_no catalog changes_';
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

function cleanText(s, max = LINE_VAL_MAX) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function expLine(e, prefix) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const labelTxt = e && e.label ? cleanText(e.label, 70) : null;
  let depth = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    depth = `${e.treatments.length} treatments`;
  else if (e && e.variations && typeof e.variations === 'object')
    depth = `${Object.keys(e.variations).length} variations`;

  let line = `\`${prefix}${id}\` · **${kind}**`;
  if (labelTxt) line += `\n　${labelTxt}`;
  if (depth) line += ` · _${depth}_`;
  return line;
}

function chunkLines(lines, maxLen = FIELD_MAX) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (buf.length ? 1 : 0);
    if (len + add > maxLen && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [line];
      len = line.length;
    } else {
      buf.push(line);
      len += add;
    }
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

async function sendSectionEmbeds({ webhookUrl, title, bn, ts, sections }) {
  for (const sec of sections) {
    if (!sec.lines.length) continue;
    const chunks = chunkLines(sec.lines, FIELD_MAX);
    const embeds = [];

    const firstFields = chunks.slice(0, 5).map((c, i) => ({
      name: i === 0 ? sec.label : `… (${i + 1})`,
      value: c.slice(0, FIELD_MAX),
      inline: false,
    }));

    embeds.push({
      author: { name: 'Datamining', icon_url: AVATAR },
      title,
      description: `Build \`${bn}\` · **${sec.count}**`,
      fields: firstFields,
      color: sec.color,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });

    let offset = 5;
    while (offset < chunks.length && embeds.length < 8) {
      const slice = chunks.slice(offset, offset + 5);
      embeds.push({
        title: `${title} · suite`,
        fields: slice.map((c, i) => ({
          name: `… (${offset + i + 1})`,
          value: c.slice(0, FIELD_MAX),
          inline: false,
        })),
        color: sec.color,
        footer: { text: `Build ${bn} · Datamining` },
        timestamp: ts,
      });
      offset += 5;
    }

    for (let i = 0; i < embeds.length; i += 5) {
      await post(webhookUrl, { embeds: embeds.slice(i, i + 5) });
    }
  }
}

async function sendExperiments(webhookUrl, bn, exp, ts) {
  const sections = [];

  if (exp.added.length) {
    const lines = exp.added.slice(0, 40).map((e) => expLine(e, '+'));
    if (exp.added.length > 40)
      lines.push(`_… +${exp.added.length - 40} more_`);
    sections.push({
      label: label(E.added, `Added · ${exp.added.length}`),
      color: COLOR.added,
      count: exp.added.length,
      lines,
    });
  }
  if (exp.modified.length) {
    const lines = exp.modified.slice(0, 40).map((e) => expLine(e, '~'));
    if (exp.modified.length > 40)
      lines.push(`_… +${exp.modified.length - 40} more_`);
    sections.push({
      label: label(E.modified, `Modified · ${exp.modified.length}`),
      color: COLOR.modified,
      count: exp.modified.length,
      lines,
    });
  }
  if (exp.removed.length) {
    const lines = exp.removed.slice(0, 40).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `\`-${id}\``;
    });
    if (exp.removed.length > 40)
      lines.push(`_… +${exp.removed.length - 40} more_`);
    sections.push({
      label: label(E.removed, `Removed · ${exp.removed.length}`),
      color: COLOR.removed,
      count: exp.removed.length,
      lines,
    });
  }

  await sendSectionEmbeds({
    webhookUrl,
    title: label(E.exp, 'Experiments'),
    bn,
    ts,
    sections,
  });
  console.log('Sent experiments (URGENT)', {
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
  });
}

async function sendMapDiff(webhookUrl, bn, diff, ts, kind) {
  const isRoutes = kind === 'Routes';
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);
  const sections = [];
  const kindEmoji = isRoutes ? E.route : E.str;

  if (a.length) {
    const lines = a.slice(0, 60).map((k) => {
      const v = cleanText(diff.added[k], isRoutes ? 80 : LINE_VAL_MAX);
      return isRoutes ? `\`+${k}\` → \`${v}\`` : `\`+${k}\`\n${v}`;
    });
    if (a.length > 60) lines.push(`_… +${a.length - 60} more_`);
    sections.push({
      label: label(E.added, `Added · ${a.length}`),
      color: COLOR.added,
      count: a.length,
      lines,
    });
  }

  if (m.length) {
    const lines = m.slice(0, 50).map((k) => {
      const v = cleanText(diff.modified[k], isRoutes ? 80 : LINE_VAL_MAX);
      return isRoutes ? `\`~${k}\` → \`${v}\`` : `\`~${k}\`\n${v}`;
    });
    if (m.length > 50) lines.push(`_… +${m.length - 50} more_`);
    sections.push({
      label: label(E.modified, `Modified · ${m.length}`),
      color: COLOR.modified,
      count: m.length,
      lines,
    });
  }

  if (r.length) {
    const lines = r.slice(0, 50).map((k) => `\`-${k}\``);
    if (r.length > 50) lines.push(`_… +${r.length - 50} more_`);
    sections.push({
      label: label(E.removed, `Removed · ${r.length}`),
      color: COLOR.removed,
      count: r.length,
      lines,
    });
  }

  await sendSectionEmbeds({
    webhookUrl,
    title: label(kindEmoji, kind),
    bn,
    ts,
    sections,
  });
  console.log('Sent', kind, '(NORMAL)', {
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

module.exports = { notifyAll, notifyUrgent, notifyNormal };
