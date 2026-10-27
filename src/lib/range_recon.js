/**
 * range_recon.js — Reconstruction de plages EXACTES des rollouts user (v15).
 *
 * Pure math — no I/O, no tokens, no network.
 *
 * MODÈLE
 *  - Les positions hash_result renvoyées par l'API /experiments sont la
 *    position du fingerprint dans l'espace de rollout [0, SCALE) : tirage
 *    uniforme (le murmur3 d'un fingerprint aléatoire est uniforme).
 *  - Un rollout user est une partition de [0, SCALE) en plages [start, end)
 *    assignées à des buckets. Sur les rollouts user réels de Discord, toutes
 *    les bornes observées publiquement sont des multiples de GRID (25) →
 *    on « snappe » chaque frontière sur la grille et on calcule la
 *    confiance du snap.
 *  - Entre deux échantillons adjacents de labels différents (bucket A à
 *    gauche, bucket B à droite), la frontière est inconnue dans (x, y].
 *    Si le segment (x, t) appartient à A, aucun échantillon de A ne doit y
 *    être tombé → facteur exp(−λA·(t−x)) ; symétriquement exp(−λB·(y−t))
 *    pour [t, y). λLabel = densité d'échantillons du label par unité de
 *    position (k / couverture estimée). λ = 0 ⇒ côté non observable
 *    (ex. non-enrôlé sans positions « outside »).
 *  - Posterior par candidat de la grille = masse de la région de Voronoï
 *    du candidat ∩ (x, y] sous cette densité (log-space, stable).
 *
 * SORTIE
 *  - quality : 'exact' (toutes frontières snappées avec confiance ≥ minConf
 *    ET % par plages cohérents avec k/n), 'likely' (≥ 0.5), 'indicative'
 *    (à ne présenter que comme ordre de grandeur), 'insufficient'.
 *  - Le % calculé depuis les plages reconstruites est EXACT au sens du
 *    rollout (borne=25 → 2 décimales fiables) quand quality = 'exact'.
 *
 * LIMITES CONNUES (honnêtes)
 *  - Sans positions « outside » (mode fallback, sans vérification du
 *    fingerprint), deux plages d'un même bucket séparées par une zone non
 *    enrôlée sont fusionnées : la structure fine est invisible. La marge
 *    de cohérence k/n fait alors retomber quality à 'indicative' — le k/n
 *    reste la mesure publiée.
 *  - Une vraie frontière hors grille (non multiple de GRID) sera snappée
 *    au point de grille le plus vraisemblable : la confiance reflète la
 *    masse perdue, mais sur une frontière de BORD l'erreur reste possible.
 *    Les bornes de rollout de Discord étant alignées sur la grille en
 *    pratique, GRID est configurable (0 = pas de snap).
 */

const DEFAULT_SCALE = 10000;
const DEFAULT_GRID = 25;

/** log f(t) avec f(t) = exp(−λL(t−x) − λR(y−t)). */
function logfAt(t, x, y, lamL, lamR) {
  return (lamR - lamL) * t + (lamL * x - lamR * y);
}

/** log ∫_a^b f(t) dt — stable même pour de grands écarts de λ (log-space). */
function logMassRegion(a, b, x, y, lamL, lamR) {
  if (b <= a) return -Infinity;
  const k = lamR - lamL;
  const u = k * (b - a);
  const la = logfAt(a, x, y, lamL, lamR);
  if (Math.abs(u) < 1e-9) return la + Math.log(b - a);
  if (k > 0) {
    const lb = logfAt(b, x, y, lamL, lamR);
    return lb - Math.log(k) + Math.log1p(-Math.exp(-u));
  }
  return la - Math.log(-k) + Math.log1p(-Math.exp(u));
}

function logSumExp(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  if (!isFinite(m)) return -Infinity;
  let s = 0;
  for (const v of arr) s += Math.exp(v - m);
  return m + Math.log(s);
}

/**
 * Posterior d'une frontière dans (x, y] + snap sur la grille.
 * @returns {{snapped:number|null, confidence:number, lo:number, hi:number}}
 */
function snapFrontier(x, y, lamL, lamR, grid = DEFAULT_GRID, scale = DEFAULT_SCALE) {
  const lo = Math.floor(x) + 1; // la frontière est un entier > x
  const hi = Math.ceil(y); // et ≤ y
  if (hi < lo) return null;
  const g = Math.max(1, Number(grid) || 1);
  const first = Math.ceil(lo / g) * g;
  const cands = [];
  for (let c = first; c <= hi; c += g) cands.push(c);
  const weights = [];
  for (const c of cands) {
    const a = Math.max(x, c - g / 2);
    const b = Math.min(y, c + g / 2);
    weights.push(logMassRegion(a, b, x, y, lamL, lamR));
  }
  if (!cands.length) return { snapped: null, confidence: 0, lo, hi };
  const total = logSumExp(weights);
  let bestI = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[bestI]) bestI = i;
  return {
    snapped: cands[bestI],
    confidence: Math.exp(weights[bestI] - total),
    lo,
    hi,
  };
}

/**
 * Reconstruit les plages d'un rollout depuis ses échantillons.
 *
 * @param {{p:number, b:number|null}[]} samples — positions observées ;
 *   b = bucket assigné, null = position non enrôlée (observable seulement
 *   en mode fingerprint vérifié).
 * @param {object} [opts]
 * @param {number} [opts.scale=10000]
 * @param {number} [opts.grid=25] — grille des bornes Discord (0 = pas de snap)
 * @param {number} [opts.minConf=0.9] — confiance minimale pour 'exact'
 * @param {number} [opts.tolerance=3] — écart max (points de %) entre % des
 *   plages et k/n avant de dégrader la qualité (à caler sur la marge de
 *   bruit binomial de la fenêtre)
 * @param {Object<string, number>} [opts.knPct] — % k/n par bucket
 *   (+ clé 'null' pour la part non enrôlée) : sert à estimer les densités
 *   et la cohérence
 * @returns {{quality:string, rangesByBucket:Object<string, number[][]>,
 *   pctByBucket:Object<string, number>, boundaries:Array, n:number,
 *   minConfidence:number}}
 */
function reconstructRanges(samples, opts = {}) {
  const scale = Number(opts.scale) || DEFAULT_SCALE;
  const gridOpt = Number(opts.grid);
  // absent → 25 ; 0 → 1 (pas de snap) ; sinon la valeur donnée.
  const useGrid = !Number.isFinite(gridOpt) ? DEFAULT_GRID : Math.max(1, gridOpt);
  const minConf = Number(opts.minConf) || 0.9;
  const tol = Number(opts.tolerance) || 3;

  const pts = (samples || [])
    .map((s) => ({ p: Number(s.p), b: s.b == null ? null : Number(s.b) }))
    .filter((s) => Number.isFinite(s.p) && s.p >= 0 && s.p < scale)
    .sort((a, b) => a.p - b.p);
  const n = pts.length;
  if (!n) {
    return { quality: 'insufficient', rangesByBucket: {}, pctByBucket: {}, boundaries: [], n: 0, minConfidence: 0 };
  }

  // Densité par label : k / couverture estimée (k/n si fourni).
  const counts = new Map();
  for (const s of pts) counts.set(s.b, (counts.get(s.b) || 0) + 1);
  const lamFor = (label) => {
    const k = counts.get(label) || 0;
    if (k === 0) return 0;
    const kn = opts.knPct
      ? Number(label == null ? opts.knPct.null : opts.knPct[String(label)])
      : NaN;
    const cov = Number.isFinite(kn) && kn > 0 ? (scale * kn) / 100 : scale / Math.max(1, counts.size);
    return k / Math.max(cov, 25);
  };

  // Frontières intérieures : paires adjacentes de labels différents.
  const frontiers = [];
  for (let i = 1; i < n; i++) {
    if (pts[i - 1].b !== pts[i].b) {
      frontiers.push({ x: pts[i - 1].p, y: pts[i].p, l: pts[i - 1].b, r: pts[i].b });
    }
  }
  // Frontières de bord : [0, premier échantillon] et [dernier, scale].
  const edges = [];
  if (pts[0].p > 0) edges.push({ x: -1, y: pts[0].p, l: null, r: pts[0].b });
  if (pts[n - 1].p < scale - 1) edges.push({ x: pts[n - 1].p, y: scale, l: pts[n - 1].b, r: null });

  const boundaries = [];
  for (const f of frontiers) {
    const s = snapFrontier(f.x, f.y, lamFor(f.l), lamFor(f.r), useGrid, scale);
    if (s) boundaries.push({ ...f, ...s, edge: false });
  }
  for (const e of edges) {
    const lamL = e.l == null ? 0 : lamFor(e.l);
    const lamR = e.r == null ? 0 : lamFor(e.r);
    const s = snapFrontier(Math.max(e.x, -1), e.y, lamL, lamR, useGrid, scale);
    if (s) boundaries.push({ ...e, ...s, edge: true });
  }
  const snapped = boundaries.filter((b) => b.snapped != null).sort((a, b) => a.snapped - b.snapped);

  // Segments entre bornes → plages par bucket (fusion des segments adjacents).
  const cuts = [...new Set([0, ...snapped.map((b) => b.snapped).filter((c) => c > 0 && c < scale), scale])].sort(
    (a, b) => a - b,
  );
  const labelOf = (a, b) => {
    const c = new Map();
    for (const s of pts) if (s.p >= a && s.p < b) c.set(s.b, (c.get(s.b) || 0) + 1);
    if (!c.size) return null;
    return [...c.entries()].sort((x, y) => y[1] - x[1])[0][0];
  };
  const rangesByBucket = new Map();
  for (let i = 0; i < cuts.length - 1; i++) {
    const lab = labelOf(cuts[i], cuts[i + 1]);
    if (lab == null) continue;
    if (!rangesByBucket.has(lab)) rangesByBucket.set(lab, []);
    const arr = rangesByBucket.get(lab);
    const last = arr[arr.length - 1];
    if (last && last[1] === cuts[i]) last[1] = cuts[i + 1];
    else arr.push([cuts[i], cuts[i + 1]]);
  }
  const pctByBucket = {};
  for (const [lab, rs] of rangesByBucket) {
    pctByBucket[lab] = Math.round((rs.reduce((s, [a, b]) => s + (b - a), 0) / scale) * 10000) / 100;
  }

  // Cohérence avec k/n : des plages qui contredisent la mesure binomiale ne
  // sont JAMAIS présentées comme exactes.
  let consistent = true;
  if (opts.knPct) {
    for (const [kS, kn] of Object.entries(opts.knPct)) {
      if (kS === 'null') continue;
      const lab = Number(kS);
      if ((counts.get(lab) || 0) === 0) continue;
      const rp = pctByBucket[lab];
      if (rp == null) continue;
      if (Math.abs(rp - Number(kn)) > Math.max(tol, 1)) consistent = false;
    }
  }

  let minC = 1;
  for (const b of snapped) minC = Math.min(minC, b.confidence);
  const quality = boundaries.some((b) => b.snapped == null)
    ? 'indicative'
    : !consistent || minC < 0.5
      ? 'indicative'
      : minC >= minConf
        ? 'exact'
        : 'likely';

  return {
    quality,
    rangesByBucket: Object.fromEntries([...rangesByBucket].map(([k, v]) => [String(k), v])),
    pctByBucket: Object.fromEntries(Object.entries(pctByBucket).map(([k, v]) => [String(k), v])),
    boundaries: snapped.map((b) => ({
      lo: b.lo,
      hi: b.hi,
      snapped: b.snapped,
      confidence: Math.round(b.confidence * 1000) / 1000,
      edge: b.edge,
    })),
    n,
    minConfidence: Math.round(minC * 1000) / 1000,
  };
}

/** [[0,1500],[3000,4000]] → "0 - 1500 + 3000 - 4000" (format gist-like). */
function rangesToStrings(ranges) {
  return (ranges || []).map(([a, b]) => a + ' - ' + b).join(' + ');
}

module.exports = {
  DEFAULT_SCALE,
  DEFAULT_GRID,
  snapFrontier,
  reconstructRanges,
  rangesToStrings,
};
