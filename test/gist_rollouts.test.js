/**
 * Tests unitaires — src/lib/gist_rollouts.js + intégration légère de
 * src/gist_user_rollouts.js (calcul, diff, classification, miroirs,
 * validation, livraison partielle). N'écrivent JAMAIS dans data/.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const {
  parseRange,
  unionIntervals,
  positionsToPct,
  computeExperiment,
  diffExperiments,
  mirrorStatus,
  validateGistData,
} = require('../src/lib/gist_rollouts');

// ─── parseRange ─────────────────────────────────────────────────────────────

test('parseRange : plages valides', () => {
  assert.deepEqual(parseRange('150 - 3000'), { lo: 150, hi: 3000 });
  assert.deepEqual(parseRange('0 - 10000'), { lo: 0, hi: 10000 });
  assert.deepEqual(parseRange('  250-500 '), { lo: 250, hi: 500 });
});

test('parseRange : plages invalides rejetées', () => {
  assert.equal(parseRange('0'), null);
  assert.equal(parseRange('a - b'), null);
  assert.equal(parseRange('-5 - 100'), null);
  assert.equal(parseRange('0 - 10001'), null);
  assert.equal(parseRange('500 - 500'), null); // vide en semi-ouvert
  assert.equal(parseRange('600 - 500'), null);
  assert.equal(parseRange(null), null);
  assert.equal(parseRange('0 - 500 , 600 - 800'), null);
});

// ─── unionIntervals ─────────────────────────────────────────────────────────

test('unionIntervals : disjointes → somme', () => {
  const r = unionIntervals([{ lo: 0, hi: 250 }, { lo: 500, hi: 750 }]);
  assert.equal(r.length, 500);
  assert.equal(r.hasOverlap, false);
  assert.deepEqual(r.merged, [{ lo: 0, hi: 250 }, { lo: 500, hi: 750 }]);
});

test('unionIntervals : chevauchement → union + flag', () => {
  const r = unionIntervals([{ lo: 0, hi: 500 }, { lo: 250, hi: 750 }]);
  assert.equal(r.length, 750);
  assert.equal(r.hasOverlap, true);
});

test('unionIntervals : doublons exacts dédupliqués', () => {
  const r = unionIntervals([{ lo: 0, hi: 1000 }, { lo: 0, hi: 1000 }]);
  assert.equal(r.length, 1000);
  assert.equal(r.hasOverlap, true);
});

test('unionIntervals : vide', () => {
  assert.deepEqual(unionIntervals([]), { length: 0, hasOverlap: false, merged: [] });
});

// Oracle indépendant : tableau booléen de 10 000 positions. Toute plage
// [lo,hi) marque true les positions lo..hi-1. La couverture "vraie" =
// nombre de true. unionIntervals doit retourner exactement ce compte,
// et hasOverlap doit refléter tout chevauchement réel entre plages.
function oracleCoverage(intervals) {
  const marked = new Array(10000).fill(false);
  let rawSum = 0;
  for (const { lo, hi } of intervals) {
    for (let i = lo; i < hi; i++) marked[i] = true;
    rawSum += hi - lo;
  }
  let covered = 0;
  for (const m of marked) if (m) covered++;
  return { covered, overlap: covered < rawSum };
}

// Générateur déterministe (LCG) — mêmes cas à chaque exécution.
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test('unionIntervals : oracle tableau booléen — cas limites', () => {
  const cases = [
    [[]], // vide
    [[{ lo: 0, hi: 10000 }]], // plein
    [[{ lo: 0, hi: 1 }]], // une position
    [[{ lo: 9999, hi: 10000 }]], // dernière position
    [[{ lo: 0, hi: 500 }, { lo: 500, hi: 1000 }]], // adjacentes (pas de chevauchement)
    [[{ lo: 0, hi: 1000 }, { lo: 0, hi: 1000 }]], // doublon exact
    [[{ lo: 100, hi: 900 }, { lo: 200, hi: 300 }]], // imbriquée
    [[{ lo: 200, hi: 300 }, { lo: 100, hi: 900 }]], // imbriquée, ordre inversé
    [[{ lo: 0, hi: 100 }, { lo: 500, hi: 600 }, { lo: 200, hi: 300 }, { lo: 50, hi: 550 }]], // fragments + chevauchements
    [[{ lo: 3000, hi: 4000 }, { lo: 0, hi: 2000 }, { lo: 6000, hi: 7000 }, { lo: 1500, hi: 3500 }]], // désordonné
  ];
  for (const [intervals] of cases) {
    const want = oracleCoverage(intervals);
    const got = unionIntervals(intervals);
    assert.equal(got.length, want.covered, `couverture ${JSON.stringify(intervals)}`);
    assert.equal(got.hasOverlap, want.overlap, `chevauchement ${JSON.stringify(intervals)}`);
  }
});

test('unionIntervals : oracle tableau booléen — 3000 cas pseudo-aléatoires', () => {
  const rnd = lcg(20261028);
  for (let n = 0; n < 3000; n++) {
    const count = 1 + Math.floor(rnd() * 6); // 1 à 6 plages
    const intervals = [];
    for (let k = 0; k < count; k++) {
      const lo = Math.floor(rnd() * 10000);
      const len = 1 + Math.floor(rnd() * 3000);
      const hi = Math.min(10000, lo + len);
      if (hi > lo) intervals.push({ lo, hi });
    }
    if (!intervals.length) continue;
    const want = oracleCoverage(intervals);
    const got = unionIntervals(intervals);
    assert.equal(got.length, want.covered, `cas #${n} ${JSON.stringify(intervals)}`);
    assert.equal(got.hasOverlap, want.overlap, `overlap #${n}`);
    // Les plages fusionnées doivent rester triées et disjointes.
    for (let i = 1; i < got.merged.length; i++) {
      assert.ok(got.merged[i - 1].hi <= got.merged[i].lo, `trié #${n}`);
    }
  }
});

// ─── positionsToPct ─────────────────────────────────────────────────────────

test('positionsToPct : résolution 0,01 point', () => {
  assert.equal(positionsToPct(10000), 100);
  assert.equal(positionsToPct(2500), 25);
  assert.equal(positionsToPct(1), 0.01);
  assert.equal(positionsToPct(4495), 44.95);
  assert.equal(positionsToPct(0), 0);
  assert.equal(positionsToPct(999999), 100); // capé
  assert.equal(positionsToPct(-5), 0); // capé
});

// ─── computeExperiment ──────────────────────────────────────────────────────

test('computeExperiment : A/B classique 50/50', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 5000'] },
      { variant: 1, role: 'treatment', ranges: ['5000 - 10000'] },
    ],
  });
  assert.equal(c.hasData, true);
  assert.equal(c.ambiguous, false);
  assert.equal(c.treatment.pct, 50);
  assert.equal(c.control.pct, 50);
  assert.equal(c.unassigned.pct, 0);
  assert.equal(c.variants.length, 2);
  assert.equal(c.totalsAvailable, true);
  assert.equal(c.sig, '0:control|1:treatment');
});

test('computeExperiment : plages fragmentées d\'une même variante', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 250', '500 - 750'] },
      { variant: 1, role: 'treatment', ranges: ['250 - 500', '750 - 1000'] },
    ],
  });
  assert.equal(c.treatment.pct, 5); // 250 + 250 = 500 positions
  assert.equal(c.control.pct, 5);
  assert.equal(c.unassigned.pct, 90);
});

test('computeExperiment : variants vide = aucune donnée (PAS 0 %)', () => {
  const c = computeExperiment({ id: 'x', variants: [] });
  assert.equal(c.hasData, false);
  assert.equal(c.ambiguous, false);
  assert.deepEqual(c.flags, ['no_data']);
  assert.equal(c.treatment.pct, null); // pas un 0 : absence de données
  assert.equal(c.unassigned.pct, null);
});

test('computeExperiment : variantes répétées → UNION des populations (formule Discord)', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
      { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
    ],
  });
  assert.equal(c.hasData, true);
  // Deux populations aplaties → agrégation INDÉTERMINÉE : totaux principaux
  // indisponibles, union visible en métrique SECONDAIRE (projectedCoverage,
  // couverture projetée non pondérée — jamais un % exact).
  assert.equal(c.ambiguous, false);
  assert.ok(c.flags.includes('repeated_variant'));
  assert.ok(c.flags.includes('multi_population'));
  assert.equal(c.projected, true);
  assert.equal(c.variants.length, 2); // deux entrées affichées séparément
  assert.equal(c.totalsAvailable, false);
  assert.equal(c.treatment.pct, null); // pas d'agrégat trompeur en valeur principale
  assert.equal(c.projectedCoverage.treatment.pct, 100); // union en secondaire
  assert.equal(c.byVariant['1'].pct, null); // byVariant principal indisponible
  assert.equal(c.projectedCoverage.byVariant['1'].pct, 100); // en secondaire
  assert.equal(c.variants[0].pct, 100); // par entrée : lisible
});

test('computeExperiment : populations chevauchantes → union en métrique secondaire', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'treatment', ranges: ['0 - 6000'] },
      { variant: 1, role: 'treatment', ranges: ['4000 - 10000'] },
    ],
  });
  // agrégation indéterminée → totaux indisponibles, union projetée en secondaire
  assert.equal(c.treatment.pct, null);
  assert.equal(c.totalsAvailable, false);
  assert.equal(c.projectedCoverage.treatment.pct, 100); // union [0,10000) — pas 160 % en somme
  assert.ok(c.flags.includes('repeated_variant'));
  assert.ok(c.flags.includes('overlapping_variants'));
  assert.equal(c.ambiguous, false);
});

test('computeExperiment : multi-populations INDÉTECTABLES — limite documentée', () => {
  // Contre-exemple type : pop A treatment [0,5000) + pop B treatment
  // [5000,10000). Somme = 10000 → AUCUN drapeau multi_population, totaux
  // disponibles à 100 %. Mais ce peut aussi être 2 populations à 50 %
  // chacune — le gist aplatit sans frontières, c'est INDISTINGUABLE d'un
  // single-population légitime. Ce test DOCUMENTE la limite : l'absence du
  // drapeau ne prouve pas une population unique ; les totaux restent des
  // couvertures calculées à partir des plages fournies.
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'treatment', ranges: ['0 - 5000'] },
      { variant: 2, role: 'treatment', ranges: ['5000 - 10000'] },
    ],
  });
  assert.equal(c.totalsAvailable, true);
  assert.equal(c.treatment.pct, 100);
  assert.equal(c.projected, false);
});

test('computeExperiment : conflit de rôles → totaux ET agrégats par variante bloqués', () => {
  // Même variante 1 avec deux rôles : les totaux par rôle sont bloqués et
  // l'agrégat byVariant['1'] ne doit RIEN publier (15 % avec le rôle du
  // premier élément serait trompeur). Les couvertures par entrée restent.
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'control', ranges: ['0 - 1000'] },
      { variant: 1, role: 'treatment', ranges: ['500 - 1500'] },
    ],
  });
  assert.ok(c.flags.includes('role_conflict'));
  assert.equal(c.totalsAvailable, false);
  assert.equal(c.treatment.pct, null);
  assert.equal(c.control.pct, null);
  assert.equal(c.byVariant['1'].pct, null); // agrégat bloqué aussi
  assert.equal(c.projectedCoverage, null); // pas de projection
  assert.equal(c.projected, false);
  // couvertures par entrée conservées :
  assert.equal(c.variants[0].pct, 10);
  assert.equal(c.variants[1].pct, 10);
});

test('computeExperiment : multi-populations + plage invalide → AUCUNE valeur agrégée complète', () => {
  // Deux entrées pleines + une plage invalide : la projection ne doit pas
  // sortir — toute couverture agrégée est incalculable (données dégradées).
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
      { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
      { variant: 1, role: 'treatment', ranges: ['nul'] },
    ],
  });
  assert.ok(c.flags.includes('multi_population'));
  assert.equal(c.ambiguous, true); // plages invalides → dégradé
  assert.equal(c.totalsAvailable, false);
  assert.equal(c.treatment.pct, null);
  assert.equal(c.projected, true); // multi-populations détectées
  assert.equal(c.projectedCoverage, null); // MAIS aucune projection (données dégradées)
  assert.equal(c.byVariant['1'].pct, null);
  // couverture par entrée : les entrées valides restent lisibles
  assert.equal(c.variants[0].pct, 100);
});

test('computeExperiment : chevauchement ENTRE variantes → INFO, unions par rôle', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 1000'] },
      { variant: 1, role: 'treatment', ranges: ['500 - 1500'] },
    ],
  });
  // Populations légitimes chez Discord : chaque rôle est calculé en union
  // (couvertures par entrée conservées, total projeté si multi-populations).
  assert.equal(c.ambiguous, false);
  assert.ok(c.flags.includes('overlapping_variants'));
  assert.equal(c.totalsAvailable, true);
  assert.equal(c.treatment.pct, 10);
  assert.equal(c.control.pct, 10);
  assert.equal(c.unassigned.pct, 85); // union globale [0,1500)
  // couvertures par entrée conservées :
  assert.equal(c.variants[0].pct, 10);
  assert.equal(c.variants[1].pct, 10);
});

test('computeExperiment : not_eligible partiel + espace non décrit', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [{ variant: 'none', role: 'not_eligible', ranges: ['0 - 2000'] }],
  });
  assert.equal(c.notEligible.pct, 20);
  assert.equal(c.unassigned.pct, 80);
  assert.equal(c.ambiguous, false);
});

test('computeExperiment : plages invalides → dégradé, totaux indisponibles, entrées conservées', () => {
  const c = computeExperiment({
    id: 'x',
    variants: [{ variant: 1, role: 'treatment', ranges: ['nul', 42, '0 - 100'] }],
  });
  // couverture par entrée lisible...
  assert.equal(c.variants[0].pct, 1);
  assert.equal(c.invalidRanges, 2);
  assert.ok(c.flags.includes('invalid_ranges'));
  // ...mais les TOTAUX sont indisponibles : le complément (« espace non
  // décrit ») n'est pas connu, on ne doit pas l'afficher comme tel.
  assert.equal(c.ambiguous, true);
  assert.equal(c.treatment.pct, null);
  assert.equal(c.totalsAvailable, false);
  const empty = computeExperiment({
    id: 'y',
    variants: [{ variant: 1, role: 'treatment', ranges: [] }],
  });
  assert.equal(empty.hasData, false);
});

test('computeExperiment : structuralKey indépendant de l\'ordre', () => {
  const a = computeExperiment({
    id: 'x',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 250'] },
      { variant: 1, role: 'treatment', ranges: ['250 - 500'] },
    ],
  });
  const b = computeExperiment({
    id: 'x',
    variants: [
      { variant: 1, role: 'treatment', ranges: ['250 - 500'] },
      { variant: 0, role: 'control', ranges: ['0 - 250'] },
    ],
  });
  assert.equal(a.structuralKey, b.structuralKey);
  assert.equal(a.key, b.key);
});

// ─── diffExperiments ─────────────────────────────────────────────────────────

/** Entrée complète factice : signature 0:control|1:treatment. */
function mk(treat, ctrl = 0) {
  // ctrl = 0 → pas de variante control (une plage '0 - 0' serait invalide).
  const c = computeExperiment({
    id: 'e1',
    variants: [
      ...(ctrl > 0 ? [{ variant: 0, role: 'control', ranges: ['0 - ' + ctrl] }] : []),
      { variant: 1, role: 'treatment', ranges: [ctrl + ' - ' + (ctrl + treat)] },
    ],
  });
  return { ...c, id: 'e1', type: 'user', title: 'E1' };
}

test('diffExperiments : nouveau, supprimé, changement', () => {
  const prev = { e1: mk(2500) };
  const cur = { e1: mk(3000), e2: mk(1000) };
  const changes = diffExperiments(prev, cur, 0.05);
  assert.equal(changes.length, 2);
  const ch = changes.find((c) => c.id === 'e1');
  assert.equal(ch.kind, 'changed');
  assert.equal(ch.deltaPct, 5);
  const nw = changes.find((c) => c.id === 'e2');
  assert.equal(nw.kind, 'new');
});

test('diffExperiments : micro-changement sous le seuil → ignoré', () => {
  const changes = diffExperiments({ e1: mk(2500) }, { e1: mk(2502) }, 0.05);
  assert.equal(changes.length, 0); // +0,02 pts < 0,05
});

test('diffExperiments : seuil exact atteint → notifié', () => {
  const changes = diffExperiments({ e1: mk(2500) }, { e1: mk(2505) }, 0.05);
  assert.equal(changes.length, 1); // +0,05 pts → notifié
});

test('diffExperiments : 25,00 → 25,01 silencieux puis 25,05 notifié (cumul)', () => {
  // Étape 1 : 25,00 → 25,01 : sous le seuil, PAS notifié, ack ne bouge pas.
  const s1 = diffExperiments({ e1: mk(2500) }, { e1: mk(2501) }, 0.05);
  assert.equal(s1.length, 0);
  // Étape 2 : le run suivant compare TOUJOURS à l'état non notifié (25,00)
  // → 25,05 = +0,05 cumulés : notifié, avec la bonne valeur précédente.
  const s2 = diffExperiments({ e1: mk(2500) }, { e1: mk(2505) }, 0.05);
  assert.equal(s2.length, 1);
  assert.equal(s2[0].kind, 'changed');
  assert.equal(s2[0].before.treatment.pct, 25);
  assert.equal(s2[0].after.treatment.pct, 25.05);
  assert.equal(s2[0].deltaPct, 0.05);
  // Étape 3 : état identique au suivant → silence.
  const s3 = diffExperiments({ e1: mk(2505) }, { e1: mk(2505) }, 0.05);
  assert.equal(s3.length, 0);
});

test('diffExperiments : redistribution entre variantes à total constant → notifiée', () => {
  // 25 % treatment réparti 10/15 puis 20/5 : le total ne bouge pas, les
  // variantes oui — ne doit pas disparaître.
  const mk2 = (a, b) => {
    const c = computeExperiment({
      id: 'e1',
      variants: [
        { variant: 0, role: 'control', ranges: ['0 - 5000'] },
        { variant: 1, role: 'treatment', ranges: ['5000 - ' + (5000 + a)] },
        { variant: 2, role: 'treatment', ranges: [(5000 + a) + ' - ' + (5000 + a + b)] },
      ],
    });
    return { ...c, id: 'e1', type: 'user', title: 'E1' };
  };
  const changes = diffExperiments({ e1: mk2(1000, 1500) }, { e1: mk2(2000, 500) }, 0.05);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'changed');
  // deltaPct = delta SIGNÉ du treatment (0), PAS l'amplitude par variante (10).
  assert.equal(changes[0].deltaPct, 0);
});

test('buildEmbed : redistribution à total constant → titre neutre, pas de faux Δ treatment', () => {
  const mk2 = (a, b) => {
    const c = computeExperiment({
      id: 'e1',
      variants: [
        { variant: 0, role: 'control', ranges: ['0 - 5000'] },
        { variant: 1, role: 'treatment', ranges: ['5000 - ' + (5000 + a)] },
        { variant: 2, role: 'treatment', ranges: [(5000 + a) + ' - ' + (5000 + a + b)] },
      ],
    });
    return { ...c, id: 'e1', type: 'user', title: 'E1' };
  };
  const changes = diffExperiments({ e1: mk2(1000, 1500) }, { e1: mk2(2000, 500) }, 0.05);
  const embed = buildEmbed(changes[0], { revision: 'r', updatedAt: null });
  assert.match(embed.title, /Répartition des variantes modifiée/);
  assert.ok(!embed.title.includes('Montée'));
  const delta = embed.fields.find((f) => f.name === 'Δ treatment');
  assert.ok(delta); // affiché, mais comme « ±0,00 pt — total inchangé »
  assert.match(delta.value, /inchangé/);
  assert.ok(!/\+[0-9]/.test(delta.value)); // pas de faux « +10 pts »
});

test('buildEmbed : totaux indisponibles (dégradé) → pas de Δ treatment, titre neutre', () => {
  const mkAmb = (hi) => {
    // une plage illisible → données dégradées → totaux indisponibles
    const c = computeExperiment({
      id: 'e1',
      variants: [
        { variant: 0, role: 'control', ranges: ['0 - 5000'] },
        { variant: 1, role: 'treatment', ranges: ['5000 - ' + hi, 'plage illisible'] },
      ],
    });
    return { ...c, id: 'e1', type: 'user', title: 'E1' };
  };
  const changes = diffExperiments({ e1: mkAmb(6000) }, { e1: mkAmb(8000) }, 0.05);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].deltaPct, null); // pas de delta treatment affichable
  const embed = buildEmbed(changes[0], { revision: 'r', updatedAt: null });
  assert.match(embed.title, /Changement de couverture/);
  assert.ok(!embed.fields.some((f) => f.name === 'Δ treatment'));
  assert.ok(embed.fields.some((f) => f.name === '⚠ Données dégradées'));
});

test('diffExperiments : restructuration (nouvelle variante) toujours notifiée', () => {
  const a = mk(2500);
  const b = computeExperiment({
    id: 'e1',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 2500'] },
      { variant: 1, role: 'treatment', ranges: ['2500 - 5000'] },
      { variant: 2, role: 'treatment', ranges: ['5000 - 6000'] },
    ],
  });
  const changes = diffExperiments({ e1: { ...a } }, { e1: { ...b, id: 'e1' } }, 0.05);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'structured');
});

test('diffExperiments : données qui apparaissent / disparaissent → structured, delta null', () => {
  const noData = { ...mk(0), hasData: false, treatment: { pct: null } };
  const withData = mk(3000);
  const appear = diffExperiments({ e1: noData }, { e1: withData }, 0.05);
  assert.equal(appear[0].kind, 'structured');
  assert.equal(appear[0].deltaPct, null); // une absence de données n'est pas un 0 %
  const vanish = diffExperiments({ e1: withData }, { e1: noData }, 0.05);
  assert.equal(vanish[0].kind, 'structured');
  assert.equal(vanish[0].deltaPct, null);
  // Sans données des deux côtés : silence.
  assert.equal(diffExperiments({ e1: noData }, { e1: { ...noData } }, 0.05).length, 0);
});

test('diffExperiments : suppression notifiée seulement si données, delta null', () => {
  const withData = mk(3000);
  const noData = { ...mk(0), hasData: false };
  const rm = diffExperiments({ e1: withData }, {}, 0.05)[0];
  assert.equal(rm.kind, 'removed');
  assert.equal(rm.deltaPct, null);
  assert.equal(diffExperiments({ e1: noData }, {}, 0.05).length, 0);
});

// ─── mirrorStatus ────────────────────────────────────────────────────────────

test('mirrorStatus : contenus identiques → pas de divergence', () => {
  const data = [{ id: 'a', variants: [] }];
  const r = mirrorStatus(data, data);
  assert.equal(r.diverged, false);
});

test('mirrorStatus : divergence signalée avec ids', () => {
  const a = [{ id: 'x', variants: [{ variant: 1, role: 'treatment', ranges: ['550 - 1000'] }] }];
  const b = [{ id: 'x', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 500'] }] }];
  const r = mirrorStatus(a, b);
  assert.equal(r.diverged, true);
  assert.deepEqual(r.divergingIds, ['x']);
});

// ─── validateGistData ───────────────────────────────────────────────────────

test('validateGistData : tableau vide / trop petit / non tableau → refusé', () => {
  assert.equal(validateGistData('x').ok, false);
  assert.equal(validateGistData([]).ok, false);
  assert.equal(validateGistData([{ id: 'a', variants: [] }]).ok, false); // 1 < 100
});

test('validateGistData : entrées valides → OK + stats', () => {
  const data = Array.from({ length: 150 }, (_, i) => ({
    id: 'exp-' + i,
    variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1000'] }],
  }));
  const r = validateGistData(data);
  assert.equal(r.ok, true);
  assert.equal(r.stats.withVariants, 150);
});

test('validateGistData : majorité d\'entrées invalides → refusé', () => {
  const data = Array.from({ length: 150 }, (_, i) =>
    i < 100 ? { nope: true } : { id: 'ok-' + i, variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1'] }] },
  );
  assert.equal(validateGistData(data).ok, false);
});

test('validateGistData : ids dupliqués comptés invalides', () => {
  const data = Array.from({ length: 150 }, (_, i) => ({
    id: i < 80 ? 'dup' : 'exp-' + i,
    variants: [],
  }));
  const r = validateGistData(data);
  assert.equal(r.ok, false); // 79 dupliqués + 71 valides → majorité invalide
});

test('validateGistData : UN SEUL doublon → rejet immédiat', () => {
  // Un doublon écraserait une entrée des maps (fausse suppression au diff
  // suivant) : la validation doit échouer, pas « tolérer ».
  const data = Array.from({ length: 150 }, (_, i) => ({
    id: i === 42 ? 'exp-10' : 'exp-' + i,
    variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1'] }],
  }));
  const r = validateGistData(data);
  assert.equal(r.ok, false);
  assert.match(r.error, /dupliqu/);
});

test('validateGistData : UNE SEULE entrée structurellement invalide → rejet', () => {
  // Une entrée sans id ne doit jamais ressembler à la disparition d'une
  // expérience suivie : rejet du fichier, dernier état conservé.
  const data = Array.from({ length: 150 }, (_, i) =>
    i === 42
      ? { nope: true }
      : { id: 'exp-' + i, variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1'] }] },
  );
  const r = validateGistData(data);
  assert.equal(r.ok, false);
  assert.match(r.error, /structurellement invalides/);
});

// ─── Intégration légère : main() avec gist factice ──────────────────────────

const { main, computeAll, buildEmbed } = require('../src/gist_user_rollouts.js');

async function withTempState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gist-rollouts-'));
  const stateFile = path.join(dir, 'state.json');
  const reportFile = path.join(dir, 'report.md');
  return { stateFile, reportFile, dir, result: await fn(stateFile, reportFile) };
}

const FAKE_GIST = [
  {
    id: '2026-10-test-exp',
    variants: [
      { variant: 0, role: 'control', ranges: ['0 - 2500'] },
      { variant: 1, role: 'treatment', ranges: ['2500 - 5000'] },
    ],
  },
  { id: '2026-10-empty', variants: [] },
  {
    id: '2026-10-guild-thing',
    variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 10000'] }],
  },
  {
    id: '2026-10-unknown-type',
    variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1000'] }],
  },
];

// Types : test-exp = user, guild-thing = guild, les autres inconnus.
const FAKE_DEFS = new Map([
  ['2026-10-test-exp', { type: 'user', title: 'Test Experiment' }],
  ['2026-10-guild-thing', { type: 'guild', title: 'Guild Thing' }],
]);

async function fakeFetchGists() {
  return {
    source: {
      gistId: 'test',
      htmlUrl: 'https://gist.github.com/test',
      rawUrl: 'https://example.com/raw',
      updatedAt: new Date().toISOString(),
      revision: 'abc123',
    },
    data: FAKE_GIST,
    mirror: { gistId: 'mirror', diverged: false, divergingIds: [] },
  };
}

/** main() de test : quiet + defs injectés + rapport TOUJOURS hors de data/. */
async function mainT(deps = {}) {
  const rf = deps.reportFile || path.join(os.tmpdir(), 'gist-rollouts-test-report-' + process.pid + '.md');
  return main({ quiet: true, defs: FAKE_DEFS, minEntries: 1, ...deps, reportFile: rf });
}

test('main : premier run = baseline silencieuse, état + rapport écrits', async () => {
  const { stateFile, reportFile } = await withTempState(async (sf, rf) =>
    mainT({ stateFile: sf, reportFile: rf, fetchGists: fakeFetchGists, postWebhook: async () => false }),
  );
  const state = await fs.readJson(stateFile);
  assert.equal(state.stats.total, 4);
  assert.equal(state.lastRun.firstRun, true);
  assert.equal(state.lastRun.changes, 0); // baseline silencieuse
  // acknowledged : user uniquement (guild exclu, inconnus pas notifiables)
  assert.ok(state.acknowledged['2026-10-test-exp']);
  assert.ok(!state.acknowledged['2026-10-guild-thing']);
  assert.ok((await fs.readFile(reportFile, 'utf8')).includes('Test Experiment'));
});

test('main : classification user/guild depuis les defs locales + unclassified', async () => {
  const { byId, typeCounts } = computeAll(FAKE_GIST, FAKE_DEFS);
  assert.equal(byId['2026-10-test-exp'].type, 'user');
  assert.equal(byId['2026-10-guild-thing'].type, 'guild');
  assert.equal(byId['2026-10-empty'].type, 'unclassified');
  assert.deepEqual(typeCounts, { user: 1, guild: 1, unclassified: 2 });
});

test('main : changement user notifié, acknowledged avance sur livraison, silence ensuite', async () => {
  let webhookCalls = 0;
  const { stateFile } = await withTempState(async (sf) => {
    // 1) baseline
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    // 2) rollout monté 25 % → 50 % : notifié, livré
    const v2 = JSON.parse(JSON.stringify(FAKE_GIST));
    v2[0].variants[1].ranges = ['2500 - 7500'];
    const base = await fakeFetchGists();
    const fetchV2 = async () => ({ ...base, data: v2 });
    const r2 = await mainT({
      stateFile: sf,
      fetchGists: fetchV2,
      postWebhook: async () => {
        webhookCalls++;
        return true;
      },
    });
    assert.equal(r2.changes, 1);
    assert.equal(r2.delivered, 1);
    assert.equal(webhookCalls, 1);
    // 3) même état : plus rien à notifier
    const r3 = await mainT({
      stateFile: sf,
      fetchGists: fetchV2,
      postWebhook: async () => {
        webhookCalls++;
        return true;
      },
    });
    assert.equal(r3.changes, 0);
    assert.equal(webhookCalls, 1);
  });
  const state = await fs.readJson(stateFile);
  const ack = state.acknowledged['2026-10-test-exp'];
  assert.ok(ack && ack.hasData);
  assert.equal(ack.treatment.pct, 50); // état NOTIFIÉ = nouvelle valeur
});

test('main : migration formule v2 ciblée — recalcul pur silencieux, vrais changements conservés', async () => {
  const MIG_GIST = [
    {
      id: '2026-10-mig-clean',
      variants: [
        { variant: 0, role: 'control', ranges: ['0 - 2500'] },
        { variant: 1, role: 'treatment', ranges: ['2500 - 5000'] },
      ],
    },
    {
      // multi-population (2× treatment plein) : AMBIGUË en v1, indéterminée en v2
      id: '2026-10-mig-multi',
      variants: [
        { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
        { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
      ],
    },
    { id: '2026-10-mig-nodata', variants: [] }, // sans données en v1
  ];
  const MIG_DEFS = new Map([
    ['2026-10-mig-clean', { type: 'user', title: 'Mig Clean' }],
    ['2026-10-mig-multi', { type: 'user', title: 'Mig Multi' }],
    ['2026-10-mig-nodata', { type: 'user', title: 'Mig Nodata' }],
  ]);
  const fetchMig = async () => ({
    source: { gistId: 'test', htmlUrl: 'x', rawUrl: 'x', updatedAt: new Date().toISOString(), revision: 'abc123' },
    data: MIG_GIST,
    mirror: null,
  });
  let calls = 0;
  const postOk = async () => {
    calls++;
    return true;
  };
  const { stateFile } = await withTempState(async (sf) => {
    // 1) baseline v2
    await mainT({ stateFile: sf, defs: MIG_DEFS, fetchGists: fetchMig, postWebhook: async () => false });
    // 2) simulation d'un état v1 : mig-multi avait des totaux NULL
    //    (ambiguë, ancienne formule). mig-clean était calculable.
    const st = await fs.readJson(sf);
    st.semanticsVersion = 1;
    st.acknowledged['2026-10-mig-multi'].treatment.pct = null;
    st.acknowledged['2026-10-mig-multi'].control.pct = null;
    st.acknowledged['2026-10-mig-multi'].notEligible.pct = null;
    await fs.writeJson(sf, st);
    // 3) run de migration : DONNÉES IDENTIQUES → 0 notification (recalcul pur)
    const r = await mainT({ stateFile: sf, defs: MIG_DEFS, fetchGists: fetchMig, postWebhook: postOk });
    assert.equal(r.changes, 0);
    assert.equal(calls, 0);
    assert.equal(r.delivered, 0);
    assert.equal(r.migrated, 1); // mig-multi : structure prouvée inchangée → silence
  });
  const state = await fs.readJson(stateFile);
  assert.equal(state.semanticsVersion, 2);
  assert.equal(state.lastRun.semanticsMigrated, 1);
  // mig-multi ré-acquittée : totaux principaux null, union en secondaire (100 %)
  assert.equal(state.acknowledged['2026-10-mig-multi'].treatment.pct, null);
  assert.equal(state.acknowledged['2026-10-mig-multi'].projectedCoverage.treatment.pct, 100);
  // mig-clean : acquittement v1 conservé (formules coïncident)
  assert.equal(state.acknowledged['2026-10-mig-clean'].treatment.pct, 25);

  // 4) un VRAI changement après migration est bien notifié (rien n'est perdu)
  const changed = JSON.parse(JSON.stringify(MIG_GIST));
  changed[0].variants[1].ranges = ['2500 - 7500'];
  const fetchChanged = async () => ({
    source: { gistId: 'test', htmlUrl: 'x', rawUrl: 'x', updatedAt: new Date().toISOString(), revision: 'def456' },
    data: changed,
    mirror: null,
  });
  const r2 = await mainT({ stateFile, defs: MIG_DEFS, fetchGists: fetchChanged, postWebhook: postOk });
  assert.equal(r2.changes, 1);
  assert.equal(calls, 1);
  const state2 = await fs.readJson(stateFile);
  assert.equal(state2.acknowledged['2026-10-mig-clean'].treatment.pct, 50);
});

test('main : migration v2 non destructive — apparition de données et changement de structure NOTIFIÉS', async () => {
  // La migration ne doit JAMAIS ré-acquitter : (a) une entrée sans données
  // qui reçoit des données pendant le run (apparition = vrai changement),
  // (b) une entrée ambiguë dont la structure change pendant le run.
  const MIG_GIST = [
    {
      id: '2026-10-mig-nodata',
      variants: [], // sans données en v1
    },
    {
      // ambiguë en v1 et v2 (multi-pop), structure qui CHANGE au run de migration
      id: '2026-10-mig-amb',
      variants: [
        { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
        { variant: 1, role: 'treatment', ranges: ['0 - 10000'] },
      ],
    },
  ];
  const MIG_GIST2 = JSON.parse(JSON.stringify(MIG_GIST));
  MIG_GIST2[0].variants = [{ variant: 1, role: 'treatment', ranges: ['0 - 3000'] }]; // données APPARAISSENT
  MIG_GIST2[1].variants = [
    // structure CHANGE (plages différentes → clé différente)
    { variant: 1, role: 'treatment', ranges: ['0 - 8000'] },
    { variant: 1, role: 'treatment', ranges: ['0 - 8000'] },
  ];
  const MIG_DEFS = new Map([
    ['2026-10-mig-nodata', { type: 'user', title: 'Mig Nodata' }],
    ['2026-10-mig-amb', { type: 'user', title: 'Mig Amb' }],
  ]);
  const fetch1 = async () => ({
    source: { gistId: 'test', htmlUrl: 'x', rawUrl: 'x', updatedAt: new Date().toISOString(), revision: 'r1' },
    data: MIG_GIST,
    mirror: null,
  });
  const fetch2 = async () => ({
    source: { gistId: 'test', htmlUrl: 'x', rawUrl: 'x', updatedAt: new Date().toISOString(), revision: 'r2' },
    data: MIG_GIST2,
    mirror: null,
  });
  let calls = 0;
  const postOk = async () => {
    calls++;
    return true;
  };
  const { stateFile } = await withTempState(async (sf) => {
    // baseline v2 puis passage en état v1 simulé
    await mainT({ stateFile: sf, defs: MIG_DEFS, fetchGists: fetch1, postWebhook: async () => false });
    const st = await fs.readJson(sf);
    st.semanticsVersion = 1;
    st.acknowledged['2026-10-mig-amb'].treatment.pct = null; // ambiguë en v1
    await fs.writeJson(sf, st);
    // run de migration AVEC changements réels : les deux doivent être notifiés
    const r = await mainT({ stateFile: sf, defs: MIG_DEFS, fetchGists: fetch2, postWebhook: postOk });
    assert.equal(r.migrated, 0); // aucune ré-acquisition silencieuse : structure ≠
    assert.ok(r.changes >= 2, 'apparition de données + changement de structure → notifiés');
    assert.equal(calls, 2);
  });
  const state = await fs.readJson(stateFile);
  // mig-amb : totaux null, union projetée 80 % en secondaire
  assert.equal(state.acknowledged['2026-10-mig-amb'].treatment.pct, null);
  assert.equal(state.acknowledged['2026-10-mig-amb'].projectedCoverage.treatment.pct, 80);
  // mig-nodata : données apparues → notifiées, état = nouvelle valeur
  assert.equal(state.acknowledged['2026-10-mig-nodata'].treatment.pct, 30);
});

test('main : type inconnu NON notifié (suivi seulement)', async () => {
  const { stateFile } = await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    // l'expérience de type inconnu double sa couverture → pas de notification
    const v2 = JSON.parse(JSON.stringify(FAKE_GIST));
    v2[3].variants[0].ranges = ['0 - 2000'];
    const base = await fakeFetchGists();
    const fetchV2 = async () => ({ ...base, data: v2 });
    let calls = 0;
    const r = await mainT({
      stateFile: sf,
      fetchGists: fetchV2,
      postWebhook: async () => {
        calls++;
        return true;
      },
    });
    assert.equal(r.changes, 0); // hors du flux user
    assert.equal(calls, 0);
  });
  const state = await fs.readJson(stateFile);
  assert.ok(state.acknowledged); // présent dans l'état via la baseline user
});

test('main : échec de livraison → acknowledged ne bouge pas, renotifié au run suivant', async () => {
  await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    const v2 = JSON.parse(JSON.stringify(FAKE_GIST));
    v2[0].variants[1].ranges = ['2500 - 6000'];
    const base = await fakeFetchGists();
    const fetchV2 = async () => ({ ...base, data: v2 });
    // livraison échoue
    const rFail = await mainT({ stateFile: sf, fetchGists: fetchV2, postWebhook: async () => false });
    assert.equal(rFail.changes, 1);
    assert.equal(rFail.delivered, 0);
    // livraison réussit au run suivant → le même changement repart
    const rOk = await mainT({ stateFile: sf, fetchGists: fetchV2, postWebhook: async () => true });
    assert.equal(rOk.changes, 1);
    assert.equal(rOk.delivered, 1);
  });
});

test('main : livraison partielle — 3 changements, le 2e échoue → ack avance du 1er seul', async () => {
  await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    // 3 changements user d'un coup (expériences fictives typées user).
    const big = [
      { id: '2026-10-test-exp', variants: [
        { variant: 0, role: 'control', ranges: ['0 - 2500'] },
        { variant: 1, role: 'treatment', ranges: ['2500 - 5000'] },
      ]},
      { id: '2026-10-a', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 1000'] }] },
      { id: '2026-10-b', variants: [{ variant: 1, role: 'treatment', ranges: ['0 - 2000'] }] },
    ];
    const defsBig = new Map([
      ['2026-10-test-exp', { type: 'user', title: 'Test Experiment' }],
      ['2026-10-a', { type: 'user', title: 'A' }],
      ['2026-10-b', { type: 'user', title: 'B' }],
    ]);
    const base = await fakeFetchGists();
    const fetchBig = async () => ({ ...base, data: big });
    let n = 0;
    const r = await mainT({
      stateFile: sf,
      defs: defsBig,
      fetchGists: fetchBig,
      postWebhook: async () => {
        n += 1;
        return n === 1; // 1er changement livré, les autres échouent
      },
    });
    assert.equal(r.changes, 2); // deux nouvelles expériences user (b, a)
    assert.equal(r.delivered, 1); // seule la première livraison passe
    const state = await fs.readJson(sf);
    // Ordre de diff (ids triés desc) : 'b' livrée et acquittée ; 'a' ne l'est PAS.
    assert.ok(state.acknowledged['2026-10-b']);
    assert.ok(!state.acknowledged['2026-10-a']);
    // Run suivant, tout livré : 'a' (et uniquement elle) repart.
    const r2 = await mainT({
      stateFile: sf,
      defs: defsBig,
      fetchGists: fetchBig,
      postWebhook: async () => true,
    });
    assert.equal(r2.changes, 1);
    assert.equal(r2.delivered, 1);
  });
});

test('main : gist invalide → dernier état conservé, ok:false', async () => {
  await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    const before = await fs.readJson(sf);
    const bad = await fakeFetchGists();
    // tableau vide = certainement une erreur de lecture, pas une suppression
    const fetchEmpty = async () => ({ ...bad, data: [] });
    const r = await mainT({ stateFile: sf, fetchGists: fetchEmpty, postWebhook: async () => false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_data');
    const after = await fs.readJson(sf);
    assert.deepEqual(after, before); // rien n'a bougé
  });
});

test('main : variante structurellement invalide (variants: [null]) → invalid_data, état inchangé, aucun webhook', async () => {
  await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    const before = await fs.readJson(sf);
    // L'expérience user garde son id mais sa variante devient structurellement
    // invalide : le validateur doit rejeter le FICHIER (pas un « no_data » qui
    // deviendrait une fausse reconfiguration puis remplacerait l'état acquitté).
    const v2 = JSON.parse(JSON.stringify(FAKE_GIST));
    v2[0].variants = [null];
    const base = await fakeFetchGists();
    const fetchV2 = async () => ({ ...base, data: v2 });
    let calls = 0;
    const r = await mainT({
      stateFile: sf,
      fetchGists: fetchV2,
      postWebhook: async () => {
        calls++;
        return true;
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_data');
    assert.equal(calls, 0); // aucun webhook
    const after = await fs.readJson(sf);
    assert.deepEqual(after, before); // état strictement conservé
  });
});

test('main : reclassification user → guild → PAS de faux « retiré du gist », ack nettoyé en silence', async () => {
  await withTempState(async (sf) => {
    // 1) baseline : test-exp est user.
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    // 2) même gist, mais les defs locaux reclassent test-exp en guild.
    const defsGuild = new Map([
      ['2026-10-test-exp', { type: 'guild', title: 'Test Experiment' }],
      ['2026-10-guild-thing', { type: 'guild', title: 'Guild Thing' }],
    ]);
    let calls = 0;
    const r = await mainT({
      stateFile: sf,
      defs: defsGuild,
      fetchGists: fakeFetchGists,
      postWebhook: async () => {
        calls++;
        return true;
      },
    });
    // Toujours au catalogue → aucun changement notifié, aucun faux « removed ».
    assert.equal(r.changes, 0);
    assert.equal(r.delivered, 0);
    assert.equal(calls, 0);
    const state = await fs.readJson(sf);
    // L'expérience quitte le périmètre user : ack nettoyé silencieusement.
    assert.ok(!state.acknowledged['2026-10-test-exp']);
    assert.ok(!state.acknowledged['2026-10-guild-thing']);
  });
});

test('main : export docs JSON écrit (source user de référence pour rollouts.html)', async () => {
  await withTempState(async (sf, rf) => {
    await mainT({ stateFile: sf, reportFile: rf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    const docsFile = rf.replace(/\.md$/, '_docs.json');
    const docs = await fs.readJson(docsFile);
    // user uniquement (guild = apex wire à part), 1 entrée avec données.
    assert.equal(docs.experiments.length, 1);
    const e = docs.experiments[0];
    assert.equal(e.id, '2026-10-test-exp');
    assert.equal(e.treatmentPct, 25);
    assert.equal(e.byVariant['1'].pct, 25);
    assert.equal(e.unassignedPct, 50);
    assert.ok(docs.semantics.includes('couverture'));
    assert.ok(docs.source.gistId);
  });
});

test('main : échec de lecture des gists → dernier état conservé, ok:false', async () => {
  await withTempState(async (sf) => {
    await mainT({ stateFile: sf, fetchGists: fakeFetchGists, postWebhook: async () => false });
    const before = await fs.readJson(sf);
    const r = await mainT({ stateFile: sf, fetchGists: async () => ({ error: 'boom' }), postWebhook: async () => false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'fetch_failed');
    const after = await fs.readJson(sf);
    assert.deepEqual(after, before);
  });
});
