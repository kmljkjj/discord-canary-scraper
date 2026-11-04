'use strict';
/**
 * Rapprochement gist ↔ mesure API (« wire »), fonctions PURES.
 *
 * Deux systèmes calculent un pourcentage user : le gist (couverture exacte des
 * buckets, à 0,01 pt) et l'échantillonnage de l'API Discord (estimation k/n).
 * Pour qu'ils n'annoncent pas deux chiffres différents :
 *   - une expérience COUVERTE par le gist est annoncée par le gist seul, avec la
 *     mesure API attachée à l'embed (cohérent / écart) ;
 *   - l'échantillonnage continue d'annoncer ce que le gist ne couvre pas.
 * Jamais de fusion en un chiffre : on montre les deux, on ne remplace pas l'un par l'autre.
 */
const { murmur3 } = require('./murmur3');

const MIN_WIRE_N = 300;
const MIN_TOLERANCE = 0.5; // points

/** Map hash → { id, pct } des expériences dont le gist donne un total exact. */
function gistCoverageByHash(docs) {
  const out = new Map();
  for (const e of (docs && Array.isArray(docs.experiments) ? docs.experiments : [])) {
    if (!e || typeof e.id !== 'string' || !e.hasData || !e.totalsAvailable || e.ambiguous || e.projected) continue;
    if (!Number.isFinite(e.treatmentPct)) continue;
    out.set(murmur3(e.id), { id: e.id, pct: e.treatmentPct });
  }
  return out;
}

/** Map hash → mesure API { pct, sigma, n, status } (treatments sommés ; ignore les mesures dégradées). */
function wireByHash(userRollouts) {
  const out = new Map();
  for (const e of (userRollouts && Array.isArray(userRollouts.experiments) ? userRollouts.experiments : [])) {
    if (!e || !Number.isInteger(e.hash)) continue;
    if (e.status !== 'exact' && e.status !== 'estimated') continue;
    const n = Number(e.windowN);
    if (!(n >= MIN_WIRE_N)) continue;
    const ts = Array.isArray(e.treatments) ? e.treatments : [];
    if (!ts.length || ts.some((t) => !t || !t.pctKnown || !Number.isFinite(t.pct))) continue;
    const pct = Math.round(ts.reduce((s, t) => s + t.pct, 0) * 100) / 100;
    const sigma = ts.reduce((s, t) => s + (Number(t.ci && t.ci.sigma) || 0), 0);
    out.set(e.hash, { pct, sigma, n, status: e.status });
  }
  return out;
}

/** Cohérence gist ↔ mesure : tolérance = max(0,5 pt, 3σ). */
function compareGistWire(gistPct, wire) {
  if (!wire || !Number.isFinite(gistPct)) return null;
  const tolerance = Math.max(MIN_TOLERANCE, 3 * (wire.sigma || 0));
  const delta = Math.round((wire.pct - gistPct) * 100) / 100;
  return { delta, tolerance: Math.round(tolerance * 100) / 100, verdict: Math.abs(delta) <= tolerance ? 'consistent' : 'gap' };
}

/** Ligne d'embed (français) décrivant la mesure API face au gist. */
function wireField(gistPct, wire) {
  const c = compareGistWire(gistPct, wire);
  if (!c) return null;
  const f = (v) => Number(v).toFixed(2).replace('.', ',') + ' %';
  const head = `${f(wire.pct)} sur n=${wire.n} (fenêtre ~4 h${wire.sigma ? ', σ ' + Number(wire.sigma).toFixed(2).replace('.', ',') + ' pt' : ', mesure exacte'})`;
  const tail = c.verdict === 'consistent'
    ? 'cohérent avec le gist'
    : `ÉCART avec le gist (${c.delta > 0 ? '+' : ''}${c.delta.toFixed(2).replace('.', ',')} pt, tolérance ±${c.tolerance.toFixed(2).replace('.', ',')}) : gist non vérifié, mesure à confirmer`;
  return { name: 'Mesure API Discord', value: `${head}\n${tail}`, inline: false };
}

module.exports = { gistCoverageByHash, wireByHash, compareGistWire, wireField, MIN_WIRE_N, MIN_TOLERANCE };
