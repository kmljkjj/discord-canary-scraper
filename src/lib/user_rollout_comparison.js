/**
 * Comparaison en lecture seule : gist ≠ échantillonnage ≠ accès réel.
 * Aucune requête réseau, aucune notification, aucun remplacement d'un % par l'autre.
 */
'use strict';
const { murmur3 } = require('./murmur3');
const { computeExperiment } = require('./gist_rollouts');
const P = require('./position_bounds');

const HOUR = 3600000;
const PCT = (k, n) => Math.round(10000 * k / n) / 100;

function experimentHash(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const match = id.match(/^hash:(\d+)$/);
  if (id.startsWith('hash:')) {
    const h = match ? Number(match[1]) : NaN;
    return Number.isInteger(h) && h >= 0 && h <= 0xffffffff ? h : null;
  }
  return murmur3(id);
}

/** Wilson 95 %, z=1,959963984540054. Bornes non arrondies pour les comparaisons. */
function wilson95(k, n) {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || n <= 0 || k < 0 || k > n) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return { lo: k === 0 ? 0 : Math.max(0, 100 * (centre - half)), hi: k === n ? 100 : Math.min(100, 100 * (centre + half)) };
}

function freshness(at, now, hours) {
  const ts = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(ts) || ts > now + 300000) return { state: 'unknown', ageHours: null };
  const ageHours = Math.max(0, (now - ts) / HOUR);
  return { state: ageHours > hours ? 'stale' : 'recent', ageHours };
}

function measured(e, gist, at, now) {
  if (!e) return { status: 'not_observed', n: null, k: null, pct: null, ci: null, variants: [], observedAt: null };
  const base = { source: e.source || 'own_sampling', observedAt: at || null, freshness: freshness(at, now, 6),
    n: e.windowN ?? null, k: null, pct: null, ci: null, variants: [],
    scope: 'Empreintes anonymes multi-contextes du collecteur ; pas les utilisateurs Discord.',
    limitations: ['Filtres de population inconnus.', 'Une absence de réponse ne prouve pas une absence d’accès.',
      'IC conditionnel au protocole, à l’indépendance des observations et à une configuration stable ; ne couvre pas les biais de collecte.'],
    revision: e.revision ?? null, roleBasis: null };
  const n = e.windowN;
  if (!Number.isSafeInteger(n) || n <= 0 || !Array.isArray(e.treatments) || !e.treatments.length) return { ...base, status: 'invalid' };
  if (e.source && e.source !== 'own_sampling' && e.source !== 'fingerprint_sampling') return { ...base, status: 'invalid' };
  const counts = new Map();
  let sum = 0;
  for (const t of e.treatments) {
    if (!t || !Number.isInteger(t.bucket) || t.bucket < -1 || !Number.isSafeInteger(t.sampleCount) || t.sampleCount < 0 || t.sampleCount > n || counts.has(t.bucket)) return { ...base, status: 'invalid' };
    counts.set(t.bucket, t.sampleCount);
    sum += t.sampleCount;
  }
  if (sum > n) return { ...base, status: 'invalid' };
  const roles = gist && gist.byVariant || {};
  const roleConflict = gist && (gist.flags || []).some((f) => ['role_conflict', 'unknown_role', 'invalid_ranges'].includes(f));
  // Sans mapping communautaire exploitable, ne pas assimiler les buckets >0 à un traitement.
  const treatmentIds = !roleConflict && gist && gist.hasData
    ? Object.entries(roles).filter(([, v]) => v.role === 'treatment').map(([b]) => Number(b))
    : null;
  const variants = [...counts].sort((a, b) => a[0] - b[0]).map(([bucket, k]) => ({ bucket, k, n, pct: PCT(k, n), ci: wilson95(k, n), role: roles[bucket]?.role || 'unknown' }));
  const k = treatmentIds ? [...counts].reduce((s, [b, c]) => s + (treatmentIds.includes(b) ? c : 0), 0) : null;
  return { ...base, status: 'measured', variants, roleBasis: treatmentIds ? 'gist_roles' : 'unknown',
    k, pct: k == null ? null : PCT(k, n), ci: k == null ? null : wilson95(k, n),
    observedAssignments: { k: sum, n, pct: PCT(sum, n), ci: wilson95(sum, n) } };
}

/**
 * Catalogue complet des sources locales. Jointure par nom EXACT ou hash vérifié,
 * collisions et types contradictoires bloquent la jointure. Pas de correction
 * heuristique des tirets/underscores (cela changerait le hash Discord).
 */
function docsEntry(c) {
  return {
    id: c.id, title: c.id, type: 'unclassified', hasData: c.hasData, totalsAvailable: c.totalsAvailable,
    ambiguous: c.ambiguous, projected: c.projected || false, flags: c.flags || [],
    treatmentPct: c.hasData && c.treatment ? c.treatment.pct : null,
    projectedTreatmentPct: c.hasData && c.projectedCoverage ? c.projectedCoverage.treatment.pct : null,
    controlPct: c.hasData && c.control ? c.control.pct : null,
    notEligiblePct: c.hasData && c.notEligible ? c.notEligible.pct : null,
    unassignedPct: c.hasData && c.unassigned ? c.unassigned.pct : null,
    byVariant: Object.fromEntries(Object.entries(c.byVariant || {}).map(([k, v]) => [k, { pct: v.pct, role: v.role }])),
  };
}

/**
 * Bornes issues des positions observées (position_bounds) face à la couverture gist.
 * Un état dont le hash ne correspond pas au nom, ou illisible, est ignoré.
 */
function positionsEntry(state, hash, gistPct, sourceRanges, updatedAt) {
  if (!state || typeof state !== 'object' || state.hash !== hash) return null;
  const s = P.normalize(state);
  const b = P.bounds(s);
  if (!b) return null;
  const treat = Array.isArray(sourceRanges)
    ? sourceRanges.filter((v) => v && v.role === 'treatment').flatMap((v) => v.ranges || [])
    : null;
  const ag = treat ? P.agreement(s, treat) : null;
  const eps = 0.011; // arrondi au centième de point
  const gistInBounds = Number.isFinite(gistPct) && b.estPct != null
    ? gistPct >= b.minPct - eps && gistPct <= b.maxPct + eps : null;
  return { ...b, revision: s.revision, updatedAt: updatedAt || null, assumption: 'contiguous_ranges',
    agreement: ag, gistInBounds,
    verdict: ag && ag.contradictingPositions > 0 ? 'contradicts_gist'
      : gistInBounds === true ? 'consistent_with_gist'
        : gistInBounds === false ? 'differs_from_gist' : 'no_gist_comparison' };
}

function buildComparison({ gist = {}, rawGist = [], sampling = {}, definitions = [], positions = {}, now = Date.now(), onlyObserved = false } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('now doit être un timestamp fini');
  // null explicite (fichier absent/illisible) traité comme absent, pas seulement undefined.
  gist = gist && typeof gist === 'object' ? gist : {};
  sampling = sampling && typeof sampling === 'object' ? sampling : {};
  positions = positions && typeof positions === 'object' ? positions : {};
  definitions = Array.isArray(definitions) ? definitions : [];
  const records = new Map();
  const byHash = new Map();
  const diagnostics = [];
  const put = (e) => {
    if (!e || typeof e.id !== 'string' || !e.id || e.id.startsWith('hash:')) return null;
    let r = records.get(e.id);
    if (!r) {
      r = { id: e.id, title: e.title || e.label || e.id, hash: experimentHash(e.id), types: new Set(), gist: null, samples: [] };
      records.set(e.id, r);
      if (!byHash.has(r.hash)) byHash.set(r.hash, []);
      byHash.get(r.hash).push(r);
    }
    const type = e.type || e.kind;
    if (type === 'user' || type === 'guild') r.types.add(type);
    return r;
  };
  for (const e of definitions) put(e);
  // Gist brut (optionnel) : noms pour résoudre les hash, plages sources, couverture des non-classés.
  const rawById = new Map();
  for (const raw of Array.isArray(rawGist) ? rawGist : []) {
    const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || id.startsWith('hash:')) continue;
    if (rawById.has(id)) { diagnostics.push({ id, code: 'duplicate_gist_raw' }); continue; }
    rawById.set(id, computeExperiment(raw));
    put({ id });
  }
  for (const e of Array.isArray(gist.experiments) ? gist.experiments : []) {
    const r = put(e);
    if (r) {
      if (r.gist) diagnostics.push({ id: r.id, code: 'duplicate_gist' });
      else r.gist = e;
    }
  }
  for (const e of Array.isArray(sampling.experiments) ? sampling.experiments : []) {
    if (!e || e.type !== 'user') continue;
    const hash = Number.isInteger(e.hash) && e.hash >= 0 && e.hash <= 0xffffffff ? e.hash : experimentHash(e.id);
    if (hash == null) { diagnostics.push({ id: e.id, code: 'invalid_hash' }); continue; }
    if (e.id && !e.id.startsWith('hash:') && experimentHash(e.id) !== hash) {
      diagnostics.push({ id: e.id, code: 'hash_mismatch' }); continue;
    }
    const candidates = byHash.get(hash) || [];
    if (candidates.length > 1) { diagnostics.push({ hash, code: 'hash_collision' }); continue; }
    let r = candidates[0];
    if (!r) {
      // Hash vu par Discord sans nom connu : identifiant explicite, jamais un nom inventé.
      r = { id: `hash:${hash}`, title: `hash:${hash}`, hash, types: new Set(), gist: null, samples: [] };
      records.set(r.id, r);
      byHash.set(hash, [r]);
    }
    if (r.types.has('guild')) { diagnostics.push({ id: r.id, code: 'type_conflict' }); continue; }
    r.types.add('user');
    r.samples.push(e);
  }
  const experiments = [];
  let unclassifiedCount = 0;
  for (const r of records.values()) {
    const type = r.types.size === 1 ? [...r.types][0] : 'unclassified';
    // Les serveurs gardent leur pipeline wire existant, jamais un % user.
    if (type === 'guild') continue;
    // Les non classés (ni user ni guild) ne sont pas publiés : aucun type à afficher.
    if (type === 'unclassified') { unclassifiedCount++; continue; }
    const raw = rawById.get(r.id);
    let g = r.gist;
    if (!g && raw && raw.hasData !== undefined && type === 'user') g = docsEntry(raw);
    let m = measured(r.samples[0], g, sampling.scrapedAt, now);
    if (r.samples.length > 1 || r.types.size > 1) m = { ...m, status: 'invalid', pct: null, ci: null, k: null };
    const coverage = g ? { ...g, verified: false, updatedAt: gist.source?.updatedAt || null,
      fetchedAt: gist.generatedAt || null, revision: gist.source?.revision || null,
      htmlUrl: gist.source?.htmlUrl || null,
      sourceRanges: raw ? raw.variants.map((v) => ({ variant: v.variant, role: v.role, ranges: v.ranges })) : null,
      freshness: freshness(gist.source?.updatedAt, now, 72) } : null;
    // Même si le % est hors IC, ce n'est pas la preuve d'un gist faux : audience,
    // date et révision Discord ne sont pas garanties identiques.
    const comparable = type === 'user' && g?.totalsAvailable && !g?.projected && m.status === 'measured' && m.ci && Number.isFinite(g.treatmentPct);
    const observation = !comparable ? 'not_comparable' : (g.treatmentPct < m.ci.lo || g.treatmentPct > m.ci.hi) ? 'outside_interval' : 'inside_interval';
    if (onlyObserved && m.status === 'not_observed') continue;
    const pe = positionsEntry(positions.experiments && positions.experiments[r.id], r.hash, g ? g.treatmentPct : null,
      coverage && coverage.sourceRanges, positions.updatedAt);
    experiments.push({ id: r.id, title: r.title, hash: r.hash, type, coverage, measurement: m, positions: pe,
      comparison: { observation, verdict: 'not_verified', samePopulationEstablished: false,
        deltaPoints: comparable ? Math.round((m.pct - g.treatmentPct) * 100) / 100 : null } });
  }
  experiments.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(),
    semantics: 'Couverture gist non vérifiée et observations API : deux métriques séparées, jamais une proportion réelle d’utilisateurs.',
    sources: { positions: { updatedAt: positions.updatedAt || null, scheduled: true }, gist: gist.source || null, sampling: { observedAt: sampling.scrapedAt || null,
      url: 'https://canary.discord.com/api/v10/experiments', scheduled: false } },
    stats: { published: experiments.length, user: experiments.length,
      unclassified: unclassifiedCount,
      measured: experiments.filter((e) => e.measurement.status === 'measured').length,
      notObserved: experiments.filter((e) => e.measurement.status === 'not_observed').length },
    diagnostics, experiments };
}

module.exports = { experimentHash, wilson95, freshness, measured, positionsEntry, buildComparison };
