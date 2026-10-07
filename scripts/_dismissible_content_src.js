'use strict';
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./webhook');
const { DEFAULT_BOT_NAME, DEFAULT_AVATAR_URL } = require('./utils');
const { claimPosted, markPosted, markFailed, payloadFingerprint } = require('./webhook_dedupe');

const BOT = process.env.WEBHOOK_BOT_NAME || DEFAULT_BOT_NAME;
const AVATAR = process.env.WEBHOOK_AVATAR_URL || DEFAULT_AVATAR_URL;
const STATE = 'dismissible_content.json';

function extractDismissibleContent(content, out) {
  if (!content || !out) return;
  const re = /DismissibleContent(?:Types?|Type)?/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const win = content.slice(Math.max(0, m.index - 2000), Math.min(content.length, m.index + 120000));
    const pairRe = /(?:^|[,{[\s])([A-Z][A-Z0-9_]{3,80})\s*:\s*(\d{1,4})\b/g;
    let p;
    while ((p = pairRe.exec(win)) !== null) {
      const n = Number(p[2]);
      if (n >= 0 && n <= 5000) out[p[1]] = n;
    }
  }
}

function diffDismissible(cur, prev) {
  const added = {}, removed = {}, modified = {};
  cur = cur || {};
  prev = prev || {};
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in prev)) added[k] = v;
    else if (Number(prev[k]) !== Number(v)) modified[k] = { from: prev[k], to: v };
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in cur)) removed[k] = v;
  }
  return { added, removed, modified };
}

async function loadState(dataDir) {
  const fp = path.join(dataDir, STATE);
  try {
    if (!(await fs.pathExists(fp))) return { data: {} };
    const raw = await fs.readJson(fp);
    return { data: (raw && raw.data) || {}, buildNumber: raw.buildNumber };
  } catch {
    return { data: {} };
  }
}

async function saveState(dataDir, data, buildNumber) {
  const fp = path.join(dataDir, STATE);
  const tmp = fp + '.tmp';
  await fs.writeJson(tmp, {
    updatedAt: new Date().toISOString(),
    buildNumber: buildNumber != null ? String(buildNumber) : null,
    count: Object.keys(data || {}).length,
    data: data || {},
  }, { spaces: 2 });
  await fs.move(tmp, fp, { overwrite: true });
}

async function notifyDismissible({ webhookUrl, buildNumber, diff }) {
  if (!webhookUrl) return true;
  const added = Object.entries(diff.added || {});
  const removed = Object.entries(diff.removed || {});
  const modified = Object.entries(diff.modified || {});
  if (!added.length && !removed.length && !modified.length) return true;

  const bn = String(buildNumber || '?');
  const ts = new Date().toISOString();
  const embeds = [];
  if (added.length) {
    const lines = added.slice(0, 40).map(([k, v]) => `+ \`${k}\` = **${v}**`);
    if (added.length > 40) lines.push(`… +${added.length - 40} more`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Ajouté · ${added.length}**\n\n` + lines.join('\n'),
      color: 0x57f287,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });
  }
  if (removed.length) {
    const lines = removed.slice(0, 40).map(([k, v]) => `- \`${k}\` = **${v}**`);
    if (removed.length > 40) lines.push(`… +${removed.length - 40} more`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Supprimé · ${removed.length}**\n\n` + lines.join('\n'),
      color: 0xed4245,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });
  }
  if (modified.length) {
    const lines = modified.slice(0, 40).map(([k, v]) => `~ \`${k}\` · ${v.from} → **${v.to}**`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Modifié · ${modified.length}**\n\n` + lines.join('\n'),
      color: 0x5865f2,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });
  }

  const batchKey = 'dismissible:' + bn + ':' + added.map(x => x[0]).sort().join(',').slice(0, 180);
  if (!(await claimPosted(batchKey))) {
    console.log('Dismissible CLAIM skip');
    return true;
  }
  const base = { username: BOT, avatar_url: AVATAR };
  let ok = true;
  for (let i = 0; i < embeds.length; i += 5) {
    const slice = embeds.slice(i, i + 5);
    const fp = payloadFingerprint({ embeds: slice });
    if (!(await claimPosted(fp))) continue;
    const r = await sendEmbeds(webhookUrl, base, slice, { label: 'Dismissible Content', minGapMs: 50, withDismiss: true });
    console.log('webhook dismissible', r.status);
    if (r.ok) await markPosted(fp);
    else { ok = false; await markFailed(fp, 'HTTP ' + r.status); }
  }
  if (ok) await markPosted(batchKey);
  else await markFailed(batchKey, 'failed');
  return ok;
}

async function processDismissibleContent({ dataDir, current, buildNumber, webhookUrl, isSeed }) {
  const cur = current || {};
  const count = Object.keys(cur).length;
  const prevState = await loadState(dataDir);
  const prev = prevState.data || {};
  const prevCount = Object.keys(prev).length;
  console.log('Dismissible Content extracted:', count, '| previous:', prevCount);
  if (count < 10) {
    console.log('Dismissible Content: too few — skip');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }
  const diff = diffDismissible(cur, prev);
  const nAdd = Object.keys(diff.added).length;
  const nRem = Object.keys(diff.removed).length;
  const nMod = Object.keys(diff.modified).length;
  if (prevCount >= 30 && nRem > prevCount * 0.5 && nAdd < 5) {
    console.warn('Dismissible Content: mass removal — skip');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }
  let notified = false;
  if (!isSeed && prevCount >= 10 && (nAdd || nRem || nMod)) {
    console.log('Dismissible Content diff', { added: nAdd, removed: nRem, modified: nMod });
    notified = await notifyDismissible({ webhookUrl, buildNumber, diff });
  } else {
    console.log('Dismissible Content: seeding baseline', count);
  }
  await saveState(dataDir, cur, buildNumber);
  return { notified, diff, count };
}

module.exports = {
  extractDismissibleContent,
  diffDismissible,
  loadState,
  saveState,
  notifyDismissible,
  processDismissibleContent,
};
