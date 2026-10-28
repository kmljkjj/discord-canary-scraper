/**
 * Datamining — notify (classic embeds only — reliable on all webhooks)
 * - No backticks around keys
 * - Strings: phrase only (no hash key) · Routes: key + path
 * - Batch dedupe marked ONLY after successful webhook post
 *
 * NOTE: full rich experiment lines (variants / diffs / tags) pending re-apply
 * from local patch if this emergency restore landed first.
 */
const { sendEmbeds } = require('./webhook');
const { DEFAULT_BOT_NAME, DEFAULT_AVATAR_URL } = require('./utils');

const BOT = process.env.WEBHOOK_BOT_NAME || DEFAULT_BOT_NAME;
const AVATAR = process.env.WEBHOOK_AVATAR_URL || DEFAULT_AVATAR_URL;

const {
  markPosted,
  markFailed,
  claimPosted,
  wasPosted,
  payloadFingerprint,
  stableExpKey,
  stableExpEventKey,
  stableMapKey,
} = require('./webhook_dedupe');

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

const FIELD_MAX = 1020;
const LINE_VAL_MAX = 240;
const LINE_VAL_ROUTES = 100;
// Plus de troncature silencieuse : tout est envoyé (découpé en plusieurs messages)
const MAX_STR_LINES = 1000;
const MAX_RT_LINES = 1000;
const MAX_EXP_LINES = 300;

async function notifyAll(opts) {
  const [a, b] = await Promise.all([notifyUrgent(opts), notifyNormal(opts)]);
  return a && b;
}

async function notifyUrgent({ build, expDiff, webhookUrl }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const exp = normalizeExpDiff(expDiff);
  const nExp =
    exp.added.length +
    exp.modified.length +
    exp.removed.length +
    (exp.categoryChanged || []).length;
  if (!nExp) {
    console.log('Urgent: no experiment diff');
    return true;
  }
  return sendExperiments(webhookUrl, bn, exp, ts);
}

async function notifyNormal({ build, strDiff, rtDiff, webhookUrl }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
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
  let ok = true;
  const promises = [];
  if (nStr)
    promises.push(
      sendMapDiff(webhookUrl, bn, str, ts, 'Strings').then((r) => {
        if (!r) ok = false;
      }),
    );
  if (nRt)
    promises.push(
      sendMapDiff(webhookUrl, bn, rt, ts, 'Routes').then((r) => {
        if (!r) ok = false;
      }),
    );
  if (promises.length) await Promise.all(promises);
  return ok;
}

function normalizeExpDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed || diff.categoryChanged)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
      categoryChanged: Array.isArray(diff.categoryChanged) ? diff.categoryChanged : [],
    };
  }
  return { added: [], modified: [], removed: [], categoryChanged: [] };
}

function normalizeMapDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: diff.added && typeof diff.added === 'object' ? diff.added : {},
      modified: diff.modified && typeof diff.modified === 'object' ? diff.modified : {},
      removed: diff.removed && typeof diff.removed === 'object' ? diff.removed : {},
    };
  }
  return { added: {}, modified: {}, removed: {} };
}

function cleanText(s, max = LINE_VAL_MAX) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stringLine(prefix, key, value, maxVal) {
  const v = cleanText(value, maxVal);
  if (!v) {
    const k = String(key || '').replace(/`/g, "'");
    return k;
  }
  return v;
}

function routeLine(prefix, key, value) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, LINE_VAL_ROUTES);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k} → ${v}`;
}

/** Auto tags from experiment id (max 5). */
const EXP_TAG_RULES = [
  [/shop|store|collectible|sku/i, 'shop'],
  [/nitro|premium|subscription|billing|purchase/i, 'nitro'],
  [/marketing|upsell|fatigue|promo|incentive/i, 'marketing'],
  [/voice|rtc|audio|call|stage|go.?live|stream/i, 'voice'],
  [/video|camera|clips/i, 'video'],
  [/member.?list|guild.?list|tooltip/i, 'member-list'],
  [/profile|display.?name|avatar|banner|nameplate|decor/i, 'profile'],
  [/server.?tag|clan.?tag|guild.?tag/i, 'server-tag'],
  [/invite|referral|referr/i, 'invite'],
  [/quest|orb|reward/i, 'quests'],
  [/sticker|emoji|expression/i, 'emoji'],
  [/mobile|ios|android/i, 'mobile'],
  [/web\\b|browser/i, 'web'],
  [/dm\\b|gdm|group.?dm|message/i, 'chat'],
  [/moderat|automod|safety|report/i, 'safety'],
  [/onboard|welcome|tutorial/i, 'onboarding'],
  [/search|discovery|directory/i, 'discovery'],
  [/activity|activities|game|play/i, 'activities'],
  [/notif|toast|badge/i, 'notifications'],
  [/macaron|best.?buy/i, 'promo-partner'],
];

function experimentTags(id) {
  const s = String(id || '');
  const tags = [];
  const seen = new Set();
  for (const [re, tag] of EXP_TAG_RULES) {
    if (re.test(s) && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length >= 5) break;
  }
  return tags;
}

function formatConfigValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return cleanText(v, 48);
  if (typeof v === 'object') return cleanText(JSON.stringify(v), 48);
  return String(v);
}

function formatVariantLine(key, obj) {
  if (!obj || typeof obj !== 'object') return `V${key}`;
  const parts = [];
  for (const k of Object.keys(obj).sort()) {
    if (k === 'id') continue;
    parts.push(`${k}=${formatConfigValue(obj[k])}`);
    if (parts.length >= 5) break;
  }
  if (!parts.length && obj.label) return `V${key} ${cleanText(obj.label, 60)}`;
  if (!parts.length) return `V${key}`;
  return `V${key} ${parts.join(' · ')}`;
}

function getVariationsMap(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.variations && typeof e.variations === 'object' && !Array.isArray(e.variations))
    return e.variations;
  if (Array.isArray(e.treatments)) {
    const out = {};
    e.treatments.forEach((t, i) => {
      out[String(i)] = t && typeof t === 'object' ? t : { value: t };
    });
    return out;
  }
  return null;
}

function formatVariantsBlock(e, maxVariants = 6) {
  const vars = getVariationsMap(e);
  if (!vars) return [];
  const keys = Object.keys(vars).sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)),
  );
  if (!keys.length) return [];
  const lines = [];
  for (const k of keys.slice(0, maxVariants)) lines.push(formatVariantLine(k, vars[k]));
  if (keys.length > maxVariants) lines.push(`… +${keys.length - maxVariants} variants`);
  return lines;
}

function flatConfig(prefix, obj, out, maxKeys = 12) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj).sort()) {
    if (out.length >= maxKeys) {
      out.push('…');
      return;
    }
    out.push(`${prefix}${k}: ${formatConfigValue(obj[k])}`);
  }
}

function computeExpConfigDiff(before, after) {
  const lines = [];
  if (!before || !after) return lines;
  const bl = (before.label || before.title || '').trim();
  const al = (after.label || after.title || '').trim();
  if (bl !== al) lines.push(`label: ${bl || '—'} → ${al || '—'}`);
  const bdc = before.defaultConfig && typeof before.defaultConfig === 'object' ? before.defaultConfig : {};
  const adc = after.defaultConfig && typeof after.defaultConfig === 'object' ? after.defaultConfig : {};
  for (const k of [...new Set([...Object.keys(bdc), ...Object.keys(adc)])].sort()) {
    const bv = bdc[k];
    const av = adc[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    if (bv === undefined) lines.push(`+ defaultConfig.${k}: ${formatConfigValue(av)}`);
    else if (av === undefined) lines.push(`- defaultConfig.${k}: ${formatConfigValue(bv)}`);
    else lines.push(`defaultConfig.${k}: ${formatConfigValue(bv)} → ${formatConfigValue(av)}`);
    if (lines.length >= 14) break;
  }
  const bv = getVariationsMap(before) || {};
  const av = getVariationsMap(after) || {};
  for (const k of [...new Set([...Object.keys(bv), ...Object.keys(av)])].sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)),
  )) {
    if (lines.length >= 18) {
      lines.push('…');
      break;
    }
    const bvo = bv[k];
    const avo = av[k];
    if (bvo == null && avo != null) {
      lines.push(`+ ${formatVariantLine(k, avo)}`);
      continue;
    }
    if (avo == null && bvo != null) {
      lines.push(`- V${k}`);
      continue;
    }
    if (!bvo || !avo) continue;
    for (const ck of [...new Set([...Object.keys(bvo), ...Object.keys(avo)])].sort()) {
      if (ck === 'id') continue;
      if (JSON.stringify(bvo[ck]) === JSON.stringify(avo[ck])) continue;
      if (bvo[ck] === undefined) lines.push(`+ V${k}.${ck}: ${formatConfigValue(avo[ck])}`);
      else if (avo[ck] === undefined) lines.push(`- V${k}.${ck}: ${formatConfigValue(bvo[ck])}`);
      else lines.push(`V${k}.${ck}: ${formatConfigValue(bvo[ck])} → ${formatConfigValue(avo[ck])}`);
      if (lines.length >= 18) break;
    }
  }
  return lines.slice(0, 18);
}

function expLine(e, prefix) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const system = (e && e.system) || (e && e.treatments ? 'legacy' : 'apex');
  const labelTxt = e && (e.label || e.title) ? cleanText(e.label || e.title, 80) : null;
  let nVar = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length) nVar = e.treatments.length;
  else if (e && e.variations && typeof e.variations === 'object') nVar = Object.keys(e.variations).length;
  else if (e && e.variationCount) nVar = e.variationCount;
  let line = `${prefix} ${id}`;
  const meta = [];
  if (kind) meta.push(`Type ${kind}`);
  if (system) meta.push(system);
  if (nVar != null) meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);
  let pct = null;
  const k = String(kind || '').toLowerCase();
  if ((k === 'guild' || k === 'server') && e && e.guildPercentage && e.guildPercentage.status !== 'unknown')
    pct = e.guildPercentage;
  else if (k === 'user' && e && e.userPercentage && e.userPercentage.status !== 'unknown') pct = e.userPercentage;
  else if (e && e.guildPercentage && e.guildPercentage.status !== 'unknown') pct = e.guildPercentage;
  else if (e && e.userPercentage && e.userPercentage.status !== 'unknown') pct = e.userPercentage;
  if (pct && pct.value != null) meta.push(`${pct.value}% (${pct.status})`);
  const tags = experimentTags(id);
  if (tags.length) meta.push(`tags ${tags.join(', ')}`);
  if (meta.length) line += `\n${meta.join(' · ')}`;
  if (labelTxt) line += `\n${labelTxt}`;
  if (prefix === '~' && e && e._before) {
    const diffs = computeExpConfigDiff(e._before, e);
    if (diffs.length) {
      line += '\n' + diffs.join('\n');
      return line;
    }
  }
  if (e && typeof e === 'object') {
    if (e.defaultConfig && typeof e.defaultConfig === 'object') {
      const dcLines = [];
      flatConfig('', e.defaultConfig, dcLines, 8);
      if (dcLines.length) {
        line += '\ndefaultConfig';
        for (const l of dcLines) line += `\n  ${l}`;
      }
    }
    const vLines = formatVariantsBlock(e, 6);
    if (vLines.length) line += '\n' + vLines.join('\n');
  }
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

async function sendSectionEmbeds({ webhookUrl, title, bn, ts, sections, batchKey, identity }) {
  let ok = true;
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    if (!sec.lines.length) continue;
    const chunks = chunkLines(sec.lines, FIELD_MAX);
    const embeds = [];
    const firstFields = chunks.slice(0, 5).map((c, i) => ({
      name: i === 0 ? sec.label : `… (${i + 1})`,
      value: String(c).slice(0, FIELD_MAX),
      inline: false,
    }));
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title,
      description: `Build ${bn} · **${sec.count}**`,
      fields: firstFields,
      color: sec.color,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });
    let offset = 5;
    // (avant : limité à 8 embeds → les chunks suivants n'étaient jamais envoyés)
    while (offset < chunks.length) {
      const slice = chunks.slice(offset, offset + 5);
      embeds.push({
        title: `${title} · suite`,
        fields: slice.map((c, i) => ({
          name: `… (${offset + i + 1})`,
          value: String(c).slice(0, FIELD_MAX),
          inline: false,
        })),
        color: sec.color,
        footer: { text: `Build ${bn} · Datamining` },
        timestamp: ts,
      });
      offset += 5;
    }
    // 1 embed par post : chaque message reste sous la limite Discord
    // (4000 caractères de texte par message Components V2)
    // Clé de dedupe unique par (lot, section, partie). Avant : empreinte du
    // contenu tronqué → deux messages « … suite » qui commençaient pareil
    // (ou identiques à un message d'un build précédent < 24 h) étaient
    // considérés comme déjà envoyés et JAMAIS postés.
    for (let i = 0; i < embeds.length; i++) {
      const key = batchKey ? `${batchKey}:s${si}:p${i}:${embeds.length}` : null;
      const r = await post(webhookUrl, { embeds: [embeds[i]] }, key, identity);
      if (!r) ok = false;
    }
  }
  return ok;
}

async function sendExperiments(webhookUrl, bn, exp, ts) {
  const batchKey = 'expbatch:' + stableExpKey(bn, exp);
  if (!(await claimPosted(batchKey))) {
    console.log('Experiments batch CLAIM skip', batchKey);
    return true;
  }

  // Per-event filter: drop items already sent (partial batch recovery)
  const filterEv = async (list, changeType) => {
    const out = [];
    for (const e of list || []) {
      const id = typeof e === 'string' ? e : e && e.id;
      if (!id) {
        out.push(e);
        continue;
      }
      const ek = 'expev:' + stableExpEventKey(bn, changeType, e);
      if (await wasPosted(ek)) continue;
      out.push(e);
    }
    return out;
  };
  exp = {
    ...exp,
    added: await filterEv(exp.added, 'added'),
    modified: await filterEv(exp.modified, 'modified'),
    removed: await filterEv(exp.removed, 'removed'),
    categoryChanged: await filterEv(exp.categoryChanged, 'category'),
  };
  const total =
    exp.added.length +
    exp.modified.length +
    exp.removed.length +
    (exp.categoryChanged || []).length;
  if (!total) {
    await markPosted(batchKey);
    console.log('Experiments all events already sent — skip');
    return true;
  }

  const sections = [];
  if (exp.added.length) {
    const lines = exp.added.slice(0, MAX_EXP_LINES).map((e) => expLine(e, '+'));
    if (exp.added.length > MAX_EXP_LINES) lines.push(`… +${exp.added.length - MAX_EXP_LINES} more`);
    sections.push({
      label: label(E.added, `Added · ${exp.added.length}`),
      color: COLOR.added,
      count: exp.added.length,
      lines,
    });
  }
  if (exp.modified.length) {
    const lines = exp.modified.slice(0, MAX_EXP_LINES).map((e) => expLine(e, '~'));
    if (exp.modified.length > MAX_EXP_LINES) lines.push(`… +${exp.modified.length - MAX_EXP_LINES} more`);
    sections.push({
      label: label(E.modified, `Modified · ${exp.modified.length}`),
      color: COLOR.modified,
      count: exp.modified.length,
      lines,
    });
  }
  if ((exp.categoryChanged || []).length) {
    const lines = exp.categoryChanged.slice(0, MAX_EXP_LINES).map((e) => {
      const id = e.id || '?';
      const from = e.from || '?';
      const to = e.to || e.kind || '?';
      return `~ ${id} · ${from} → ${to}`;
    });
    if (exp.categoryChanged.length > MAX_EXP_LINES) lines.push(`… +${exp.categoryChanged.length - MAX_EXP_LINES} more`);
    sections.push({
      label: label(E.modified, `Category · ${exp.categoryChanged.length}`),
      color: COLOR.modified,
      count: exp.categoryChanged.length,
      lines,
    });
  }
  if (exp.removed.length) {
    const lines = exp.removed.slice(0, MAX_EXP_LINES).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `- ${id}`;
    });
    if (exp.removed.length > MAX_EXP_LINES) lines.push(`… +${exp.removed.length - MAX_EXP_LINES} more`);
    sections.push({
      label: label(E.removed, `Removed · ${exp.removed.length}`),
      color: COLOR.removed,
      count: exp.removed.length,
      lines,
    });
  }
  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(E.exp, 'Experiments'),
    identity: 'experiments',
    bn,
    ts,
    sections,
    batchKey,
  });
  if (ok) {
    await markPosted(batchKey);
    const markList = async (list, changeType) => {
      for (const e of list || []) {
        const id = typeof e === 'string' ? e : e && e.id;
        if (!id) continue;
        await markPosted('expev:' + stableExpEventKey(bn, changeType, e));
      }
    };
    await markList(exp.added, 'added');
    await markList(exp.modified, 'modified');
    await markList(exp.removed, 'removed');
    await markList(exp.categoryChanged, 'category');
  } else {
    console.warn('Experiments webhook failed — batch NOT locked');
    await markFailed(batchKey, 'experiments batch send failed');
  }
  console.log('Sent experiments', {
    ok,
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
    categoryChanged: (exp.categoryChanged || []).length,
  });
  return ok;
}

async function sendMapDiff(webhookUrl, bn, diff, ts, kind) {
  const batchKey = 'mapbatch:' + stableMapKey(bn, kind, diff);
  if (!(await claimPosted(batchKey))) {
    console.log(kind, 'batch CLAIM skip', batchKey);
    return true;
  }
  const isRoutes = kind === 'Routes';
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);
  const sections = [];
  const kindEmoji = isRoutes ? E.route : E.str;
  const maxLines = isRoutes ? MAX_RT_LINES : MAX_STR_LINES;
  const maxVal = isRoutes ? LINE_VAL_ROUTES : LINE_VAL_MAX;
  if (a.length) {
    const lines = a.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('+', k, diff.added[k]) : stringLine('+', k, diff.added[k], maxVal),
    );
    if (a.length > maxLines) lines.push(`… +${a.length - maxLines} more`);
    sections.push({
      label: label(E.added, isRoutes ? `Added · ${a.length}` : `Ajouté · ${a.length}`),
      color: COLOR.added,
      count: a.length,
      lines,
    });
  }
  if (m.length) {
    const lines = m.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('~', k, diff.modified[k]) : stringLine('~', k, diff.modified[k], maxVal),
    );
    if (m.length > maxLines) lines.push(`… +${m.length - maxLines} more`);
    sections.push({
      label: label(E.modified, isRoutes ? `Modified · ${m.length}` : `Modifié · ${m.length}`),
      color: COLOR.modified,
      count: m.length,
      lines,
    });
  }
  if (r.length) {
    const lines = r.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('-', k, diff.removed[k]) : stringLine('-', k, diff.removed[k], maxVal),
    );
    if (r.length > maxLines) lines.push(`… +${r.length - maxLines} more`);
    sections.push({
      label: label(E.removed, isRoutes ? `Removed · ${r.length}` : `Supprimé · ${r.length}`),
      color: COLOR.removed,
      count: r.length,
      lines,
    });
  }
  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(kindEmoji, kind),
    identity: isRoutes ? 'routes' : 'strings',
    bn,
    ts,
    sections,
    batchKey,
  });
  if (ok) await markPosted(batchKey);
  else {
    console.warn(kind, 'webhook failed — batch NOT locked');
    await markFailed(batchKey, kind + ' batch send failed');
  }
  console.log('Sent', kind, { ok, added: a.length, modified: m.length, removed: r.length });
  return ok;
}

async function post(url, body, dedupeKey, identity) {
  body.username = BOT;
  body.avatar_url = AVATAR;
  const fp = dedupeKey ? 'msg:' + dedupeKey : payloadFingerprint(body);
  if (!(await claimPosted(fp))) {
    console.log('webhook CLAIM skip', body.embeds?.[0]?.title || fp);
    return true;
  }
  const title = body.embeds?.[0]?.title || '';
  const embeds = body.embeds || [];
  const base = { username: body.username, avatar_url: body.avatar_url };
  const r = await sendEmbeds(url, base, embeds, { identity, label: title, minGapMs: 50, withDismiss: true });
  console.log('webhook', r.status, title);
  if (r.ok) {
    await markPosted(fp);
    return true;
  }
  await markFailed(fp, `HTTP ${r.status}: ${String(r.text || '').slice(0, 200)}`);
  return false;
}

module.exports = { notifyAll, notifyUrgent, notifyNormal, post };
