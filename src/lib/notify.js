/**
 * Notifs — un experiment n'est envoyé QU'UNE fois dans toute la vie du repo.
 * Fichier permanent: data/notified_experiments.json
 * Un seul embed groupé (pas 12 messages spam).
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const NOTIFIED_FILE = 'notified_experiments.json';
const SENT_FILE = 'sent.json';

async function loadNotified(stateDir) {
  const p = path.join(stateDir, NOTIFIED_FILE);
  try {
    if (await fs.pathExists(p)) {
      const data = await fs.readJson(p);
      const ids = data.ids || data.experiments || [];
      return new Set(ids.map(String));
    }
  } catch {}
  // migrate depuis sent.json si présent
  try {
    const sp = path.join(stateDir, SENT_FILE);
    if (await fs.pathExists(sp)) {
      const s = await fs.readJson(sp);
      return new Set((s.experiments || []).map(String));
    }
  } catch {}
  return new Set();
}

async function saveNotified(stateDir, set) {
  const ids = [...set].sort();
  await fs.writeJson(
    path.join(stateDir, NOTIFIED_FILE),
    {
      updatedAt: new Date().toISOString(),
      count: ids.length,
      ids,
    },
    { spaces: 2 },
  );
}

async function notifyAll({
  build,
  isNewBuild,
  diff,
  webhookUrl,
  stateDir,
  baselineIds,
  allCurrentIds,
}) {
  if (!webhookUrl) {
    console.log('No webhook');
    return { notifiedExpIds: [] };
  }

  const notified = await loadNotified(stateDir);

  // Baseline = déjà connus dans experiments.json + déjà notifiés
  for (const id of baselineIds || []) notified.add(String(id));

  // Candidats = vraiment jamais vus
  let freshExps = (diff.newExperiments || []).filter(
    (e) => e && e.id && !notified.has(String(e.id)),
  );

  // Si extraction partielle a raté des vieux IDs, allCurrentIds aide
  // mais on ne notifie QUE les freshExps (nouveaux vs baseline de ce run)

  console.log('Notify candidates:', {
    isNewBuild,
    fresh: freshExps.length,
    sample: freshExps.slice(0, 8).map((e) => e.id),
    notifiedSize: notified.size,
  });

  // Marquer TOUT de suite (même si webhook échoue plus tard → pas de re-spam)
  for (const e of freshExps) notified.add(String(e.id));
  // Synchroniser aussi tous les IDs actuels pour ne jamais rejouer un backlog
  for (const id of allCurrentIds || []) notified.add(String(id));
  for (const id of baselineIds || []) notified.add(String(id));
  await saveNotified(stateDir, notified);

  const notifiedExpIds = freshExps.map((e) => String(e.id));

  // 1) Build card — une fois
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
                    Object.keys((diff.strings && diff.strings.added) || {}).length
                      ? `Strings +${Object.keys(diff.strings.added).length}`
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

  // 2) Experiments — UN seul message groupé, UNIQUEMENT s'il y a du nouveau
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
    if (apex.length) {
      chunks.push({
        title: 'New Apex Experiments',
        color: 0xfaa61a,
        lines: apex,
      });
    }
    if (normal.length) {
      chunks.push({
        title: 'New Experiments',
        color: 0xed4245,
        lines: normal,
      });
    }

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
            description:
              body +
              more +
              `\n\n**Build:** ${build.buildNumber}`,
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

  // 3) Strings — seulement clés vraiment nouvelles (optionnel, max 1 msg)
  const freshStr = {};
  const strAdded = (diff.strings && diff.strings.added) || {};
  const sentPath = path.join(stateDir, SENT_FILE);
  let sentStr = { strings: [] };
  try {
    if (await fs.pathExists(sentPath)) sentStr = await fs.readJson(sentPath);
  } catch {}
  const knownStr = new Set((sentStr.strings || []).map(String));
  for (const [k, v] of Object.entries(strAdded)) {
    if (!knownStr.has(k)) {
      freshStr[k] = v;
      knownStr.add(k);
    }
  }
  // filtre anti-bruit simple
  const strLines = [];
  for (const [k, v] of Object.entries(freshStr)) {
    if (!/^[A-Za-z0-9+/_-]{6}$/.test(k)) continue;
    if (/^[a-z]{6}$/.test(k)) continue; // height, string, number…
    const val = String(v).replace(/\s+/g, ' ').trim();
    if (val.length < 3 || val.length > 200) continue;
    if (/^[a-z]+$/.test(val) && val.length < 12) continue;
    strLines.push(`+ ${k}: ${val.slice(0, 120)}`);
    if (strLines.length >= 35) break;
  }
  if (strLines.length) {
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Strings',
          description:
            'Added · removed · modified\n```\n' +
            strLines.join('\n') +
            '\n```',
          color: 0x57f287,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    sentStr.strings = [...knownStr].slice(-25000);
    await fs.writeJson(sentPath, sentStr, { spaces: 2 });
    console.log('Sent strings', strLines.length);
  }

  return { notifiedExpIds };
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

module.exports = { notifyAll, loadNotified, saveNotified };
