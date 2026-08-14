/**
 * Build data/experiments.json — un seul fichier avec tous les experiments,
 * leurs variations/treatments, et le statut added | treatments_changed | unchanged.
 */

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
    const treatments = (e.treatments || []).map((t) => ({
      id: t.id,
      label: t.label || `Variation ${t.id}`,
    }));
    if (treatments.length === 0) {
      treatments.push({ id: 0, label: 'Variation 0 (control)' });
      treatments.push({ id: 1, label: 'Variation 1' });
    }

    const treatmentKey = JSON.stringify(treatments.map((t) => [t.id, t.label]));
    const prev = prevById.get(String(id).toLowerCase());
    let status = 'unchanged';
    let previousTreatments = null;
    if (!prev) {
      status = 'added';
    } else {
      const prevKey = JSON.stringify(
        (prev.treatments || []).map((t) => [t.id, t.label]),
      );
      if (prevKey !== treatmentKey) {
        status = 'treatments_changed';
        previousTreatments = prev.treatments || [];
      }
    }

    list.push({
      id,
      kind: e.kind || e.type || 'user',
      label: e.label || null,
      isApex: !!e.isApex,
      source: 'client',
      treatments,
      status,
      previousTreatments,
      buildNumber,
    });
  }

  for (const g of guildEnriched || []) {
    const id = g.id || g.definitionId || `hash:${g.hash}`;
    const treatments = (g.rolloutSummary || []).map((b) => ({
      id: b.bucket,
      label: b.label,
      percent: b.percent,
      ranges: b.ranges || null,
    }));

    const treatmentKey = JSON.stringify(
      treatments.map((t) => [t.id, t.label, t.percent]),
    );
    const prev = prevById.get(String(id).toLowerCase());
    let status = 'unchanged';
    let previousTreatments = null;
    if (!prev) {
      status = 'added';
    } else {
      const prevKey = JSON.stringify(
        (prev.treatments || []).map((t) => [t.id, t.label, t.percent]),
      );
      if (prevKey !== treatmentKey) {
        status = 'treatments_changed';
        previousTreatments = prev.treatments || [];
      }
    }

    list.push({
      id,
      kind: 'guild',
      label: g.label || null,
      hash: g.hash,
      isApex: !!g.aaMode,
      source: 'api',
      treatments,
      status,
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
