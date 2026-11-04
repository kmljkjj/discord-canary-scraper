'use strict';
/**
 * Sources du gist d'agnonotdev — UNE seule définition pour tout le dépôt.
 *
 * Constat (28/10/2026) : le gist « rollouts.json » (fb2b6a7…) est la source vivante
 * (celle que lisent Petto et les autres bots) ; la copie réduite « rollouts-tag.json »
 * 192b2ce… la suit à l'identique (0 écart de plage), alors que l'ancienne copie
 * e3e9906… prenait des heures de retard (jusqu'à ~6 h) et affichait des pourcentages
 * périmés (ex. soundboard-mute-indicator 1 % au lieu de 10 %).
 * Canonique = gist complet ; miroir = copie réduite (comparaison + repli explicite).
 */
const CANONICAL_ID = 'fb2b6a7ba1301733aa5c2050b3e59a18';
const MIRROR_ID = '192b2ce20539ce1021b5c8cb01b17ff0';
/** Ancienne copie, périmée : gardée seulement pour la migration d'état. */
const LEGACY_IDS = ['e3e99062983e6bd0feaef833f14fd931'];
const DEFAULT_GIST_IDS = [CANONICAL_ID, MIRROR_ID];
const RAW_FALLBACK_OWNERS = Object.fromEntries(
  [CANONICAL_ID, MIRROR_ID, ...LEGACY_IDS].map((id) => [id, 'agnonotdev']),
);

/** Premier id de GIST_ROLLOUT_GIST_IDS (env) ou le canonique. */
function canonicalId(env = process.env) {
  const first = String(env.GIST_ROLLOUT_GIST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first || CANONICAL_ID;
}

/**
 * Ramène une entrée du gist COMPLET (rollouts.json : from/to/change, variantes sans
 * plages…) à la forme de la copie réduite que le calcul attend : id, titre, kind,
 * variantes {variant, role, ranges} dont les plages sont non vides (la copie réduite
 * écarte les autres : mêmes entrées, mêmes totaux — vérifié sur 1007 expériences).
 * Idempotent sur la copie réduite. Entrées non-objet laissées telles quelles
 * (la validation les rejette).
 */
function normalizeGistEntries(data) {
  if (!Array.isArray(data)) return data;
  return data.map((e) => {
    if (!e || typeof e !== 'object' || !Array.isArray(e.variants)) return e;
    const out = { id: e.id };
    if (typeof e.title === 'string') out.title = e.title;
    if (typeof e.kind === 'string') out.kind = e.kind;
    out.variants = e.variants
      .filter((v) => !v || typeof v !== 'object' || Array.isArray(v) || (v.ranges !== undefined && !(Array.isArray(v.ranges) && v.ranges.length === 0)))
      .map((v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
        const o = { variant: v.variant };
        if (v.role !== undefined) o.role = v.role;
        o.ranges = v.ranges;
        return o;
      });
    return out;
  });
}

module.exports = { normalizeGistEntries, CANONICAL_ID, MIRROR_ID, LEGACY_IDS, DEFAULT_GIST_IDS, RAW_FALLBACK_OWNERS, canonicalId };
