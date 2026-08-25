/**
 * Notifs — un experiment / string / route ne part qu'UNE fois.
 * La baseline (prev.experiments) est la source de vérité.
 * Pas de renvoi du retard à chaque nouveau build.
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

async function notifyAll({ build, isNewBuild, diff, webhookUrl, stateDir, baselineIds }) {
  if (!webhookUrl) {
    console.log('No webhook');
    return { notifiedExpIds: [] };
  }

  const sentPath = path.join(stateDir, 'sent.json');
  let sent = { builds: [], experiments: [], strings: [], routes: [] };
  try {
    if (await fs.pathExists(sentPath)) sent = await fs.readJson(sentPath);
  } catch {}

  // Union : déjà en baseline + déjà envoyés
  const knownExp = new Set([
    ...(baselineIds || []),
    ...(sent.experiments || []),
  ]);
  const knownStr = new Set(sent.strings || []);
  const knownRt = new Set(sent.routes || []);
  const knownBuilds = new Set((sent.builds || []).map(String));

  // Uniquement ce qui n'est PAS déjà connu
  let freshExps = (diff.newExperiments || []).filter((e) => e && e.id && !knownExp.has(e.id));
  const freshStr = {};
  for (const [k, v] of Object.entries((diff.strings && diff.strings.added) || {})) {
    if (!knownStr.has(k)) freshStr[k] = v;
  }
  const freshRt = {};
  for (const [k, v] of Object.entries((diff.routes && diff.routes.added) || {})) {
    if (!knownRt.has(k)) freshRt[k] = v;
  }

  // Catch-up massif (retard) : on n'envoie pas 100 messages d'un coup,
  // on enregistre tout et on n'affiche que les plus récents
  const BACKLOG_LIMIT = 12;
  let backlogMode = false;
  if (freshExps.length > BACKLOG_LIMIT) {
    backlogMode = true;
    console.log(
      'BACKLOG',
      freshExps.length,
      'experiments — notify only last',
      BACKLOG_LIMIT,
      '(rest marked sent, no re-send later)',
    );
    // Marquer TOUT comme connu pour ne jamais renvoyer
    for (const e of freshExps) knownExp.add(e.id);
    // Trier par id (dates 2026-08… en dernier souvent) et n'afficher qu'une partie
    freshExps = [...freshExps]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(-BACKLOG_LIMIT);
  }

  console.log('Notify:', {
    isNewBuild,
    exp: freshExps.length,
    str: Object.keys(freshStr).length,
    routes: Object.keys(freshRt).length,
    backlogMode,
  });

  // 1) Build (une fois par numéro)
  if (isNewBuild && !knownBuilds.has(String(build.buildNumber))) {
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
                  freshExps.length ? `Experiments +${freshExps.length}` : null,
                  Object.keys(freshStr).length
                    ? `Strings +${Object.keys(freshStr).length}`
                    : null,
                  Object.keys(freshRt).length
                    ? `Endpoints +${Object.keys(freshRt).length}`
                    : null,
                  backlogMode ? '_catch-up (limited)_' : null,
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
    console.log('Sent build', build.buildNumber);
  }

  // 2) Strings (max 1 message)
  const strLines = [];
  for (const [k, v] of Object.entries(freshStr).slice(0, 40)) {
    strLines.push(`+ ${k}: ${String(v).slice(0, 120)}`);
    knownStr.add(k);
  }
  for (const [k, o] of Object.entries((diff.strings && diff.strings.modified) || {}).slice(0, 10)) {
    strLines.push(`~ ${k}: ${String(o.to || o).slice(0, 100)}`);
  }
  if (strLines.length) {
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Strings',
          description:
            'Added · removed · modified\n```\n' +
            strLines.join('\n').slice(0, 3800) +
            '\n```',
          color: 0x57f287,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent strings', strLines.length);
  }

  // 3) Endpoints
  const rtLines = [];
  for (const [k, v] of Object.entries(freshRt).slice(0, 40)) {
    rtLines.push(`+ ${k}: ${v}`);
    knownRt.add(k);
  }
  if (rtLines.length) {
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: 'Endpoints',
          description:
            'Added\n```\n' + rtLines.join('\n').slice(0, 3800) + '\n```',
          color: 0x5865f2,
          footer: { text: `Build Id - ${build.buildNumber}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log('Sent endpoints', rtLines.length);
  }

  // 4) Experiments — une fois seulement
  const notifiedExpIds = [];
  for (const exp of freshExps) {
    const id = exp.id;
    if (knownExp.has(id) && notifiedExpIds.includes(id)) continue;
    const isApex = exp.kind === 'apex' || !String(id).includes('_');
    const type = exp.type || (/guild|server/i.test(id) ? 'guild' : 'user');
    await post(webhookUrl, {
      username: 'Canary Scraper',
      embeds: [
        {
          title: isApex ? 'New Apex Experiment' : 'New Experiment',
          description: [
            `+ **${id}** (${type})`,
            `* Type **${type}**`,
            `Build: **${build.buildNumber}**`,
          ].join('\n'),
          color: isApex ? 0xfaa61a : 0xed4245,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    knownExp.add(id);
    notifiedExpIds.push(id);
  }
  if (notifiedExpIds.length) console.log('Sent experiments', notifiedExpIds.length);

  // Persister : tout le backlog est marqué envoyé → plus de renvoi
  await fs.writeJson(
    sentPath,
    {
      builds: [...knownBuilds].slice(-300),
      experiments: [...knownExp].slice(-10000),
      strings: [...knownStr].slice(-25000),
      routes: [...knownRt].slice(-5000),
      updatedAt: new Date().toISOString(),
    },
    { spaces: 2 },
  );

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
  await new Promise((r) => setTimeout(r, 400));
}

module.exports = { notifyAll };
