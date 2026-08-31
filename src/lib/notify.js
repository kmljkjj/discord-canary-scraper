/**
 * Notifs — experiments ET strings envoyés QU'UNE fois.
 * data/notified_experiments.json
 * data/notified_strings.json
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const NOTIFIED_EXP = 'notified_experiments.json';
const NOTIFIED_STR = 'notified_strings.json';
const SENT_FILE = 'sent.json';

async function loadIdSet(stateDir, filename, migrateKeys) {
  const p = path.join(stateDir, filename);
  try {
    if (await fs.pathExists(p)) {
      const data = await fs.readJson(p);
      const ids = data.ids || data.keys || data.experiments || data.strings || [];
      if (Array.isArray(ids) && ids.length) return new Set(ids.map(String));
    }
  } catch {}
  try {
    const sp = path.join(stateDir, SENT_FILE);
    if (await fs.pathExists(sp)) {
      const s = await fs.readJson(sp);
      for (const key of migrateKeys || []) {
        if (Array.isArray(s[key]) && s[key].length) {
          return new Set(s[key].map(String));
        }
      }
    }
  } catch {}
  return new Set();
}

async function saveIdSet(stateDir, filename, set) {
  const ids = [...set].sort();
  // Cap strings list to avoid huge git diffs
  const capped = filename.includes('string') ? ids.slice(-30000) : ids;
  await fs.writeJson(
    path.join(stateDir, filename),
    {
      updatedAt: new Date().toISOString(),
      count: capped.length,
      ids: capped,
    },
    { spaces: 2 },
  );
}

async function loadNotified(stateDir) {
  return loadIdSet(stateDir, NOTIFIED_EXP, ['experiments']);
}

async function saveNotified(stateDir, set) {
  return saveIdSet(stateDir, NOTIFIED_EXP, set);
}

async function loadNotifiedStrings(stateDir) {
  return loadIdSet(stateDir, NOTIFIED_STR, ['strings', 'stringKeys']);
}

async function saveNotifiedStrings(stateDir, set) {
  return saveIdSet(stateDir, NOTIFIED_STR, set);
}

function isCleanStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  if (!/^[A-Za-z0-9+/_-]+$/.test(k)) return false;
  // pure lowercase English noise: height, string, number, author…
  if (/^[a-z]{6}$/.test(k)) return false;
  // need some hash-ish character
  if (!/[0-9A-Z+/]/.test(k)) return false;
  return true;
}

function isCleanStringValue(v) {
  const val = String(v || '').replace(/\s+/g, ' ').trim();
  if (val.length < 3 || val.length > 200) return false;
  if (/^[a-f0-9]{16,}$/i.test(val)) return false;
  if (/^\d+$/.test(val)) return false;
  // single short word noise
  if (/^[a-z]+$/.test(val) && val.length < 12) return false;
  if (/^(width|height|string|number|boolean|object|symbol|unknown|past|future|month|months|short|long|add|delete|update|start|locale|format)$/i.test(val))
    return false;
  return true;
}

async function notifyAll({
  build,
  isNewBuild,
  diff,
  webhookUrl,
  stateDir,
  baselineIds,
  allCurrentIds,
  baselineStringKeys,
  allCurrentStringKeys,
}) {
  if (!webhookUrl) {
    console.log('No webhook');
    return { notifiedExpIds: [], notifiedStrKeys: [] };
  }

  // ── Experiments ──────────────────────────────────────
  const notified = await loadNotified(stateDir);
  for (const id of baselineIds || []) notified.add(String(id));

  const freshExps = (diff.newExperiments || []).filter(
    (e) => e && e.id && !notified.has(String(e.id)),
  );

  console.log('Notify exp candidates:', {
    isNewBuild,
    fresh: freshExps.length,
    sample: freshExps.slice(0, 8).map((e) => e.id),
    notifiedSize: notified.size,
  });

  for (const e of freshExps) notified.add(String(e.id));
  for (const id of allCurrentIds || []) notified.add(String(id));
  for (const id of baselineIds || []) notified.add(String(id));
  await saveNotified(stateDir, notified);

  const notifiedExpIds = freshExps.map((e) => String(e.id));

  // ── Strings (permanent memory) ───────────────────────
  const notifiedStr = await loadNotifiedStrings(stateDir);
  for (const k of baselineStringKeys || []) notifiedStr.add(String(k));

  const strAdded = (diff.strings && diff.strings.added) || {};
  const strModified = (diff.strings && diff.strings.modified) || {};
  const strRemoved = (diff.strings && diff.strings.removed) || {};

  const freshAdded = {};
  for (const [k, v] of Object.entries(strAdded)) {
    if (notifiedStr.has(String(k))) continue;
    if (!isCleanStringKey(k) || !isCleanStringValue(v)) {
      notifiedStr.add(String(k)); // mark noise so we don't revisit
      continue;
    }
    freshAdded[k] = v;
  }

  const freshModified = {};
  for (const [k, v] of Object.entries(strModified)) {
    if (notifiedStr.has('mod:' + k)) continue;
    const val = v && typeof v === 'object' ? v.to || v : v;
    if (!isCleanStringKey(k) || !isCleanStringValue(val)) {
      notifiedStr.add('mod:' + k);
      continue;
    }
    // only report modified if we already knew the key (real change)
    if (notifiedStr.has(String(k)) || (baselineStringKeys || []).includes(k)) {
      freshModified[k] = val;
      notifiedStr.add('mod:' + k);
    }
  }

  // Mark all current keys as known (no backlog re-spam)
  for (const k of Object.keys(freshAdded)) notifiedStr.add(String(k));
  for (const k of allCurrentStringKeys || []) notifiedStr.add(String(k));
  for (const k of baselineStringKeys || []) notifiedStr.add(String(k));
  await saveNotifiedStrings(stateDir, notifiedStr);

  const strLines = [];
  for (const [k, v] of Object.entries(freshAdded)) {
    strLines.push(`+ ${k}: ${String(v).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  for (const [k, v] of Object.entries(freshModified)) {
    strLines.push(`~ ${k}: ${String(v).replace(/\s+/g, ' ').trim().slice(0, 100)}`);
  }
  // removals only if solid baseline and few
  if (Object.keys(strRemoved).length && Object.keys(strRemoved).length <= 20) {
    for (const [k, v] of Object.entries(strRemoved)) {
      if (!isCleanStringKey(k)) continue;
      strLines.push(`- ${k}: ${String(v).replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    }
  }

  console.log('Notify str candidates:', {
    freshAdded: Object.keys(freshAdded).length,
    freshModified: Object.keys(freshModified).length,
    lines: strLines.length,
    notifiedStrSize: notifiedStr.size,
  });

  // ── 1) Build card ────────────────────────────────────
  if (isNewBuild) {
    const sentPath = path.join(stateDir, SENT_FILE);
    let sent = { builds: [] };
    try {
      if (await fs.pathExists(sentPath)) sent = await fs.readJson(sentPath);
    } catch {}
    const knownBuilds = new Set((sent.builds || []).map(String));
    if (!knownBuilds.has(String(build.buildNumber))) {
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
                    freshExps.length
                      ? `Experiments +${freshExps.length}`
                      : null,
                    Object.keys(freshAdded).length
                      ? `Strings +${Object.keys(freshAdded).length}`
                      : null,
                    Object.keys((diff.routes && diff.routes.added) || {}).length
                      ? `Endpoints +${Object.keys(diff.routes.added).length}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || 'Build bump',
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });
      knownBuilds.add(String(build.buildNumber));
      sent.builds = [...knownBuilds].slice(-300);
      sent.updatedAt = new Date().toISOString();
      await fs.writeJson(sentPath, sent, { spaces: 2 });
      console.log('Sent build', build.buildNumber);
    }
  }

  // ── 2) Experiments (batched, only if new) ────────────
  if (freshExps.length > 0) {
    const apex = [];
    const normal = [];
    for (const exp of freshExps) {
      const id = String(exp.id);
      const type =
        exp.type || exp.kind || (/guild|server/i.test(id) ? 'guild' : 'user');
      const isApex = exp.kind === 'apex' || !id.includes('_');
      const line = `+ **${id}** (${type})`;
      if (isApex) apex.push(line);
      else normal.push(line);
    }
    const chunks = [];
    if (apex.length)
      chunks.push({ title: 'New Apex Experiments', color: 0xfaa61a, lines: apex });
    if (normal.length)
      chunks.push({ title: 'New Experiments', color: 0xed4245, lines: normal });

    for (const chunk of chunks) {
      const body = chunk.lines.slice(0, 40).join('\n');
      const more =
        chunk.lines.length > 40
          ? `\n… +${chunk.lines.length - 40} more`
          : '';
      await post(webhookUrl, {
        username: 'Canary Scraper',
        embeds: [
          {
            title: chunk.title,
            description: body + more + `\n\n**Build:** ${build.buildNumber}`,
            color: chunk.color,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
    console.log('Sent experiments batched', notifiedExpIds.length);
  } else {
    console.log('No new experiments to notify');
  }

  // ── 3) Strings (only truly new, max 1 message) ───────
  if (strLines.length) {
    const body = strLines.slice(0, 40).join('\n');
    const more =
      strLines.length > 40 ? `\n… +${strLines.length - 40} more` : '';
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Strings',
          description:
            'Added · removed · modified\n```\n' +
            body +
            more +
            '\n```',
          color: 0x57f287,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent strings', strLines.length);
  } else {
    console.log('No new strings to notify');
  }

  return {
    notifiedExpIds,
    notifiedStrKeys: Object.keys(freshAdded),
  };
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
  await new Promise((r) => setTimeout(r, 350));
}

module.exports = {
  notifyAll,
  loadNotified,
  saveNotified,
  loadNotifiedStrings,
  saveNotifiedStrings,
};
