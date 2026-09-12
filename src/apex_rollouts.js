/**
 * Apex / Experiments rollout tracker — precise %
 *
 * Sources (merged, primary first):
 *   1. https://experiments.dscrd.workers.dev/experiments
 *   2. fallback GitHub experimentAPI experiments.json
 *
 * Accuracy:
 *   - ranges 0–10000 → %
 *   - merge overlapping intervals (no double-count)
 *   - multi-population + filters summarized
 *   - overrides / overrides_formatted counted
 *
 * Webhook: APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');

const PRIMARY_URL =
  process.env.APEX_API_URL ||
  'https://experiments.dscrd.workers.dev/experiments';
const FALLBACK_URL =
  process.env.APEX_FALLBACK_URL ||
  'https://raw.githubusercontent.com/discordexperimenthub/experimentAPI/master/experiments.json';

const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;

const UA =
  'Mozilla/5.0 (compatible; Datamining-Apex/1.2; +https://github.com/kmljkjj/discord-canary-scraper)';

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4ca.png';

const MIN_PCT_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '0.5');
const SCALE = 10000; // Discord rollout positions

// ── ranges → % (merge overlaps) ───────────────────────────

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals
    .map(([s, e]) => [Number(s), Number(e)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!sorted.length) return [];
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intervalsToPct(intervals) {
  const merged = mergeIntervals(intervals);
  let covered = 0;
  for (const [s, e] of merged) covered += e - s;
  const pct = (covered / SCALE) * 100;
  // clamp + 2 decimals
  return Math.min(100, Math.round(pct * 100) / 100);
}

function rolloutsToIntervals(rollouts) {
  const out = [];
  if (!Array.isArray(rollouts)) return out;
  for (const r of rollouts) {
    const s = r.start ?? r.s;
    const e = r.end ?? r.e;
    if (s != null && e != null) out.push([s, e]);
  }
  return out;
}

// ── filters (human) ───────────────────────────────────────

function describeFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const t = String(f.type || '').toLowerCase();
  if (t === 'feature' || t === 'guild_feature') {
    const feats = f.features || f.feature || [];
    const list = Array.isArray(feats) ? feats : [feats];
    return 'Feature · ' + list.slice(0, 4).join(', ');
  }
  if (t === 'id_range' || t === 'guild_id_range' || t === 'user_id_range') {
    const min = f.min_id ?? f.min ?? f.start;
    const max = f.max_id ?? f.max ?? f.end;
    return 'ID range · ' + (min ?? '?') + '–' + (max ?? '?');
  }
  if (t === 'member_count' || t === 'guild_member_count') {
    return (
      'Members · ' +
      (f.min != null ? '≥' + f.min : '') +
      (f.max != null ? ' ≤' + f.max : '')
    ).trim();
  }
  if (t === 'id' || t === 'guild_id' || t === 'user_id') {
    const ids = f.ids || f.id || [];
    const n = Array.isArray(ids) ? ids.length : 1;
    return 'IDs explicites · ' + n;
  }
  if (t === 'hub_type') return 'Hub type';
  if (t === 'vanity_url') return 'Vanity URL';
  if (t === 'user_flag' || t === 'user_flags') {
    return 'User flags · ' + JSON.stringify(f.flags || f.flag || []);
  }
  if (t === 'experiment_enabled') {
    return 'Depends on · `' + (f.id || f.experiment_id || '?') + '`';
  }
  if (t === 'range_by_hash') return 'Range by hash';
  if (t) return t.replace(/_/g, ' ');
  return null;
}

function describeFilters(filters) {
  if (!Array.isArray(filters) || !filters.length) return null;
  const parts = filters.map(describeFilter).filter(Boolean);
  return parts.length ? parts.slice(0, 5).join(' · ') : null;
}

// ── normalize one experiment ──────────────────────────────

function treatmentLabel(pos, descriptions) {
  if (pos.treatment) return String(pos.treatment).slice(0, 140);
  const b = pos.bucket;
  if (b === -1) return 'None / hors rollout';
  if (b === 0) return descriptions[0] || 'Control';
  if (typeof b === 'number' && descriptions[b]) return descriptions[b];
  return 'Treatment ' + b;
}

function normalizeExperiment(raw) {
  if (!raw || !raw.id) return null;
  const id = String(raw.id);
  const type = String(raw.type || 'unknown').toLowerCase();
  const title = String(raw.title || raw.name || id).slice(0, 200);
  const descriptions = Array.isArray(raw.description) ? raw.description : [];
  const bucketsMeta = Array.isArray(raw.buckets) ? raw.buckets : [];

  const rollout = raw.rollout || {};
  // Support both object API and rare array-shaped payloads
  let populations = rollout.populations;
  if (!populations && Array.isArray(rollout)) {
    // advaith-like tuple — skip complex, use empty
    populations = [];
  }
  populations = populations || [];

  // Aggregate by bucket across populations (global %),
  // and keep per-population detail for display
  const byBucket = new Map(); // bucket -> { intervals, label }
  const populationDetails = [];

  for (let pi = 0; pi < populations.length; pi++) {
    const pop = populations[pi] || {};
    const filterText = describeFilters(pop.filters);
    const popTreats = [];

    for (const pos of pop.position || []) {
      const bucket = pos.bucket != null ? Number(pos.bucket) : null;
      const label = treatmentLabel(pos, descriptions);
      const intervals = rolloutsToIntervals(pos.rollouts || []);
      const pct = intervalsToPct(intervals);

      popTreats.push({ bucket, label, pct });

      const key = bucket != null ? bucket : 'x:' + label;
      const prev = byBucket.get(key) || {
        bucket,
        label,
        intervals: [],
      };
      prev.intervals.push(...intervals);
      // prefer longer label
      if (label && label.length > (prev.label || '').length) prev.label = label;
      byBucket.set(key, prev);
    }

    populationDetails.push({
      index: pi,
      filters: filterText,
      treatments: popTreats,
    });
  }

  const treatments = [];
  for (const t of byBucket.values()) {
    treatments.push({
      bucket: t.bucket,
      label: t.label,
      pct: intervalsToPct(t.intervals),
    });
  }
  treatments.sort((a, b) => {
    const ba = a.bucket == null ? 9999 : a.bucket;
    const bb = b.bucket == null ? 9999 : b.bucket;
    return ba - bb;
  });

  const overrides = rollout.overrides || [];
  const overridesFormatted = rollout.overrides_formatted || [];
  const overrideIdCount = Array.isArray(overrides)
    ? overrides.reduce((n, o) => n + ((o.ids || o.k || []).length || 0), 0)
    : 0;

  const fingerprint = [
    treatments.map((t) => (t.bucket != null ? t.bucket : t.label) + ':' + t.pct.toFixed(2)).join(','),
    'ov:' + overrideIdCount,
    'pops:' + populations.length,
    populationDetails.map((p) => p.filters || '-').join(';'),
  ].join('|');

  return {
    id,
    type,
    title,
    descriptions,
    buckets: bucketsMeta,
    treatments,
    populations: populationDetails,
    overrideIdCount,
    overridesFormattedCount: Array.isArray(overridesFormatted)
      ? overridesFormatted.length
      : 0,
    populationCount: populations.length,
    fingerprint,
    revision: rollout.revision != null ? rollout.revision : null,
    hash: raw.hash != null ? raw.hash : null,
  };
}

// ── fetch + merge sources ─────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 45000,
  });
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
  const data = await res.json();
  return data;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.experiments)) return data.experiments;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

async function loadExperiments() {
  let primary = [];
  let fallback = [];
  let primaryErr = null;
  let fallbackErr = null;

  try {
    primary = asArray(await fetchJson(PRIMARY_URL));
    console.log('Primary API:', primary.length);
  } catch (e) {
    primaryErr = e.message;
    console.warn('Primary fail:', e.message);
  }

  try {
    fallback = asArray(await fetchJson(FALLBACK_URL));
    console.log('Fallback API:', fallback.length);
  } catch (e) {
    fallbackErr = e.message;
    console.warn('Fallback fail:', e.message);
  }

  if (!primary.length && !fallback.length) {
    throw new Error(
      'No experiment source available. primary=' +
        primaryErr +
        ' fallback=' +
        fallbackErr,
    );
  }

  // Primary wins on id collision; fallback fills gaps
  const byId = new Map();
  for (const raw of fallback) {
    if (raw && raw.id) byId.set(String(raw.id), raw);
  }
  for (const raw of primary) {
    if (raw && raw.id) byId.set(String(raw.id), raw);
  }

  const list = [];
  for (const raw of byId.values()) {
    const n = normalizeExperiment(raw);
    if (n) list.push(n);
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  return {
    experiments: list,
    sources: {
      primary: primary.length,
      fallback: fallback.length,
      merged: list.length,
    },
  };
}

// ── diff ──────────────────────────────────────────────────

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
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from: oldPct,
          to: t.pct,
          delta: d,
        });
      }
    }
    for (const [key, t] of pTreat) {
      const still = (n.treatments || []).some(
        (x) => (x.bucket != null ? 'b' + x.bucket : 't:' + x.label) === key,
      );
      if (!still && Math.abs(t.pct) >= MIN_PCT_DELTA) {
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from: t.pct,
          to: 0,
          delta: -t.pct,
        });
      }
    }

    const ovDelta =
      (n.overrideIdCount || 0) !== (p.overrideIdCount || 0)
        ? { from: p.overrideIdCount || 0, to: n.overrideIdCount || 0 }
        : null;

    if (deltas.length || ovDelta) {
      const maxAbs = deltas.reduce((m, x) => Math.max(m, Math.abs(x.delta)), 0);
      changed.push({ before: p, after: n, deltas, ovDelta, maxAbs });
    }
  }

  for (const [id, p] of prevById) {
    if (!nextById.has(id)) removed.push(p);
  }

  // Biggest swings first
  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, removed, changed };
}

// ── embeds ────────────────────────────────────────────────

function formatTreatments(treatments, max = 10) {
  const lines = [];
  for (const t of (treatments || []).slice(0, max)) {
    lines.push(
      '• **' + (t.label || 'Bucket ' + t.bucket) + '** · `' + t.pct + '%`',
    );
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

  embeds.push({
    author: { name: 'Apex Rollouts', icon_url: AVATAR },
    title: 'Mise à jour des pourcentages',
    description: [
      '**Sources** · primary `' +
        stats.sources.primary +
        '` · fallback `' +
        stats.sources.fallback +
        '` · merged `' +
        stats.sources.merged +
        '`',
      '**Types** · user / guild',
      '**Δ** · +`' +
        diff.added.length +
        '` · ~`' +
        diff.changed.length +
        '` · -`' +
        diff.removed.length +
        '`',
      '_% calculés avec fusion d’intervalles (0–10000)_',
    ].join('\n'),
    color: colorInfo,
    footer: { text: 'Datamining · Apex %' },
    timestamp: new Date().toISOString(),
  });

  for (const e of diff.added.slice(0, 6)) {
    const extra = [];
    if (e.populationCount > 1) extra.push('Populations · `' + e.populationCount + '`');
    if (e.overrideIdCount) extra.push('Overrides IDs · `' + e.overrideIdCount + '`');
    const filt = (e.populations || [])
      .map((p) => p.filters)
      .filter(Boolean)
      .slice(0, 2);
    if (filt.length) extra.push('Filtres · ' + filt.join(' / '));

    embeds.push({
      title: '+ ' + e.id,
      description: [
        '**' + e.title + '**',
        'Type · `' + e.type + '`',
        '',
        formatTreatments(e.treatments),
        extra.length ? '\n' + extra.join('\n') : '',
      ]
        .join('\n')
        .slice(0, 4000),
      color: colorAdd,
      footer: { text: 'Nouveau rollout' },
      url:
        e.type === 'guild'
          ? 'https://rollouts.advaith.io/'
          : undefined,
    });
  }

  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const deltaLines = c.deltas.slice(0, 12).map((d) => {
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
    if (c.ovDelta) {
      deltaLines.push(
        '• Overrides IDs · `' +
          c.ovDelta.from +
          '` → `' +
          c.ovDelta.to +
          '`',
      );
    }
    embeds.push({
      title: '~ ' + e.id,
      description: [
        '**' + e.title + '**',
        'Type · `' + e.type + '`',
        '',
        deltaLines.join('\n'),
      ]
        .join('\n')
        .slice(0, 4000),
      color: colorMod,
      footer: { text: 'Rollout modifié · Δ max ' + c.maxAbs + '%' },
    });
  }

  for (const e of diff.removed.slice(0, 4)) {
    embeds.push({
      title: '- ' + e.id,
      description: '**' + e.title + '** · `' + e.type + '`',
      color: colorRem,
      footer: { text: 'Retiré des sources' },
    });
  }

  return embeds.slice(0, 10);
}

async function postWebhook(embeds) {
  if (!WEBHOOK) return { ok: false, status: 0, text: 'no webhook' };
  const chunks = [];
  for (let i = 0; i < embeds.length; i += 10) {
    chunks.push(embeds.slice(i, i + 10));
  }
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
    await new Promise((r) => setTimeout(r, 450));
  }
  return last;
}

// ── main ──────────────────────────────────────────────────

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts v1.2…');
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

  const { experiments, sources } = await loadExperiments();
  console.log('Merged experiments:', experiments.length, sources);

  let previous = { experiments: [] };
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

  const compact = experiments.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    fingerprint: e.fingerprint,
    treatments: e.treatments,
    overrideIdCount: e.overrideIdCount,
    populationCount: e.populationCount,
    populations: (e.populations || []).map((p) => ({
      filters: p.filters,
      treatments: p.treatments,
    })),
    revision: e.revision,
  }));

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      sources,
      count: compact.length,
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
    console.log('Aucun changement de % significatif');
    return;
  }

  if (!WEBHOOK) {
    console.warn('Changements détectés mais pas de webhook');
    return;
  }

  const embeds = buildEmbeds(diff, { sources });
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

module.exports = {
  main,
  normalizeExperiment,
  intervalsToPct,
  mergeIntervals,
  diffExperiments,
};
