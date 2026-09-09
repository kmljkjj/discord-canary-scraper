/**
 * Datamining — embeds stylés
 * Vert = ajouté · Orange = modifié · Rouge = supprimé
 * Textes longs découpés pour rester dans les limites Discord.
 */
const fetch = require('node-fetch');

const BOT = process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

// Couleurs Discord-friendly
const COLOR = {
  build: 0x5865f2, // blurple
  added: 0x57f287, // vert
  modified: 0xe67e22, // orange
  removed: 0xed4245, // rouge
  neutral: 0x99aab5,
};

const DESC_MAX = 3900;
const FIELD_MAX = 1000;
const LINE_VAL_MAX = 120;

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
    await post(webhookUrl, {
      embeds: [
        {
          author: { name: 'Datamining', icon_url: AVATAR },
          title: `New Discord Canary Build · ${bn}`,
          description: [
            hash ? `Hash \`${hash}\`` : null,
            channelLine(nExp, nStr, nRt),
          ]
            .filter(Boolean)
            .join('\n'),
          fields: summaryFields(exp, str, rt),
          color: COLOR.build,
          footer: { text: `Build ${bn} · Datamining` },
          timestamp: ts,
        },
      ],
    });
  }

  if (nExp) await sendExperiments(webhookUrl, bn, exp, ts);
  if (nStr) await sendMapDiff(webhookUrl, bn, str, ts, 'Strings');
  if (nRt) await sendMapDiff(webhookUrl, bn, rt, ts, 'Routes');
}

function channelLine(nExp, nStr, nRt) {
  const bits = [];
  if (nExp) bits.push(`Experiments **${nExp}**`);
  if (nStr) bits.push(`Strings **${nStr}**`);
  if (nRt) bits.push(`Routes **${nRt}**`);
  return bits.length
    ? bits.join(' · ')
    : '_Client bump — no catalog changes_';
}

function summaryFields(exp, str, rt) {
  const fields = [];
  const push = (name, a, m, r, emoji) => {
    if (!(a || m || r)) return;
    const parts = [];
    if (a) parts.push(`\`+${a}\` added`);
    if (m) parts.push(`\`~${m}\` modified`);
    if (r) parts.push(`\`-${r}\` removed`);
    fields.push({
      name: `${emoji} ${name}`,
      value: parts.join('\n'),
      inline: true,
    });
  };
  push(
    'Experiments',
    exp.added.length,
    exp.modified.length,
    exp.removed.length,
    '🧪',
  );
  push(
    'Strings',
    Object.keys(str.added).length,
    Object.keys(str.modified).length,
    Object.keys(str.removed).length,
    '📝',
  );
  push(
    'Routes',
    Object.keys(rt.added).length,
    Object.keys(rt.modified).length,
    Object.keys(rt.removed).length,
    '🛣️',
  );
  return fields;
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
  const label = e && e.label ? cleanText(e.label, 70) : null;
  let depth = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    depth = `${e.treatments.length} treatments`;
  else if (e && e.variations && typeof e.variations === 'object')
    depth = `${Object.keys(e.variations).length} variations`;

  let line = `\`${prefix}${id}\` · **${kind}**`;
  if (label) line += `\n　${label}`;
  if (depth) line += ` · _${depth}_`;
  return line;
}

/** Découpe une liste de lignes en blocs ≤ maxLen */
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

async function sendSectionEmbeds({
  webhookUrl,
  title,
  bn,
  ts,
  sections,
}) {
  // sections: [{ label, color, lines, more }]
  for (const sec of sections) {
    if (!sec.lines.length) continue;
    const chunks = chunkLines(sec.lines, FIELD_MAX);
    const embeds = [];

    // Premier embed = titre + début
    const firstFields = chunks.slice(0, 5).map((c, i) => ({
      name: i === 0 ? sec.label : `… suite (${i + 1})`,
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

    // Embeds suivants si encore des chunks
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

    // Discord: max 10 embeds / message — on envoie par paquets de 5
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
      label: `🟢 Added · ${exp.added.length}`,
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
      label: `🟠 Modified · ${exp.modified.length}`,
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
      label: `🔴 Removed · ${exp.removed.length}`,
      color: COLOR.removed,
      count: exp.removed.length,
      lines,
    });
  }

  await sendSectionEmbeds({
    webhookUrl,
    title: 'Experiments',
    bn,
    ts,
    sections,
  });
  console.log('Sent experiments', {
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

  if (a.length) {
    const lines = a.slice(0, 60).map((k) => {
      const v = cleanText(diff.added[k], isRoutes ? 80 : LINE_VAL_MAX);
      return isRoutes
        ? `\`+${k}\` → \`${v}\``
        : `\`+${k}\`\n${v}`;
    });
    if (a.length > 60) lines.push(`_… +${a.length - 60} more_`);
    sections.push({
      label: `🟢 Added · ${a.length}`,
      color: COLOR.added,
      count: a.length,
      lines,
    });
  }

  if (m.length) {
    const lines = m.slice(0, 50).map((k) => {
      const v = cleanText(diff.modified[k], isRoutes ? 80 : LINE_VAL_MAX);
      return isRoutes
        ? `\`~${k}\` → \`${v}\``
        : `\`~${k}\`\n${v}`;
    });
    if (m.length > 50) lines.push(`_… +${m.length - 50} more_`);
    sections.push({
      label: `🟠 Modified · ${m.length}`,
      color: COLOR.modified,
      count: m.length,
      lines,
    });
  }

  if (r.length) {
    const lines = r.slice(0, 50).map((k) => `\`-${k}\``);
    if (r.length > 50) lines.push(`_… +${r.length - 50} more_`);
    sections.push({
      label: `🔴 Removed · ${r.length}`,
      color: COLOR.removed,
      count: r.length,
      lines,
    });
  }

  await sendSectionEmbeds({
    webhookUrl,
    title: kind,
    bn,
    ts,
    sections,
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
  await new Promise((r) => setTimeout(r, 120));
}

module.exports = { notifyAll };
