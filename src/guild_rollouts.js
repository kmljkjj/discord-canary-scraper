/**
 * Guild experiment rollouts v1 — % EXACTES, même technique que user v11.
 *
 * Source : gist communautaire (agnonotdev), entrées kind === "guild" avec les
 * ranges exactes par variante (échelle 0–10000, intervalles [start, end)).
 * % exact = Σ(end − start) / 10000. Aucun % estimé : une variante sans ranges
 * s'affiche honnêtement « 0% » (détection), et quand les ranges apparaissent
 * le delta s'affiche « 0% -> X% ».
 *
 * Une expérience guild qui quitte le tracker (rollout terminé ou annulé) est
 * signalée une fois (« Removed from the rollouts tracker »).
 *
 * Webhook : même chaîne que les user rollouts (première var définie gagne) :
 *   UR_WEBHOOK → USER_ROLLOUT_WEBHOOK_URL → APEX_WEBHOOK_URL
 *   → ROLLOUT_WEBHOOK_URL → DISCORD_WEBHOOK_URL
 *
 * Messages : style sobre sans emojis, identique aux user rollouts :
 *   2026-10-stage-unified-call (guild)
 *   Stage unified call
 *   Variant 1 0% -> 3.5%
 *   -# Rollouts Changes
 *
 * Env:
 *   GUILD_ROLLOUT_COMMUNITY_URL  default agnonotdev rollouts gist (raw)
 *   GUILD_ROLLOUT_MIN_DELTA      default 1 (% min pour notifier un delta)
 *   GUILD_ROLLOUT_NOTIFY_HASH    default 0 (notifier aussi les hash: sans nom)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./lib/webhook');
const { murmur3 } = require('./lib/murmur3');
const { writeJsonAtomic } = require('./lib/atomic');
const { DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');
const { safeJson, fetchWithRetry } = require('./lib/http');
const { fetchCommunityJson } = require('./lib/community');
const {
  mergeIntervals,
  parseRangeStrings,
  rangesPercentExclusive,
  classifyChange,
  stableChangeFingerprint,
} = require('./lib/rollout_math');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'guild_rollouts.json');

// Webhook IDENTIQUE aux user rollouts : la première var définie gagne.
// Ordre : salon dédié (UR_WEBHOOK) → USER_ROLLOUT_WEBHOOK_URL → APEX → ROLLOUT → DISCORD.
const WEBHOOK_CANDIDATES = [
  ['UR_WEBHOOK', process.env.UR_WEBHOOK],
  ['USER_ROLLOUT_WEBHOOK_URL', process.env.USER_ROLLOUT_WEBHOOK_URL],
  ['APEX_WEBHOOK_URL', process.env.APEX_WEBHOOK_URL],
  ['ROLLOUT_WEBHOOK_URL', process.env.ROLLOUT_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;
const MIN_DELTA = Math.max(0, Number(process.env.GUILD_ROLLOUT_MIN_DELTA || process.env.APEX_MIN_PCT_DELTA || 1));
const NOTIFY_HASH = String(process.env.GUILD_ROLLOUT_NOTIFY_HASH || '0') === '1';
// Gist communautaire (agnonotdev) : rollouts user + guild dans le même fichier.
const COMMUNITY_URL =
  process.env.GUILD_ROLLOUT_COMMUNITY_URL ||
  process.env.USER_ROLLOUT_COMMUNITY_URL ||
  'https://gist.githubusercontent.com/agnonotdev/fb2b6a7ba1301733aa5c2050b3e59a18/raw/rollouts.json';

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

function hasName(id) {
  return id && !String(id).startsWith('hash:');
}

/**
 * Gist communautaire — entrées guild uniquement. Même structure que les user :
 * { id, title, kind: "guild", hash, rollout_status, platforms, total,
 *   variants: [{ variant, role, from, to, change, ranges: ["0 - 200", ...] }] }
 *
 * Retourne un Map hash → { id, title, treatments, rolloutStatus, platforms,
 * total }. Les entrées sans ranges sont GARDÉES : détection honnête « 0% »
 * (quand les ranges apparaissent, le delta s'affiche « 0% -> X% »).
 */
async function loadCommunityGuildRollouts() {
  const map = new Map();
  // Source fraîche : API GitHub du gist (jamais cachée — cf. lib/community.js)
  // + fallback raw cache-buster, avec retries. Le gist étant la source unique
  // des % guild, un échec total propage l'erreur (poll en échec, état intact).
  const list = await fetchCommunityJson();
  let n = 0;
  for (const e of list) {
    if (!e || e.kind !== 'guild' || !e.id) continue;
    const hash = e.hash != null ? Number(e.hash) : murmur3(String(e.id));
    if (!Number.isFinite(hash)) continue;
    const treatments = [];
    for (const v of Array.isArray(e.variants) ? e.variants : []) {
      const bucket = Number(v.variant);
      if (!Number.isFinite(bucket)) continue;
      const ranges = mergeIntervals(parseRangeStrings(v.ranges));
      if (!ranges.length) {
        // Détection sans ranges : pas de % inventé, on affichera « 0% ».
        treatments.push({
          bucket,
          label: tLabel(bucket),
          percentage: null,
          pct: null,
          pctKnown: false,
          status: 'detected',
          confidence: 'none',
          sampleCount: 0,
          samples: 0,
          coverage: 0,
          intervals: [],
          ranges: [],
          observed: null,
          gapFill: 0,
          sourceKind: 'community_no_ranges',
          reported: { from: v.from, to: v.to, change: v.change },
        });
        continue;
      }
      const pct = rangesPercentExclusive(ranges);
      treatments.push({
        bucket,
        label: tLabel(bucket),
        percentage: pct,
        pct,
        pctKnown: true,
        status: 'exact',
        confidence: 'high',
        sampleCount: 0,
        samples: 0,
        coverage: pct / 100,
        intervals: ranges,
        ranges,
        observed: null,
        gapFill: 0,
        sourceKind: 'exact_from_community_ranges',
        reported: { from: v.from, to: v.to, change: v.change },
      });
    }
    if (!treatments.length) continue;
    treatments.sort((a, b) => a.bucket - b.bucket);
    map.set(hash, {
      hash,
      id: String(e.id),
      title: e.title || String(e.id),
      treatments,
      rolloutStatus: e.rollout_status || null,
      platforms: Array.isArray(e.platforms) ? e.platforms : [],
      total: e.total || null,
    });
    n++;
  }
  console.log('Community guild rollouts loaded:', n, 'of', list.length, 'gist entries');
  return { map, total: list.length, guild: n };
}

function fingerprintOf(treatments) {
  return (treatments || [])
    .map((t) => {
      if (!t.pctKnown || t.pct == null || t.status === 'insufficient_data') {
        return t.bucket + ':?';
      }
      return t.bucket + ':' + Math.round(Number(t.pct)).toFixed(1);
    })
    .sort()
    .join('|');
}

// ─── Embeds — format sobre, sans emojis (identique aux user rollouts) ────────

function fmtPct(pct) {
  const v = Number(pct);
  if (pct == null || !Number.isFinite(v)) return '0'; // % inconnu (pas de ranges) = 0% déployé
  return String(Math.round(v * 10) / 10);
}

/** Label de variante au format communautaire : None / Variant N. */
function variantLabel(bucket) {
  return Number(bucket) === -1 ? 'None' : 'Variant ' + bucket;
}

/**
 * Format des messages (style communautaire, sans emojis) :
 *   2026-10-stage-unified-call (guild)
 *   Stage unified call
 *   Variant 1 0% -> 3.5%
 *   -# Rollouts Changes
 */
function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 10)) {
    const title = (String(c.id || c.title) + ' (guild)').slice(0, 256);
    const lines = [];

    // Ligne description / nom si différent de l'id
    if (c.title && c.title !== c.id) lines.push(String(c.title).slice(0, 300));

    if (c.kind === 'new') {
      for (const t of (c.treatments || []).slice(0, 12)) {
        lines.push(variantLabel(t.bucket) + ' ' + (t.pctKnown && t.pct != null ? fmtPct(t.pct) + '%' : '0%'));
      }
    } else if (c.kind === 'pct') {
      for (const d of (c.deltas || []).slice(0, 12)) {
        lines.push(variantLabel(d.bucket) + ' ' + fmtPct(d.from) + '% -> ' + fmtPct(d.to) + '%');
      }
    } else if (c.kind === 'gone') {
      lines.push('Removed from the rollouts tracker');
    }

    embeds.push({
      title,
      description: lines.join('\n').slice(0, 4000),
      color:
        c.kind === 'pct'
          ? (c.deltas || []).some((d) => Number(d.to) >= 100)
            ? 0x57f287
            : (c.deltas || []).some((d) => Number(d.to) <= 0)
              ? 0xed4245
              : 0xe67e22
          : c.kind === 'gone'
            ? Number(c.lastSumPct) >= 100
              ? 0x57f287
              : Number(c.lastSumPct) <= 0
                ? 0xed4245
                : 0xe67e22
            : 0x5865f2,
      footer: { text: 'Rollouts Changes' },
    });
  }
  return embeds;
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  return sendEmbeds(
    WEBHOOK,
    { username: BOT.slice(0, 80), avatar_url: AVATAR },
    embeds,
    { label: 'guild-rollouts', withDismiss: true },
  );
}

async function main() {
  await fs.ensureDir(DATA);
  console.log('Guild rollouts v1 (EXACT community ranges · no fake %)');
  console.log('Webhook:', WEBHOOK ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  console.log('Min delta:', MIN_DELTA + '%');

  // Source unique des % guild : ranges exactes du gist communautaire.
  const community = await loadCommunityGuildRollouts();

  const experiments = [];
  for (const [hash, c] of community.map) {
    const coveredAll = c.treatments.reduce((s, t) => s + (t.coverage || 0), 0);
    const exact = c.treatments.some((t) => t.pctKnown && t.pct != null);
    experiments.push({
      hash,
      id: c.id,
      title: c.title,
      type: 'guild',
      quality: exact ? 'exact' : 'detected',
      status: exact ? 'exact' : 'detected',
      confidence: exact ? 1 : 0,
      coverage: Math.round(Math.min(coveredAll, 1) * 1000) / 1000,
      sumPct: Math.round(c.treatments.reduce((s, t) => s + (t.pctKnown && t.pct != null ? t.pct : 0), 0) * 100) / 100,
      treatments: c.treatments,
      fingerprint: fingerprintOf(c.treatments),
      source: 'community_ranges',
      named: hasName(c.id),
      platforms: c.platforms,
      rolloutStatus: c.rolloutStatus,
      communityTotal: c.total,
    });
  }
  experiments.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  console.log(
    'Guild experiments:',
    experiments.length,
    'exact',
    experiments.filter((e) => e.status === 'exact').length,
    'detected-only',
    experiments.filter((e) => e.status === 'detected').length,
  );

  // Gist vide (0 entrée) : format cassé ou indispo — ne pas écraser l'état.
  // 0 guild alors qu'il reste des entrées user est légitime : les exp guild
  // restantes sont notifiées comme disparues, l'état passe à vide.
  if (!community.total) {
    console.warn('Gist empty (' + community.total + ' entries) — state untouched, failing');
    process.exitCode = 1;
    return;
  }

  let prev = { experiments: [], announced: {} };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const announced = prev.announced && typeof prev.announced === 'object' ? { ...prev.announced } : {};
  const isFirst = !(prev.experiments && prev.experiments.length);

  const changes = [];
  // Disparitions non encore notifiées (webhook en échec) — rejouées au
  // prochain run jusqu'à succès.
  const pendingGone =
    prev.pendingGone && typeof prev.pendingGone === 'object' ? { ...prev.pendingGone } : {};
  const currentHashes = new Set(experiments.map((e) => String(e.hash)));

  if (!isFirst) {
    const pMap = new Map((prev.experiments || []).map((e) => [String(e.hash), e]));
    const seenIds = new Set(experiments.map((e) => String(e.id)));

    for (const n of experiments) {
      if (!n.named && !NOTIFY_HASH) continue;
      const key = String(n.hash);
      const ann = announced[key];
      const annFp =
        ann && typeof ann === 'object' ? ann.fp : typeof ann === 'string' ? ann : null;
      if (annFp === n.fingerprint) continue; // déjà notifié à l'identique
      if (annFp === 'gone') {
        // Retour après disparition : notifie comme nouvelle expérience.
        changes.push({ kind: 'new', ...n });
        continue;
      }
      const p = pMap.get(key);
      if (!ann) {
        if (!p) {
          changes.push({ kind: 'new', ...n });
          continue;
        }
        // Vu au run précédent mais JAMAIS notifié (webhook en échec) :
        // re-notifie comme nouvelle expérience tant que le fingerprint n'a
        // pas bougé (sinon delta normal ci-dessous).
        if (p.fingerprint === n.fingerprint) {
          changes.push({ kind: 'new', ...n });
          continue;
        }
      }

      // Base de comparaison : dernier état NOTIFIÉ (ann.treatments) — le
      // delta est rejoué correctement même si le webhook a échoué au run
      // précédent. Fallback : dernier état vu (p.treatments).
      const base =
        ann && typeof ann === 'object' && Array.isArray(ann.treatments) && ann.treatments.length
          ? ann.treatments
          : (p && p.treatments) || [];
      const deltas = [];
      const pt = new Map(base.map((t) => [t.bucket, t]));
      for (const t of n.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue; // % inconnu → attendre les ranges
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) {
          // Nouvelle variante dans le rollout, ou % qui devient connu
          // (ranges apparus) : from = null → affiché « 0% -> X% ».
          if (Number(t.pct) > 0) {
            deltas.push({
              label: t.label,
              bucket: t.bucket,
              from: null,
              to: Number(t.pct),
              change: Number(t.pct),
              changeType: 'ROLLOUT_APPEARED',
              population: 'guild',
              treatment: t.label,
            });
          }
          continue;
        }
        const from = Number(oldT.pct);
        const to = Number(t.pct);
        // % exacts des ranges : pas de marge de bruit nécessaire.
        const { changeType, change } = classifyChange(from, to, MIN_DELTA);
        if (!changeType || changeType === 'ROLLOUT_DATA_DEGRADED') continue;
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from,
          to,
          change,
          changeType,
          population: 'guild',
          treatment: t.label,
        });
      }
      if (deltas.length) {
        changes.push({
          kind: 'pct',
          id: n.id,
          title: n.title,
          hash: n.hash,
          deltas,
          named: n.named,
          changeFingerprint: stableChangeFingerprint({
            id: n.id,
            deltas: deltas.map((d) => [d.bucket, d.from, d.to, d.changeType]),
          }),
          exact: true,
        });
      }
    }

    // Expériences guild retirées du tracker (rollout terminé / annulé).
    // Stockées dans pendingGone : re-notifiées jusqu'à succès du webhook.
    for (const [key, p] of pMap) {
      if (currentHashes.has(key)) continue;
      if (seenIds.has(String(p.id))) continue; // hash renuméroté, pas disparu
      if (!p.named && !NOTIFY_HASH) continue;
      const lastSumPct = (p.treatments || []).reduce(
        (s, t) => s + (t.pctKnown && t.pct != null ? Number(t.pct) : 0),
        0,
      );
      const gone = {
        kind: 'gone',
        id: p.id,
        title: p.title,
        hash: p.hash != null ? p.hash : Number(key),
        lastSumPct: Math.round(lastSumPct * 10) / 10,
        named: p.named,
      };
      changes.push(gone);
      pendingGone[key] = gone;
    }
  }

  // Rejoue les disparitions pas encore notifiées (webhook en échec avant).
  for (const [key, g] of Object.entries(pendingGone)) {
    if (currentHashes.has(key)) {
      delete pendingGone[key]; // revenue dans le tracker — plus « gone »
      continue;
    }
    if (changes.some((c) => c.kind === 'gone' && String(c.hash) === key)) continue;
    changes.push({ ...g, hash: Number(key) });
  }

  /** Résumé minimal d'un jeu de traitements pour le replay des deltas. */
  const annValue = (exp) => ({
    fp: exp.fingerprint,
    treatments: (exp.treatments || []).map((t) => ({
      bucket: t.bucket,
      pct: t.pct,
      pctKnown: !!t.pctKnown,
    })),
  });

  async function writeState(announcedMap, extra = {}) {
    const prevHist = Array.isArray(prev.history) ? prev.history : [];
    const histEntry = {
      ts: new Date().toISOString(),
      experimentCount: experiments.length,
      changeCount: (extra.changes && extra.changes.length) || 0,
    };
    const history = [...prevHist, histEntry].slice(-40);
    await writeJsonAtomic(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        version: 1,
        schemaVersion: 1,
        experiments,
        announced: announcedMap,
        pendingGone,
        history,
        lastChanges: extra.changes || prev.lastChanges || [],
      },
      2,
    );
  }

  // Premier run : seed silencieux (pas de flood de « nouvelles » expériences).
  if (isFirst) {
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) seedAnnounced[String(e.hash)] = annValue(e);
    }
    await writeState(seedAnnounced);
    console.log('Seed', experiments.length, '· no notify');
    return;
  }

  // Persiste les expériences pour les deltas du prochain run, announced
  // NON avancé tant que le webhook n'a pas réussi.
  await writeState(announced);

  console.log('Changes', changes.length);
  if (!changes.length) {
    console.log('No significant named guild % change');
    return;
  }

  const notifyList = changes.slice(0, 10);
  const embeds = buildEmbeds(notifyList);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (!sent.ok) {
    console.warn('NOTIFY_FAIL guild_rollouts — announced NOT advanced; will retry next run');
    process.exitCode = 2;
    return;
  }

  // Succès seulement : verrouille l'état notifié (fingerprint + traitements)
  // et acquitte les disparitions notifiées.
  for (const c of notifyList) {
    if (c.kind === 'new' && c.hash != null && c.fingerprint) {
      announced[String(c.hash)] = annValue(c);
    } else if (c.kind === 'pct') {
      const exp = experiments.find((e) => e.hash === c.hash);
      if (exp) announced[String(exp.hash)] = annValue(exp);
    } else if (c.kind === 'gone' && c.hash != null) {
      announced[String(c.hash)] = { fp: 'gone' };
      delete pendingGone[String(c.hash)];
    }
  }
  await writeState(announced, { changes: notifyList });
  console.log('Done (announced advanced after webhook OK)');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { main, loadCommunityGuildRollouts, buildEmbeds, fingerprintOf, variantLabel };

