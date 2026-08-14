/**
 * Build data/experiments.json — un seul fichier avec tous les experiments,
 * leurs variations/treatments (nombre exact), et status added | treatments_changed | unchanged.
 *
 * Discord appelle ça "treatments" côté API/définitions ;
 * côté UI datamine on dit souvent "variations". On garde les deux champs de count.
 */

function normalizeVariants(rawList, { preferLabel } = {}) {
  const list = Array.isArray(rawList) ? rawList : [];
  return list.map((t, index) => {
    const id = t.id != null ? t.id : t.bucket != null ? t.bucket : index;
    const label =
      t.label ||
      (preferLabel === 'treatment'
        ? `Treatment ${id}`
        : `Variation ${id}`);
    const entry = { id, label };
    if (t.percent != null) entry.percent = t.percent;
    if (t.ranges != null) entry.ranges = t.ranges;
    return entry;
  });
}

function buildExperimentsCatalog({
  clientEnriched,
  guildEnriched,
  previousCatalog,
  buildNumber,
  scrapedAt,
}) {
  const prevById = new Map();
  for (const e of previousCatalog?.experiments || []) {
    if (e.id) prevById.set(String(e.id).toLowerCase(), e);
  }

  const list = [];

  for (const e of clientEnriched || []) {
    const id = e.id;
    // Exact list from definitions — no invented Variation 0/1
    const variants = normalizeVariants(e.treatments || [], {
      preferLabel: 'variation',
    });
    const count = variants.length;

    const treatmentKey = JSON.stringify(variants.map((t) => [t.id, t.label]));
    const prev = prevById.get(String(id).toLowerCase());
    let status = 'unchanged';
    let previousTreatments = null;
    let previousCount = null;
    if (!prev) {
      status = 'added';
    } else {
      const prevVariants = prev.variants || prev.treatments || [];
      const prevKey = JSON.stringify(prevVariants.map((t) => [t.id, t.label]));
      if (prevKey !== treatmentKey) {
        status = 'treatments_changed';
        previousTreatments = prevVariants;
        previousCount = prev.count != null ? prev.count : prevVariants.length;
      }
    }

    list.push({
      id,
      kind: e.kind || e.type || 'user',
      label: e.label || null,
      isApex: !!e.isApex,
      source: 'client',
      // Discord defs = treatments ; datamine UI = variations — même liste
      variantType: 'variation',
      count,
      variationCount: count,
      treatmentCount: count,
      variants,
      treatments: variants,
      status,
      previousCount,
      previousTreatments,
      buildNumber,
    });
  }

  for (const g of guildEnriched || []) {
    const id = g.id || g.definitionId || `hash:${g.hash}`;
    const variants = normalizeVariants(g.rolloutSummary || [], {
      preferLabel: 'treatment',
    });
    const count = variants.length;

    const treatmentKey = JSON.stringify(
      variants.map((t) => [t.id, t.label, t.percent]),
    );
    const prev = prevById.get(String(id).toLowerCase());
    let status = 'unchanged';
    let previousTreatments = null;
    let previousCount = null;
    if (!prev) {
      status = 'added';
    } else {
      const prevVariants = prev.variants || prev.treatments || [];
      const prevKey = JSON.stringify(
        prevVariants.map((t) => [t.id, t.label, t.percent]),
      );
      if (prevKey !== treatmentKey) {
        status = 'treatments_changed';
        previousTreatments = prevVariants;
        previousCount = prev.count != null ? prev.count : prevVariants.length;
      }
    }

    list.push({
      id,
      kind: 'guild',
      label: g.label || null,
      hash: g.hash,
      isApex: !!g.aaMode,
      source: 'api',
      variantType: 'treatment',
      count,
      variationCount: count,
      treatmentCount: count,
      variants,
      treatments: variants,
      status,
      previousCount,
      previousTreatments,
      buildNumber,
    });
  }

  const rank = { added: 0, treatments_changed: 1, unchanged: 2 };
  list.sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(b.id).localeCompare(String(a.id));
  });

  return {
    scrapedAt,
    buildNumber,
    totals: {
      all: list.length,
      added: list.filter((e) => e.status === 'added').length,
      treatments_changed: list.filter((e) => e.status === 'treatments_changed')
        .length,
      unchanged: list.filter((e) => e.status === 'unchanged').length,
    },
    experiments: list,
  };
}

module.exports = { buildExperimentsCatalog };
