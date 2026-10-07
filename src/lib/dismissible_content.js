'use strict';
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./webhook');
const { DEFAULT_BOT_NAME, DEFAULT_AVATAR_URL } = require('./utils');
const {
  claimPosted,
  markPosted,
  markFailed,
  payloadFingerprint,
} = require('./webhook_dedupe');

const BOT = process.env.WEBHOOK_BOT_NAME || DEFAULT_BOT_NAME;
const AVATAR = process.env.WEBHOOK_AVATAR_URL || DEFAULT_AVATAR_URL;
const STATE_FILE = 'dismissible_content.json';

const COLOR = { added: 0x57f287, removed: 0xed4245, title: 0x5865f2 };

function extractDismissibleContent(content, out) {
  if (!content || typeof content !== 'string' || !out) return;
  const markerRe = /DismissibleContent(?:Types?|Type)?/gi;
  let m;
  while ((m = markerRe.exec(content)) !== null) {
    const start = m.index;
    const window = content.slice(start, Math.min(content.length, start + 120000));
    const before = content.slice(Math.max(0, start - 2000), start);
    scanEnumPairs(before + window, out);
  }
  if (Object.keys(out).length === 0) {
    const alt = /dismissible[_]?content[_]?types?/gi;
    while ((m = alt.exec(content)) !== null) {
      const window = content.slice(m.index, Math.min(content.length, m.index + 120000));
      scanEnumPairs(window, out);
    }
  }
}

function scanEnumPairs(text, out) {
  const pairRe = /(?:^|[,{[\s])([A-Z][A-Z0-9_]{3,80})\s*:\s*(\d{1,4})\b/g;
  let p;
  while ((p = pairRe.exec(text)) !== null) {
    const name = p[1];
    const val = Number(p[2]);
    if (!Number.isFinite(val) || val < 0 || val > 5000) continue;
    if (name.length < 4) continue;
    if (/^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS|TRUE|FALSE|NULL)$/.test(name)) continue;
    if (!(name in out) || out[name] === val) out[name] = val;
  }
}

function diffDismissible(current, previous) {
  const added = {}, removed = {}, modified = {};
  const cur = current && typeof current === 'object' ? current : {};
  const prev = previous && typeof previous === 'object' ? previous : {};
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
  const fp = path.join(dataDir, STATE_FILE);
  try {
    if (!(await fs.pathExists(fp))) return { data: {}, buildNumber: null };
    const raw = await fs.readJson(fp);
    const data =
      raw && raw.data && typeof raw.data === 'object'
        ? raw.data
        : raw && typeof raw === 'object' && !raw.data
          ? Object.fromEntries(
              Object.entries(raw).filter(
                ([k, v]) => k !== 'updatedAt' && k !== 'buildNumber' && k !== 'count' && typeof v === 'number',
              ),
            )
          : {};
    return { data, buildNumber: raw.buildNumber || null, updatedAt: raw.updatedAt || null, count: Object.keys(data).length };
  } catch (e) {
    console.warn('dismissible loadState', String(e.message || e).slice(0, 120));
    return { data: {}, buildNumber: null };
  }
}

async function saveState(dataDir, data, buildNumber) {
  const fp = path.join(dataDir, STATE_FILE);
  const payload = {
    updatedAt: new Date().toISOString(),
    buildNumber: buildNumber != null ? String(buildNumber) : null,
    count: Object.keys(data || {}).length,
    data: data || {},
  };
  const tmp = fp + '.tmp';
  await fs.writeJson(tmp, payload, { spaces: 2 });
  await fs.move(tmp, fp, { overwrite: true });
  return fp;
}

function formatLine(sign, name, value) {
  return `${sign} \`${name}\` = **${value}**`;
}

async function notifyDismissible({ webhookUrl, buildNumber, diff, ts }) {
  if (!webhookUrl) return true;
  const added = Object.entries(diff.added || {});
  const removed = Object.entries(diff.removed || {});
  const modified = Object.entries(diff.modified || {});
  if (!added.length && !removed.length && !modified.length) return true;

  const bn = String(buildNumber || '?');
  const timestamp = ts || new Date().toISOString();
  const embeds = [];

  if (added.length) {
    const lines = added.slice(0, 40).map(([k, v]) => formatLine('+', k, v));
    if (added.length > 40) lines.push(`… +${added.length - 40} more`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Ajouté · ${added.length}**\n\n` + lines.join('\n'),
      color: COLOR.added,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp,
    });
  }
  if (removed.length) {
    const lines = removed.slice(0, 40).map(([k, v]) => formatLine('-', k, v));
    if (removed.length > 40) lines.push(`… -${removed.length - 40} more`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Supprimé · ${removed.length}**\n\n` + lines.join('\n'),
      color: COLOR.removed,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp,
    });
  }
  if (modified.length) {
    const lines = modified.slice(0, 40).map(([k, v]) => `~ \`${k}\` **${v.from}** → **${v.to}**`);
    if (modified.length > 40) lines.push(`… ~${modified.length - 40} more`);
    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title: 'Dismissible Content',
      description: `Build ${bn} · **Modifié · ${modified.length}**\n\n` + lines.join('\n'),
      color: COLOR.title,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp,
    });
  }

  const batchKey =
    'dismissible:' +
    bn +
    ':' +
    added.map(([k]) => k).sort().join(',').slice(0, 200) +
    '|' +
    removed.map(([k]) => k).sort().join(',').slice(0, 200);

  if (!(await claimPosted(batchKey))) {
    console.log('Dismissible Content batch CLAIM skip', batchKey.slice(0, 80));
    return true;
  }

  const base = { username: BOT, avatar_url: AVATAR };
  let ok = true;
  for (let i = 0; i < embeds.length; i += 5) {
    const slice = embeds.slice(i, i + 5);
    const fp = payloadFingerprint({ embeds: slice });
    if (!(await claimPosted(fp))) continue;
    const r = await sendEmbeds(webhookUrl, base, slice, {
      label: 'Dismissible Content',
      minGapMs: 50,
      withDismiss: true,
    });
    console.log('webhook dismissible', r.status);
    if (r.ok) await markPosted(fp);
    else {
      ok = false;
      await markFailed(fp, `HTTP ${r.status}`);
    }
  }
  if (ok) await markPosted(batchKey);
  else await markFailed(batchKey, 'dismissible send failed');
  return ok;
}

async function processDismissibleContent({ dataDir, current, buildNumber, webhookUrl, isSeed = false }) {
  const cur = current && typeof current === 'object' ? current : {};
  const count = Object.keys(cur).length;
  const prevState = await loadState(dataDir);
  const prev = prevState.data || {};
  const prevCount = Object.keys(prev).length;
  console.log('Dismissible Content extracted:', count, '| previous:', prevCount);

  if (count < 10) {
    console.log('Dismissible Content: too few entries — skip notify, keep previous state');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }

  const diff = diffDismissible(cur, prev);
  const nAdd = Object.keys(diff.added).length;
  const nRem = Object.keys(diff.removed).length;
  const nMod = Object.keys(diff.modified).length;

  if (prevCount >= 30 && nRem > prevCount * 0.5 && nAdd < 5) {
    console.warn('Dismissible Content: suspicious mass removal — skip notify & state');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }

  let notified = false;
  if (!isSeed && prevCount >= 10 && (nAdd || nRem || nMod)) {
    console.log('Dismissible Content diff', { added: nAdd, removed: nRem, modified: nMod });
    notified = await notifyDismissible({ webhookUrl, buildNumber, diff, ts: new Date().toISOString() });
  } else if (isSeed || prevCount < 10) {
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
  scanEnumPairs,
};
