/**
 * Pure rollout interval math — no I/O, no tokens.
 * SCALE is Discord-style hash bucket space (0 .. SCALE-1).
 */

const DEFAULT_SCALE = 10000;

/**
 * Fusion de plages de POINTS OBSERVÉS (sémantique inclusive :
 * [0,10]+[11,20] → [0,20]). Utilisée pour les positions discrètes
 * observées, jamais pour les plages demi-ouvertes du wire Discord.
 */
function mergeIntervals(intervals) {
  if (!intervals || !intervals.length) return [];
  const sorted = intervals
    .map((pair) => {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return [Math.min(a, b), Math.max(a, b)];
    })
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (!sorted.length) return [];
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Fusion de plages DEMI-OUVERTES [start, end) du wire Discord.
 * Deux plages ne fusionnent que si elles se chevauchent ou se touchent
 * SANS trou : [0,1)+[1,3) → [0,3), mais [0,1)+[2,3) reste séparé
 * (le trou [1,2) est une vraie zone non couverte).
 * L'ancienne fusion inclusive remplissait ces trous → % surestimé.
 */
function mergeIntervalsHalfOpen(intervals) {
  if (!intervals || !intervals.length) return [];
  const sorted = intervals
    .map((pair) => {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
      return [Math.min(a, b), Math.max(a, b)];
    })
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (!sorted.length) return [];
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intervalsCoverage(intervals, scale = DEFAULT_SCALE) {
  const merged = mergeIntervals(intervals);
  const raw = merged.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
  return Math.min(scale, Math.max(0, raw));
}

function coveragePercent(intervals, scale = DEFAULT_SCALE) {
  if (!scale || scale <= 0) return null;
  const cov = intervalsCoverage(intervals, scale);
  return Math.round((cov / scale) * 10000) / 100;
}

/** Discrete observed points → intervals with gap-fill, then merge. */
function pointsToIntervals(points, gapFill, scale = DEFAULT_SCALE) {
  const gap = Math.max(1, Number(gapFill) || 1);
  const pts = [
    ...new Set(
      (points || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0 && n < scale),
    ),
  ].sort((a, b) => a - b);
  if (!pts.length) return [];
  const intervals = [];
  let start = pts[0];
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i] - prev <= gap) prev = pts[i];
    else {
      intervals.push([start, prev]);
      start = prev = pts[i];
    }
  }
  intervals.push([start, prev]);
  return mergeIntervals(intervals);
}

function estimateFromPoints(points, totalOk, scale = DEFAULT_SCALE) {
  const samples = (points || []).length;
  if (samples < 3) {
    return {
      percentage: null,
      status: 'insufficient_data',
      confidence: 'low',
      coverage: 0,
      sampleCount: samples,
      ranges: [],
      observed: null,
    };
  }
  const gapFill = Math.max(
    1,
    Math.min(80, Math.floor(scale / Math.max(totalOk * 2, 40))),
  );
  const ranges = pointsToIntervals(points, gapFill, scale);
  const covered = intervalsCoverage(ranges, scale);
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((covered / scale) * 10000) / 100),
  );
  const nums = points.map(Number).filter(Number.isFinite);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = Math.max(1, max - min + 1);
  const density = samples / span;
  let confidence = 'low';
  if (samples >= 30 && density >= 0.02) confidence = 'high';
  else if (samples >= 12) confidence = 'medium';
  const status =
    confidence === 'low' || samples < 8 ? 'degraded' : 'estimated';
  return {
    percentage,
    status,
    confidence,
    coverage: Math.round((covered / scale) * 1000) / 1000,
    sampleCount: samples,
    ranges,
    observed: [min, max],
    gapFill,
    sourceKind: 'estimated_from_samples',
  };
}

/**
 * Marge de bruit (en points de %) pour la différence entre deux estimations
 * indépendantes faites chacune sur `samples` tirages.
 * z * sqrt(2 · p(1-p) / n) · 100  (z = 2 ≈ 95 %).
 * Ex. p = 10 %, n = 150 → ≈ 6,9 pts : un passage 10 % → 12 % est du bruit.
 */
function noiseMargin(pct, samples, z = 2) {
  const n = Number(samples);
  const p = Number(pct) / 100;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || z <= 0) return 0;
  const q = Math.min(1, Math.max(0, p));
  // plancher à 1/n pour ne pas annuler la marge aux extrêmes (0 % / 100 %)
  const v = Math.max(q * (1 - q), 1 / n);
  return Math.round(z * Math.sqrt((2 * v) / n) * 10000) / 100;
}

/** Classify old→new percentage (null-safe). minDelta in percent points. */
function classifyChange(oldPct, newPct, minDelta = 1) {
  const o = oldPct == null || !Number.isFinite(Number(oldPct)) ? null : Number(oldPct);
  const n = newPct == null || !Number.isFinite(Number(newPct)) ? null : Number(newPct);
  if (o == null && n == null) return { changeType: null, change: null };
  if (o == null && n != null) {
    if (n <= 0) return { changeType: 'ROLLOUT_STARTED', change: n };
    if (n >= 100) return { changeType: 'ROLLOUT_COMPLETED', change: n };
    return { changeType: 'ROLLOUT_STARTED', change: n };
  }
  if (o != null && n == null) {
    return { changeType: 'ROLLOUT_DATA_DEGRADED', change: null };
  }
  const delta = Math.round((n - o) * 100) / 100;
  if (Math.abs(delta) < minDelta) return { changeType: null, change: 0 };
  if (o > 0 && n <= 0) return { changeType: 'ROLLOUT_REMOVED', change: delta };
  if (o < 100 && n >= 100) return { changeType: 'ROLLOUT_COMPLETED', change: delta };
  if (delta > 0) return { changeType: 'ROLLOUT_INCREASED', change: delta };
  if (delta < 0) return { changeType: 'ROLLOUT_DECREASED', change: delta };
  return { changeType: 'ROLLOUT_CHANGED', change: delta };
}

function stableChangeFingerprint(parts) {
  const crypto = require('crypto');
  const payload = JSON.stringify(parts, Object.keys(parts).sort());
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function normalizeRanges(ranges) {
  return mergeIntervals(ranges || []).map(([a, b]) => [a, b]);
}

/**
 * Parse human-readable rollout range strings ("150 - 3000", accepts – and —)
 * into numeric [start, end) intervals.
 */
function parseRangeStrings(rawRanges) {
  return (rawRanges || [])
    .map((s) => String(s).split(/\s*[-–—]\s*/))
    .map((parts) => [Number(parts[0]), Number(parts[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
}

/**
 * Exact percentage for half-open ranges on Discord's 0–10000 hash space:
 * % = Σ(end − start) / scale (ex. 0-1500 + 3000-4000 + 5000-7500
 * → 15 + 10 + 25 = 50%).
 */
function rangesPercentExclusive(intervals, scale = DEFAULT_SCALE) {
  if (!scale || scale <= 0) return 0;
  const merged = mergeIntervalsHalfOpen(intervals);
  if (!merged.length) return 0;
  const covered = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  return Math.round((Math.min(Math.max(covered, 0), scale) / scale) * 10000) / 100;
}

// ─── Estimation binomiale honnête ───────────────────────────────────────────

/**
 * Intervalle de confiance de Wilson pour une proportion k/n.
 * Contrairement à σ = √(p̂(1−p̂)/n), reste valide aux extrêmes
 * (k = 0 ou k = n) : jamais de CI de largeur nulle.
 * @returns {{lo:number, hi:number, sigma:number}} en points de %
 */
function wilsonPctInterval(k, n, z = 2) {
  const kk = Math.max(0, Number(k) || 0);
  const nn = Math.max(0, Number(n) || 0);
  if (nn <= 0) return { lo: 0, hi: 100, sigma: 100 };
  const p = kk / nn;
  const z2 = z * z;
  const denom = 1 + z2 / nn;
  const centre = p + z2 / (2 * nn);
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * nn)) / nn)) / denom;
  const lo = Math.max(0, (centre - half) / denom);
  const hi = Math.min(1, (centre + half) / denom);
  return {
    lo: Math.round(lo * 10000) / 100,
    hi: Math.round(hi * 10000) / 100,
    sigma: Math.round(100 * Math.sqrt(Math.max(p * (1 - p), 1 / nn) / nn) * 100) / 100,
  };
}

/**
 * Marge de bruit EXACTE (au niveau batch) pour Δpct entre deux fenêtres
 * glissantes qui PARTAGENT des batchs — les échantillons communs ne
 * comptent qu'une fois. Chaque batch b contribue w_b²·ok_b·p(1−p) avec
 * w_b = 1/n_new·[b∈new] − 1/n_old·[b∈old].
 * Retourne la demi-largeur en points de % (0 si non calculable).
 */
function slidingWindowDeltaMargin(batchesOld, batchesNew, pct, z = 2) {
  const p = Math.max(0, Math.min(1, Number(pct) / 100));
  const q = Math.max(p * (1 - p), 1e-6);
  const idOf = (b) => (b && b.bid != null ? String(b.bid) : b && b.ts != null ? 'ts:' + b.ts : null);
  const nOld = (batchesOld || []).reduce((s, b) => s + (Number(b && b.ok) || 0), 0);
  const nNew = (batchesNew || []).reduce((s, b) => s + (Number(b && b.ok) || 0), 0);
  if (nOld <= 0 || nNew <= 0 || z <= 0) return 0;
  // Poids de chaque batch : w = 1/n_new·[b∈new] − 1/n_old·[b∈old].
  // Un batch présent dans les DEUX fenêtres a un poids 1/n_new − 1/n_old,
  // un batch d'une seule fenêtre un poids ±1/n → variance exacte de Δp̂.
  const byId = new Map();
  for (const b of batchesOld || []) {
    const id = idOf(b);
    if (!id) continue;
    byId.set(id, { b, w: -1 / nOld });
  }
  for (const b of batchesNew || []) {
    const id = idOf(b);
    if (!id) continue;
    const e = byId.get(id);
    if (e) e.w += 1 / nNew;
    else byId.set(id, { b, w: 1 / nNew });
  }
  let varSum = 0;
  for (const { b, w } of byId.values()) {
    varSum += w * w * (Number(b && b.ok) || 0) * q;
  }
  if (!(varSum > 0)) return 0;
  return Math.round(z * Math.sqrt(varSum) * 10000) / 100;
}

// ─── Reconstruction indicative de bornes (MODÈLE ordre-statistiques) ────────

/**
 * Reconstruit les plages d'un bucket depuis les positions observées.
 * MODÈLE : positions uniformes dans des intervalles inconnus ; correction
 * de biais « German tank » (E[max] = hi − W/(m+1)).
 * RÉSULTAT INDICATIF, dépendant du modèle — jamais présenté comme exact.
 * @param {number[]} positions hash_result observés (0..scale-1)
 * @returns null si < 3 points, sinon
 *   { ranges: [[lo,hi],...], coverage, pct, ci, m, clusters }
 */
function reconstructBucketRanges(positions, scale = DEFAULT_SCALE) {
  const pts = [
    ...new Set(
      (positions || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0 && n < scale),
    ),
  ].sort((a, b) => a - b);
  const m = pts.length;
  if (m < 3) return null;

  // Clustering adaptatif : un trou n'est une séparation que s'il dépasse
  // ~6× l'espacement moyen observé (dans une plage uniforme, le plus grand
  // trou attendu ≈ W·ln(m)/m reste bien en dessous).
  const span = pts[m - 1] - pts[0];
  const meanGap = span / Math.max(m - 1, 1);
  const thresh = Math.max(4, meanGap * 6);
  const clusters = [];
  let start = 0;
  for (let i = 1; i < m; i++) {
    if (pts[i] - pts[i - 1] > thresh) {
      clusters.push(pts.slice(start, i));
      start = i;
    }
  }
  clusters.push(pts.slice(start));

  const ranges = [];
  let ciHalf = 0;
  for (const c of clusters) {
    const lo = c[0];
    const hi = c[c.length - 1];
    const cm = c.length;
    if (cm < 2) {
      ranges.push([lo, hi]);
      continue;
    }
    // Pas d'ordre moyen → élargissement symétrique sans biais d'extrêmes.
    const step = (hi - lo) / Math.max(cm - 1, 1);
    const a = Math.max(0, lo - step);
    const b = Math.min(scale, hi + step);
    ranges.push([Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
    // Var(max de m uniformes sur W) = m·W²/((m+1)²(m+2)) — par borne.
    const W = Math.max(hi - lo, 1);
    const vBound = (cm * W * W) / ((cm + 1) * (cm + 1) * (cm + 2));
    ciHalf += 2 * vBound; // deux bornes indépendantes → variances additives
  }
  const merged = mergeIntervalsHalfOpen(ranges.map(([a, b]) => [a, b]));
  const covered = merged.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    ranges: merged,
    coverage: Math.round(Math.min(covered, scale) * 1000) / 1000,
    pct: Math.round((Math.min(covered, scale) / scale) * 10000) / 100,
    ci: Math.round((Math.sqrt(Math.max(ciHalf, 0)) / scale) * 10000) / 100,
    m,
    clusters: clusters.length,
    model: 'order_statistics',
    status: 'indicative',
  };
}

module.exports = {
  noiseMargin,
  DEFAULT_SCALE,
  mergeIntervals,
  mergeIntervalsHalfOpen,
  wilsonPctInterval,
  slidingWindowDeltaMargin,
  reconstructBucketRanges,
  intervalsCoverage,
  coveragePercent,
  pointsToIntervals,
  estimateFromPoints,
  classifyChange,
  stableChangeFingerprint,
  normalizeRanges,
  parseRangeStrings,
  rangesPercentExclusive,
};

