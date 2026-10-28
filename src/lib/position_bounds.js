/**
 * Bornes d'un rollout à partir de positions observées.
 *
 * Principe (wire documenté) : la position d'un fingerprint dans une expérience est
 * murmur3("nom:idFingerprint") % 10000. Chaque réponse /experiments donne donc, pour un
 * nom connu, un point EXACT « dedans » (présente dans les assignments) ou « dehors »
 * (absente). On cumule ces faits dans une carte des 10 000 positions possibles
 * ('.' inconnu, 'I' dedans, 'O' dehors) : taille bornée, mergeable entre runs, et la
 * précision ne dépend plus d'un échantillon unique : plus la carte se remplit, plus les
 * bornes se resserrent vers le pourcentage réel.
 *
 * Établi sans hypothèse : minPct (positions connues dedans) et les contradictions avec
 * une couverture annoncée. Borne max / estimation : supposent qu'entre deux points
 * connus de même statut il n'y a pas d'alternance non observée (plages contiguës).
 * Population = requêtes anonymes du collecteur, pas un recensement des utilisateurs.
 */
'use strict';

const SPACE = 10000;
const UNKNOWN = '.';
const IN = 'I';
const OUT = 'O';

const emptyState = (revision = null) => ({ revision, map: UNKNOWN.repeat(SPACE), conflicts: 0, points: 0 });

const validPosition = (p) => Number.isInteger(p) && p >= 0 && p < SPACE;

const validMap = (m) => typeof m === 'string' && m.length === SPACE && /^[.IO]+$/.test(m);

/** État sain (désérialisé d'un fichier éventuellement corrompu), sinon état vide. */
function normalize(state) {
  if (!state || typeof state !== 'object' || !validMap(state.map)) return emptyState(state && state.revision != null ? state.revision : null);
  return { revision: state.revision ?? null, map: state.map,
    conflicts: Number.isSafeInteger(state.conflicts) && state.conflicts >= 0 ? state.conflicts : 0,
    points: Number.isSafeInteger(state.points) && state.points >= 0 ? state.points : 0 };
}

/**
 * Ajoute un point (mute et retourne l'état). Une position déjà connue avec le statut
 * inverse est comptée dans `conflicts` et ne change pas la carte : configuration changée
 * sans changement de révision, ou source incohérente.
 */
function addPoint(state, position, isIn) {
  if (!validPosition(position) || typeof isIn !== 'boolean') return state;
  const want = isIn ? IN : OUT;
  const cur = state.map[position];
  state.points++;
  if (cur === UNKNOWN) state.map = state.map.slice(0, position) + want + state.map.slice(position + 1);
  else if (cur !== want) state.conflicts++;
  return state;
}

/** Positions connues, avec statut, triées (dérivées de la carte). */
function knownPoints(state) {
  const out = [];
  const m = state && validMap(state.map) ? state.map : '';
  for (let i = 0; i < m.length; i++) if (m[i] !== UNKNOWN) out.push([i, m[i] === IN]);
  return out;
}

/** Runs de points connus consécutifs de même statut (les positions inconnues n'interrompent pas un run). */
function runsOf(state) {
  const runs = [];
  for (const [p, isIn] of knownPoints(state)) {
    const last = runs[runs.length - 1];
    if (last && last.in === isIn) { last.hi = p; last.n++; } else runs.push({ in: isIn, lo: p, hi: p, n: 1 });
  }
  return runs;
}

/**
 * Bornes sur la part de l'espace couverte (hypothèse de contiguïté : pas d'alternance
 * non observée entre deux points connus de même statut) :
 *  - minPct : étendue de chaque run de points « dedans » ;
 *  - maxPct : étendu jusqu'aux points « dehors » voisins (exclus) ;
 *  - estPct : milieu de chaque frontière incertaine ;
 *  - widthPoints : maxPct - minPct ;
 *  - knownInPct : part des seules positions réellement observées dedans (sans hypothèse).
 * Retourne null s'il n'y a aucun point connu ; sans point « dedans », maxPct vaut null (non borné).
 */
function bounds(state) {
  const runs = runsOf(state);
  if (!runs.length) return null;
  let min = 0; let max = 0; let est = 0;
  runs.forEach((r, i) => {
    if (!r.in) return;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    const loMax = prev ? prev.hi + 1 : 0;
    const hiMax = next ? next.lo - 1 : SPACE - 1;
    max += hiMax - loMax + 1;
    min += r.hi - r.lo + 1;
    // Frontière réelle dans [dernier dehors + 1 ; premier dedans] (resp. [dernier dedans + 1 ; premier dehors]).
    const loEst = prev ? (prev.hi + 1 + r.lo) / 2 : 0;
    const hiEst = next ? (r.hi + 1 + next.lo) / 2 : SPACE;
    est += hiEst - loEst;
  });
  const pts = knownPoints(state);
  const inKnown = pts.filter((p) => p[1]).length;
  const round = (v) => Math.round(v) / 100;
  if (!inKnown) {
    // Aucun « dedans » connu : rien ne borne le haut (absence de preuve ≠ 0 %).
    return { minPct: 0, maxPct: null, estPct: null, knownInPct: 0, widthPoints: null,
      knownPositions: pts.length, inPositions: 0, outPositions: pts.length, runs: runs.length,
      points: state.points, conflicts: state.conflicts || 0 };
  }
  return { minPct: round(min), maxPct: round(max), estPct: round(est), widthPoints: round(max - min), knownInPct: round(inKnown),
    knownPositions: pts.length, inPositions: inKnown, outPositions: pts.length - inKnown, runs: runs.length,
    points: state.points, conflicts: state.conflicts || 0 };
}

/** Plages gist [a,b[ (union) → liste triée fusionnée. */
function unionRanges(ranges) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
    .map(([a, b]) => [Math.max(0, a), Math.min(SPACE, b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

const inUnion = (union, p) => union.some(([a, b]) => p >= a && p < b);

/**
 * Accord position par position entre la carte observée et les plages du gist (rôle
 * traitement). Chaque position connue est soit cohérente, soit contradictoire avec la
 * couverture annoncée. Constate seulement : n'établit pas la cause (filtres, révision,
 * gist périmé, population).
 */
function agreement(state, gistTreatmentRanges) {
  const union = unionRanges(gistTreatmentRanges);
  let consistent = 0; let contradicting = 0;
  const examples = [];
  for (const [p, isIn] of knownPoints(state)) {
    if (inUnion(union, p) === isIn) consistent++;
    else { contradicting++; if (examples.length < 3) examples.push([p, isIn]); }
  }
  const gistPct = union.reduce((s, [a, b]) => s + (b - a), 0) / 100;
  return { consistentPositions: consistent, contradictingPositions: contradicting, gistPct, examples };
}

module.exports = { SPACE, emptyState, normalize, addPoint, knownPoints, runsOf, bounds, unionRanges, agreement };
