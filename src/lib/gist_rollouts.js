/**
 * Bibliothèque pure : lecture + calcul des couvertures de rollouts depuis le
 * gist communautaire d'agnonotdev (copie réduite de rollouts.json, tag Assyst).
 *
 * Modèle de données du gist :
 *   [{ id, variants: [{ variant, role, ranges: ["lo - hi", ...] }] }]
 *   - role : "control" | "treatment" | "not_eligible"
 *   - ranges : plages entières sur l'espace de hash 0-10000 (échelle en
 *     dix-millièmes : 10000 = 100 %).
 *
 * SÉMANTIQUE DES POURCENTAGES (importante, à ne pas déformer) :
 *   - Les plages décrivent la COUVERTURE DE L'ESPACE DE BUCKETS selon la
 *     source communautaire — PAS une mesure de la proportion de vrais
 *     utilisateurs ayant accès à une fonctionnalité (l'assignation réelle
 *     dépend du hash de l'identifiant, des filtres de population et des
 *     conditions d'éligibilité que ce fichier réduit ne contient pas).
 *   - Bornes supposées semi-ouvertes [lo, hi) : "0 - 10000" = espace complet,
 *     "250 - 500" = 250 positions = 2,50 %. Résolution : 0,01 point.
 *   - Les longueurs sont conservées en ENTIERS ; on n'arrondit qu'à
 *     l'affichage. Mêmes plages + même définition = mêmes chiffres que
 *     n'importe quel lecteur honnête de cette source : l'amélioration
 *     défendable est l'interprétation, le détail et la fiabilité, pas des
 *     pourcentages « différents ».
 *   - Le complément est appelé « espace non décrit par les plages », pas
 *     « utilisateurs non assignés » (indémontrable avec ce fichier).
 *
 * Cas ambigus détectés et signalés (jamais lissés) — les TOTAUX globaux
 * deviennent alors INDISPONIBLES (null), seules les couvertures par entrée
 * restent affichées :
 *   - variantes répétées (même numéro en plusieurs entrées) → plusieurs
 *     populations aplaties par le format réduit ;
 *   - chevauchement de plages au sein d'une entrée OU ENTRE VARIANTES ;
 *   - somme des couvertures > 10000 (multi-population) ;
 *   - plages illisibles (invalides) dans une entrée → données dégradées ;
 *   - variants: [] → « aucune donnée exploitable » (PAS un 0 %, ni une
 *     disparition : pct null, pas 0).
 */
'use strict';

const crypto = require('crypto');

const SCALE = 10000; // positions entières : 1 position = 0,01 %

/**
 * "150 - 3000" -> { lo: 150, hi: 3000 } | null (invalide).
 * Bornes entières, 0 <= lo < hi <= SCALE.
 */
function parseRange(rangeStr) {
  if (typeof rangeStr !== 'string') return null;
  const m = rangeStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  if (lo < 0 || hi > SCALE || hi <= lo) return null;
  return { lo, hi };
}

/**
 * Union d'intervalles : longueur dédupliquée + présence de chevauchements.
 * Retourne { length, hasOverlap, merged } avec merged trié (pour l'affichage).
 */
function unionIntervals(intervals) {
  const valid = (intervals || []).filter((i) => i && Number.isInteger(i.lo) && Number.isInteger(i.hi));
  if (!valid.length) return { length: 0, hasOverlap: false, merged: [] };
  const sorted = valid.slice().sort((a, b) => a.lo - b.lo);
  const merged = [];
  let hasOverlap = false;
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.lo < last.hi) {
      hasOverlap = true;
      if (iv.hi > last.hi) last.hi = iv.hi;
    } else {
      merged.push({ lo: iv.lo, hi: iv.hi });
    }
  }
  const length = merged.reduce((s, iv) => s + (iv.hi - iv.lo), 0);
  return { length, hasOverlap, merged };
}

/** pct affichable à 2 décimales depuis un nombre de positions entières. */
function positionsToPct(positions) {
  const n = Math.max(0, Math.min(SCALE, Math.round(Number(positions) || 0)));
  return Math.round((n / SCALE) * 100 * 100) / 100;
}

/**
 * Calcule la couverture d'UNE entrée de variante (une « population »).
 * entry = { variant, role, ranges: [...] }
 * Retourne { variant, role, positions, pct, ranges, hasOverlap, invalidRanges } | null.
 */
function computeVariantEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawRanges = Array.isArray(entry.ranges) ? entry.ranges : [];
  const intervals = rawRanges.map(parseRange);
  const invalidRanges = intervals.filter((iv) => !iv).length;
  const valid = intervals.filter(Boolean);
  if (!rawRanges.length) return null;
  if (!valid.length) return null; // entrée illisible → non comptée
  const { length, hasOverlap, merged } = unionIntervals(valid);
  const variant = entry.variant == null ? null : Number(entry.variant);
  return {
    variant: Number.isFinite(variant) ? variant : null,
    role: String(entry.role || 'unknown'),
    positions: length,
    pct: positionsToPct(length),
    ranges: merged.map((iv) => [iv.lo, iv.hi]),
    hasOverlap,
    invalidRanges,
  };
}

/**
 * Calcule la couverture d'une expérience complète.
 * exp = { id, variants: [...] } (format gist)
 *
 * Retourne :
 *  {
 *    id, hasData, ambiguous, flags: [],
 *    variants: [computeVariantEntry...],     // une entrée par « population »
 *    byVariant: { <numéro|'null'>: { pct, role } },
 *    sig,                                     // signature variantes (numéros+rôles)
 *    key,                                     // hash court des plages (état léger)
 *    structuralKey,                           // plages lisibles (debug)
 *    treatment/control/notEligible: { positions, pct } | null,
 *    assigned/unassigned: { positions, pct } | null,
 *    totalsAvailable: bool                    // false si ambigu
 *  }
 *
 * Règles :
 *  - variants: [] → hasData: false (« aucune donnée exploitable »), pct null.
 *  - numéro de variante répété → ambiguous, chaque entrée gardée séparée.
 *  - chevauchement ENTRE variantes (union globale < somme des unions) →
 *    ambiguous : les totaux globaux sont INDISPONIBLES (null), seules les
 *    couvertures par entrée restent.
 *  - plages illisibles → flag 'invalid_ranges', ambiguous.
 *  - les rôles inconnus restent dans byVariant mais pas dans les totaux
 *    nommés.
 */
function computeExperiment(exp) {
  const id = String((exp && exp.id) || '').trim();
  const rawVariants = exp && Array.isArray(exp.variants) ? exp.variants : [];
  const variants = rawVariants.map(computeVariantEntry).filter(Boolean);
  const flags = [];
  const invalidRanges = rawVariants
    .map((v) => {
      const rr = Array.isArray(v && v.ranges) ? v.ranges : [];
      return rr.filter((r) => !parseRange(r)).length;
    })
    .reduce((s, n) => s + n, 0);

  if (!variants.length) {
    return {
      id,
      hasData: false,
      ambiguous: Boolean(invalidRanges),
      flags: invalidRanges ? ['no_data', 'invalid_ranges'] : ['no_data'],
      variants: [],
      byVariant: {},
      sig: '',
      key: 'no_data',
      structuralKey: 'no_data',
      treatment: { positions: 0, pct: null },
      control: { positions: 0, pct: null },
      notEligible: { positions: 0, pct: null },
      assigned: { positions: 0, pct: 0 },
      unassigned: { positions: SCALE, pct: null },
      totalsAvailable: false,
      invalidRanges,
    };
  }

  // Variantes répétées (même numéro) → populations multiples aplaties.
  const byNumber = new Map();
  for (const v of variants) {
    const key = v.variant == null ? 'null' : String(v.variant);
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(v);
  }
  if ([...byNumber.values()].some((list) => list.length > 1)) flags.push('repeated_variant');

  const byVariant = {};
  for (const [key, list] of byNumber) {
    const positions = list.reduce((s, v) => s + v.positions, 0);
    byVariant[key] = {
      positions,
      pct: positionsToPct(positions),
      role: list[0].role,
      entries: list.length,
    };
  }

  // Chevauchement ENTRE variantes : union globale < somme des unions locales.
  const allIntervals = variants.flatMap((v) => v.ranges.map(([a, b]) => ({ lo: a, hi: b })));
  const globalUnion = unionIntervals(allIntervals);
  const sumOfUnions = variants.reduce((s, v) => s + v.positions, 0);
  if (globalUnion.length < sumOfUnions) flags.push('overlapping_variants');
  if (variants.some((v) => v.hasOverlap)) flags.push('overlapping_ranges');

  const sum = (role) =>
    variants
      .filter((v) => v.role === role)
      .reduce((s, v) => s + v.positions, 0);
  const treatment = sum('treatment');
  const control = sum('control');
  const notEligible = sum('not_eligible');
  const unknownRole = variants
    .filter((v) => v.role !== 'treatment' && v.role !== 'control' && v.role !== 'not_eligible')
    .reduce((s, v) => s + v.positions, 0);
  if (unknownRole > 0) flags.push('unknown_role');

  const assigned = treatment + control + notEligible + unknownRole;
  if (assigned > SCALE) flags.push('multi_population');

  // Plages illisibles : données DÉGRADÉES — les couvertures par entrée
  // restent, mais les totaux globaux sont indisponibles : le complément
  // (« espace non décrit ») ne serait pas connu.
  if (invalidRanges > 0) flags.push('invalid_ranges');

  // Totaux INDISPONIBLES si ambigu OU dégradé : garder uniquement les
  // couvertures par entrée, jamais un agrégat trompeur.
  const ambiguous = flags.length > 0;

  // Fingerprint structurel : plages + rôles, indépendant de l'ordre.
  // key = hash court (état persistant léger) ; structuralKey reste lisible.
  const structuralKey = variants
    .map((v) => `${v.variant}:${v.role}:${v.ranges.map(([a, b]) => a + '-' + b).join(',')}`)
    .sort()
    .join('|');
  const key = crypto.createHash('sha256').update(structuralKey).digest('hex').slice(0, 16);

  // Signature de variantes (numéros + rôles) — stable entre états complets
  // et compacts, sert à distinguer montée/baisse de reconfiguration.
  const sig = [...byNumber.entries()]
    .map(([k, list]) => k + ':' + list[0].role)
    .sort()
    .join('|');

  const mkTotal = (positions) =>
    ambiguous
      ? { positions, pct: null }
      : { positions, pct: positionsToPct(positions) };

  return {
    id,
    hasData: true,
    ambiguous,
    flags,
    variants,
    byVariant,
    sig,
    key,
    structuralKey,
    treatment: mkTotal(treatment),
    control: mkTotal(control),
    notEligible: mkTotal(notEligible),
    assigned: ambiguous ? { positions: assigned, pct: null } : { positions: assigned, pct: positionsToPct(assigned) },
    unassigned: ambiguous
      ? { positions: Math.max(0, SCALE - assigned), pct: null }
      : {
          positions: Math.max(0, SCALE - assigned),
          pct: positionsToPct(Math.max(0, SCALE - assigned)),
        },
    totalsAvailable: !ambiguous,
    invalidRanges,
  };
}

/** Clé structurelle courte (hash) — cohérente entre états complets et compacts. */
function keyOf(entry) {
  return (entry && entry.key) || (entry && entry.structuralKey) || null;
}

/**
 * Diff entre deux états calculés (acknowledged vs courant).
 * Chaque entrée des maps : résultat de computeExperiment (+ type éventuel).
 *
 * Classification :
 *  - 'new' / 'removed' : apparition / disparition AVEC données ;
 *  - 'structured' : reconfiguration (signature de variantes changée :
 *    variante ajoutée/retirée, rôle changé, données qui apparaissent ou
 *    disparaissent) — TOUJOURS notifié ;
 *  - 'changed' : montée/baisse (même signature) — notifié si le delta
 *    CUMULÉ (total ou par variante, au max des deux) dépasse le seuil.
 *
 * Seuil en POINTS sur le % treatment. Les changements non notifiés ne font
 * pas avancer acknowledged → les micro-deltas s'accumulent d'un run à
 * l'autre jusqu'à dépasser le seuil.
 * deltaPct est null quand un total global est indisponible (ambigu) ou
 * qu'une donnée apparaît/disparaît (une absence de données n'est PAS une
 * baisse à zéro).
 */
function diffExperiments(prevById, curById, minDeltaPct = 0.05, curAllIds = null) {
  const changes = [];
  const prevIds = new Set(Object.keys(prevById));
  const curIds = new Set(Object.keys(curById));

  for (const id of curIds) {
    const after = curById[id];
    const before = prevIds.has(id) ? prevById[id] : null;
    if (!before) {
      if (after.hasData) changes.push({ kind: 'new', id, before: null, after });
      continue;
    }
    // Données apparues / disparues : reconfiguration, pas une variation de %.
    if (!before.hasData && after.hasData) {
      changes.push({ kind: 'structured', id, before, after, deltaPct: null });
      continue;
    }
    if (before.hasData && !after.hasData) {
      changes.push({ kind: 'structured', id, before, after, deltaPct: null });
      continue;
    }
    if (!before.hasData && !after.hasData) continue;

    if (keyOf(before) !== keyOf(after)) {
      const structural = before.sig !== after.sig;
      if (structural) {
        changes.push({ kind: 'structured', id, before, after, deltaPct: null });
        continue;
      }
      // Même signature : montée/baisse — seuil sur le pire des deux deltas
      // (total OU par variante : une redistribution à total constant ne doit
      // pas disparaître), mais deltaPct reste le DELTA SIGNÉ du treatment —
      // jamais une amplitude par variante déguisée en delta treatment.
      const delta = pctDelta(before, after);
      const perVariant = maxVariantDelta(before, after);
      if (delta == null && perVariant == null) {
        // Totaux indisponibles (ambigu) : tout changement de plages compte.
        changes.push({ kind: 'changed', id, before, after, deltaPct: null });
        continue;
      }
      const worst = Math.max(Math.abs(delta ?? 0), Math.abs(perVariant ?? 0));
      if (worst >= minDeltaPct) {
        changes.push({ kind: 'changed', id, before, after, deltaPct: delta });
      }
      continue;
    }
    const delta = pctDelta(before, after);
    if (delta != null && Math.abs(delta) >= minDeltaPct) {
      changes.push({ kind: 'changed', id, before, after, deltaPct: delta });
    }
  }

  for (const id of prevIds) {
    if (curIds.has(id)) continue;
    // Toujours au catalogue (juste sortie du périmètre user, ex. expérience
    // reclassée guild) : PAS un retrait du gist — pas de faux « removed ».
    if (curAllIds && curAllIds.has(id)) continue;
    const before = prevById[id];
    if (before && before.hasData) changes.push({ kind: 'removed', id, before, after: null, deltaPct: null });
  }
  return changes;
}

/** Δ treatment en points, null si un total est indisponible. */
function pctDelta(before, after) {
  const a = before && before.treatment && before.treatment.pct;
  const b = after && after.treatment && after.treatment.pct;
  if (a == null || b == null) return null;
  return round2(b - a);
}

/** Max |Δ| par variante en points (redistribution à total constant), null si vide. */
function maxVariantDelta(before, after) {
  const keys = new Set([
    ...Object.keys((before && before.byVariant) || {}),
    ...Object.keys((after && after.byVariant) || {}),
  ]);
  let worst = null;
  for (const k of keys) {
    const a = before && before.byVariant && before.byVariant[k];
    const b = after && after.byVariant && after.byVariant[k];
    const pa = a && a.pct != null ? a.pct : 0;
    const pb = b && b.pct != null ? b.pct : 0;
    const d = Math.abs(round2(pb - pa));
    if (worst == null || d > worst) worst = d;
  }
  return worst;
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/**
 * Politique des miroirs : le gist existe en deux copies (même auteur). On ne
 * les fusionne pas et on ne choisit JAMAIS automatiquement : le PREMIER de
 * la liste est la source canonique. L'autre sert à la COMPARAISON (et de
 * repli explicite si la canonique est injoignable — auquel cas le repli est
 * enregistré dans l'état, jamais silencieux).
 * Retourne { diverged, divergingIds }.
 */
function mirrorStatus(primaryData, mirrorData) {
  const norm = (data) =>
    JSON.stringify(
      [...(Array.isArray(data) ? data : [])]
        .map((e) => [e && e.id, e && e.variants])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  if (norm(primaryData) === norm(mirrorData)) {
    return { diverged: false, divergingIds: [] };
  }
  const divergingIds = [];
  const pm = new Map((Array.isArray(primaryData) ? primaryData : []).map((e) => [e.id, e]));
  const mm = new Map((Array.isArray(mirrorData) ? mirrorData : []).map((e) => [e.id, e]));
  for (const id of new Set([...pm.keys(), ...mm.keys()])) {
    if (JSON.stringify(pm.get(id)) !== JSON.stringify(mm.get(id))) divergingIds.push(id);
  }
  return { diverged: true, divergingIds };
}

/**
 * Validation du fichier gist AVANT tout calcul/diff (un tableau invalide ne
 * doit jamais ressembler à une suppression massive d'expériences) :
 *  - tableau non vide (et pas microscopique) ;
 *  - ids uniques, non vides ;
 *  - entrées : objet avec `variants` tableau (ou absent → no_data) ;
 *  - au moins la majorité des entrées exploitables.
 * Retourne { ok: true, stats } ou { ok: false, error }.
 */
function validateGistData(data, opts = {}) {
  const minEntries = Number.isFinite(opts.minEntries) ? opts.minEntries : 100;
  if (!Array.isArray(data)) return { ok: false, error: 'JSON non tableau' };
  if (!data.length) return { ok: false, error: 'gist vide' };
  if (data.length < minEntries) return { ok: false, error: 'gist anormalement petit (' + data.length + ')' };
  const ids = new Set();
  let invalid = 0;
  let duplicates = 0;
  let withVariants = 0;
  for (const e of data) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id.trim()) {
      invalid += 1;
      continue;
    }
    if (ids.has(e.id)) {
      duplicates += 1;
      continue;
    }
    ids.add(e.id);
    if (e.variants != null && !Array.isArray(e.variants)) {
      invalid += 1;
      continue;
    }
    // Structure des entrées de variantes : objet + `ranges` tableau (le
    // format du gist est « ids, roles and ranges only »). `variants: []`
    // reste une absence de données légitime ; une entrée de variante
    // invalide (null, non-objet, ranges absent/non tableau) est un défaut
    // STRUCTUREL : rejet du fichier, pas un « no_data » silencieux qui
    // deviendrait une fausse reconfiguration au diff.
    if (Array.isArray(e.variants)) {
      let badVariant = false;
      for (const v of e.variants) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.ranges)) {
          badVariant = true;
          break;
        }
      }
      if (badVariant) {
        invalid += 1;
        continue;
      }
      if (e.variants.length) withVariants += 1;
    }
  }
  // Strict : UN SEUL doublon ou UNE SEULE entrée structurellement invalide
  // suffit à rejeter le fichier — un doublon écraserit une entrée des maps
  // (fausse suppression au diff suivant), une entrée sans id ne doit jamais
  // ressembler à la disparition d'une expérience suivie.
  if (invalid > 0) {
    return { ok: false, error: invalid + '/' + data.length + ' entrées structurellement invalides' };
  }
  if (duplicates > 0) {
    return { ok: false, error: duplicates + ' id(s) dupliqué(s)' };
  }
  if (!withVariants) return { ok: false, error: 'aucune entrée avec variantes' };
  return { ok: true, stats: { total: data.length, invalid, duplicates, withVariants } };
}

module.exports = {
  SCALE,
  parseRange,
  unionIntervals,
  positionsToPct,
  computeVariantEntry,
  computeExperiment,
  diffExperiments,
  mirrorStatus,
  validateGistData,
  keyOf,
  round2,
};
