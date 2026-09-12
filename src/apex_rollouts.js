/**
 * Suivi des pourcentages de rollout Experiments (user + guild)
 *
 * Source publique (Discord Experiment Hub style):
 *   https://experiments.dscrd.workers.dev/experiments
 *
 * Les ranges sont sur 0–10000 → % = somme(end-start)/100
 *
 * Webhook: APEX_WEBHOOK_URL (prioritaire) ou ROLLOUT_WEBHOOK_URL
 *          fallback DISCORD_WEBHOOK_URL
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');

const API_URL =
  process.env.APEX_API_URL ||
  'https://experiments.dscrd.workers.dev/experiments';

const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;

const UA =
  'Mozilla/5.0 (compatible; Datamining-Apex/1.0; +https://github.com/kmljkjj/discord-canary-scraper)';

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png';

/** Minimum absolute % change to notify (avoid noise) */
const MIN_PCT_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '0.5');

function rangePct(rollouts) {
  if (!Array.isArray(rollouts) || !rollouts.length) return 0;
  let sum = 0;
  for (const r of rollouts) {
    const s = Number(r.start ?? r.s ?? 0);
    const e = Number(r.end ?? r.e ?? 0);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) sum += e - s;
  }
  // scale 0–10000 → percent
  return Math.round((sum / 100) * 100) / 100;
}

function normalizeExperiment(raw) {
  if (!raw || !raw.id) return null;
  const id = String(raw.id);
  const type = String(raw.type || 'unknown').toLowerCase();
  const title = raw.title || raw.name || id;
  const descriptions = Array.isArray(raw.description) ? raw.description : [];
  const bucketsMeta = Array.isArray(raw.buckets) ? raw.buckets : [];

  const treatments = new Map(); // key: bucket number or label

  const rollout = raw.rollout || {};
  const populations = rollout.populations || [];

  for (const pop of populations) {
    for (const pos of pop.position || []) {
      const bucket = pos.bucket != null ? Number(pos.bucket) : null;
      const label =
        pos.treatment ||
        (bucket === -1
          ? 'None'
          : bucket === 0
            ? descriptions[0] || 'Control'
            : descriptions[bucket] || 'Treatment ' + bucket);
      const pct = rangePct(pos.rollouts || []);
      const key = bucket != null ? 'b' + bucket : 't:' + label;
      const prev = treatments.get(key) || {
        bucket,
        label: String(label).slice(0, 120),
        pct: 0,
      };
      prev.pct = Math.round((prev.pct + pct) * 100) / 100;
      treatments.set(key, prev);
    }
  }

  // If no population ranges, mark unknown
  const list = Array.from(treatments.values()).sort((a, b) => {
    const ba = a.bucket == null ? 999 : a.bucket;
    const bb = b.bucket == null ? 999 : b.bucket;
    return ba - bb;
  });

  const fingerprint = list
    .map((t) => (t.bucket != null ? t.bucket : t.label) + ':' + t.pct.toFixed(2))
    .join('|');

  return {
    id,
    type,
    title: String(title).slice(0, 200),
    descriptions,
    buckets: bucketsMeta,
    treatments: list,
    fingerprint,
    revision: rollout.revision != null ? rollout.revision : null,
    hash: raw.hash != null ? raw.hash : null,
  };
}

function fingerprintMap(experiments) {
  const m = {};
  for (const e of experiments) m[e.id] = e.fingerprint;
  return m;
}

function diffExperiments(prevList, nextList) {
  const prevById = new Map((prevList || []).map((e) => [e.id, e]));
  const nextById = new Map((nextList || []).map((e) => [e.id, e]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p) {
      added.push(n);
      continue;
    }
    if (p.fingerprint === n.fingerprint) continue;

    // per-treatment delta
    const pTreat = new Map(
      (p.treatments || []).map((t) => [
        t.bucket != null ? 'b' + t.bucket : 't:' + t.label,
        t,
      ]),
    );
    const deltas = [];
    for (const t of n.treatments || []) {
      const key = t.bucket != null ? 'b' + t.bucket : 't:' + t.label;
      const old = pTreat.get(key);
      const oldPct = old ? old.pct : 0;
      const d = Math.round((t.pct - oldPct) * 100) / 100;
      if (Math.abs(d) >= MIN_PCT_DELTA) {
        deltas.push({ label: t.label, bucket: t.bucket, from: oldPct, to: t.pct, delta: d });
      }
    }
    // treatments removed
    for (const [key, t] of pTreat) {
      const still = (n.treatments || []).some(
        (x) =>
          (x.bucket != null ? 'b' + x.bucket : 't:' + x.label) === key,
      );
      if (!still && t.pct >= MIN_PCT_DELTA) {
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from: t.pct,
          to: 0,
          delta: -t.pct,
        });
      }
    }

    if (deltas.length) changed.push({ before: p, after: n, deltas });
  }

  for (const [id, p] of prevById) {
    if (!nextById.has(id)) removed.push(p);
  }

  return { added, removed, changed };
}

function formatTreatmentsLine(treatments, max = 8) {
  const lines = [];
  for (const t of (treatments || []).slice(0, max)) {
    const name = t.label || ('Bucket ' + t.bucket);
    lines.push('• **' + name + '** · `' + t.pct + '%`');
  }
  if ((treatments || []).length > max) {
    lines.push('_+' + (treatments.length - max) + ' autres_');
  }
  return lines.join('\n') || '_—_';
}

function buildEmbeds(diff, stats) {
  const embeds = [];
  const colorAdd = 0x57f287;
  const colorMod = 0xe67e22;
  const colorRem = 0xed4245;
  const colorInfo = 0x5865f2;

  // Summary
  embeds.push({
    author: { name: 'Apex Rollouts', icon_url: AVATAR },
    title: 'Mise à jour des pourcentages',
    description: [
      '**Source** · API experiments publique',
      '**Suivis** · `' + stats.total + '` experiments',
      '**Δ** · +`' +
        diff.added.length +
        '` · ~`' +
        diff.changed.length +
        '` · -`' +
        diff.removed.length +
        '`',
    ].join('\n'),
    color: colorInfo,
    footer: { text: 'Datamining · Apex %' },
    timestamp: new Date().toISOString(),
  });

  for (const e of diff.added.slice(0, 8)) {
    embeds.push({
      title: '+ ' + e.id,
      description: [
        '**' + e.title + '**',
        'Type · `' + e.type + '`',
        '',
        formatTreatmentsLine(e.treatments),
      ].join('\n').slice(0, 4000),
      color: colorAdd,
      footer: { text: 'Nouveau rollout' },
    });
  }

  for (const c of diff.changed.slice(0, 12)) {
    const e = c.after;
    const deltaLines = c.deltas.slice(0, 10).map((d) => {
      const sign = d.delta > 0 ? '+' : '';
      return (
        '• **' +
        (d.label || 'bucket') +
        '** · `' +
        d.from +
        '%` → `' +
        d.to +
        '%` (`' +
        sign +
        d.delta +
        '`)'
      );
    });
    embeds.push({
      title: '~ ' + e.id,
      description: [
        '**' + e.title + '**',
        'Type · `' + e.type + '`',
        '',
        deltaLines.join('\n'),
      ].join('\n').slice(0, 4000),
      color: colorMod,
      footer: { text: 'Rollout modifié' },
    });
  }

  for (const e of diff.removed.slice(0, 5)) {
    embeds.push({
      title: '- ' + e.id,
      description: '**' + e.title + '** · `' + e.type + '`',
      color: colorRem,
      footer: { text: 'Retiré de l’API' },
    });
  }

  return embeds.slice(0, 10); // Discord max 10 embeds / message
}

async function postWebhook(embeds) {
  if (!WEBHOOK) return { ok: false, status: 0, text: 'no webhook' };
  // Chunk embeds by 10
  const chunks = [];
  for (let i = 0; i < embeds.length; i += 10) chunks.push(embeds.slice(i, i + 10));
  let last = { ok: true, status: 204, text: '' };
  for (const chunk of chunks) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: BOT_NAME,
        avatar_url: AVATAR,
        embeds: chunk,
      }),
    });
    const text = await res.text().catch(() => '');
    last = { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    if (!res.ok) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts…');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.APEX_WEBHOOK_URL
        ? 'APEX_WEBHOOK_URL'
        : process.env.ROLLOUT_WEBHOOK_URL
          ? 'ROLLOUT_WEBHOOK_URL'
          : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );

  const res = await fetch(API_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 45000,
  });
  if (!res.ok) throw new Error('API HTTP ' + res.status);
  const rawList = await res.json();
  if (!Array.isArray(rawList)) throw new Error('API: expected array');

  const experiments = rawList.map(normalizeExperiment).filter(Boolean);
  console.log('Fetched', experiments.length, 'experiments');

  let previous = { experiments: [], fingerprints: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {}
  }

  const prevExps = previous.experiments || [];
  const isFirst = !prevExps.length;

  const diff = isFirst
    ? { added: [], removed: [], changed: [] }
    : diffExperiments(prevExps, experiments);

  console.log('Diff', {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    first: isFirst,
  });

  // Compact state (no huge descriptions spam in git)
  const compact = experiments.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    fingerprint: e.fingerprint,
    treatments: e.treatments,
    revision: e.revision,
  }));

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      source: API_URL,
      count: compact.length,
      fingerprints: fingerprintMap(experiments),
      experiments: compact,
    },
    { spaces: 2 },
  );

  if (isFirst) {
    console.log('Premier run — seed', compact.length, '(pas de flood)');
    return;
  }

  const hasChanges =
    diff.added.length || diff.changed.length || diff.removed.length;
  if (!hasChanges) {
    console.log('Aucun changement de %');
    return;
  }

  if (!WEBHOOK) {
    console.warn('Changements détectés mais pas de webhook');
    return;
  }

  const embeds = buildEmbeds(diff, { total: experiments.length });
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  console.log('✅ Apex rollouts done');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, normalizeExperiment, rangePct, diffExperiments };
