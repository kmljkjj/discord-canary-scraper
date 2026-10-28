function escapeHtml(s) {
  const amp = String.fromCharCode(38);
  return String(s == null ? '' : s)
    .replace(/&/g, amp + 'amp;')
    .replace(/</g, amp + 'lt;')
    .replace(/>/g, amp + 'gt;')
    .replace(/"/g, amp + 'quot;');
}
/* Rollouts page — guild: experiment_rollouts.json · user: couverture du gist agnonotdev (non vérifiée) et mesure API Discord, deux panneaux séparés (user_rollout_comparison.json) */
(async () => {
  const grid = document.getElementById('grid');
  const meta = document.getElementById('meta');
  const sourcesEl = document.getElementById('sources');
  const search = document.getElementById('search');
  const filterChips = document.querySelectorAll('.chip');
  let allExps = [];
  let currentFilter = 'all';
  let currentSearch = '';
  const PAGE = 100;
  let limit = PAGE;

  // Load data — les sources en parallèle (gist = référence user depuis v2.6)
  let data = null;
  let userData = null;
  let gistData = null;
  let cmpData = null;
  try {
    [data, userData, gistData, cmpData] = await Promise.all([
      fetch('data/experiment_rollouts.json').then((r) => r.json()).catch(() => null),
      fetch('data/user_rollouts.json').then((r) => r.json()).catch(() => null),
      fetch('data/gist_user_rollouts_docs.json').then((r) => r.json()).catch(() => null),
      fetch('data/user_rollout_comparison.json').then((r) => r.json()).catch(() => null),
    ]);
    if (!data && !userData && !gistData && !cmpData) {
      grid.innerHTML = '<div class="empty">Erreur de chargement</div>';
      return;
    }
  } catch (e) {
    grid.innerHTML = '<div class="empty">Erreur de chargement</div>';
    return;
  }

  // ---- User experiments : mesure propre depuis user_rollouts.json (v13) ----
  // % binomial (k/n) sur une fenêtre glissante d'échantillons anonymes,
  // 2 décimales, avec un n (windowN) par expérience.
  const userExact = new Map();
  let userMeasured = 0;
  let userDetected = 0;

  function treatmentPct(treatments) {
    let best = null;
    for (const t of treatments) {
      if (t.bucket >= 1 && (best == null || t.pct > best)) best = t.pct;
    }
    if (best != null) return best;
    for (const t of treatments) {
      if (t.bucket === 0) return t.pct;
    }
    return treatments[0].pct;
  }

  if (userData && Array.isArray(userData.experiments)) {
    for (const e of userData.experiments) {
      if (!e || e.type !== 'user' || !e.id) continue;
      const treatments = (e.treatments || []).filter(
        (t) => t && t.pctKnown && t.pct != null && Number.isFinite(t.pct),
      );
      if (e.status === 'detected' || !treatments.length) {
        // Détecté sans ranges → ?% honnête
        userDetected++;
        userExact.set(String(e.hash), {
          id: e.id,
          title: e.title || e.id,
          type: 'user',
          hash: e.hash,
          source: 'fingerprint_sampling',
          status: e.status,
          percentage: null,
          platforms: [],
          detected: true,
        });
        continue;
      }
      userMeasured++;
      userExact.set(String(e.hash), {
        id: e.id,
        title: e.title || e.id,
        type: 'user',
        hash: e.hash,
        source: e.source || 'own_sampling',
        status: e.status || null,
        percentage: treatmentPct(treatments),
        platforms: e.platforms || [],
        treatments,
        windowN: e.windowN || null,
        fingerprint: e.fingerprint || null,
      });
    }
  }

  // ---- Comparaison : couverture gist non vérifiée / mesure API Discord ----
  // Jamais fusionnées : deux sources, deux dates, deux panneaux. Une carte par
  // expérience : les mesures par hash sont rattachées au nom quand il est connu.
  const cmpList = cmpData && Array.isArray(cmpData.experiments)
    ? cmpData.experiments.filter((c) => c && c.type === 'user' && c.id)
    : [];
  const cmpById = new Map(cmpList.map((c) => [String(c.id), c]));
  const cmpHashes = new Set(cmpList.filter((c) => c.hash != null).map((c) => String(c.hash)));
  const gistTreatmentPct = (g) =>
    g && g.totalsAvailable && g.treatmentPct != null
      ? g.treatmentPct
      : g && g.projected && g.projectedTreatmentPct != null
        ? g.projectedTreatmentPct
        : null;

  // ---- User : couverture gist (RÉFÉRENCE depuis v2.6) ----
  // Le gist communautaire agnonotdev décrit la couverture de buckets de ~350
  // expériences user : c'est la source de référence. L'ancienne mesure par
  // sampling (k/n + Wilson) n'apparaît plus que pour les expériences absentes
  // du gist — étiquetée diagnostic (son cron est désactivé).
  const gistUser = new Map();
  let gistCount = 0;
  if (gistData && Array.isArray(gistData.experiments)) {
    for (const e of gistData.experiments) {
      if (!e || !e.id || e.type !== 'user') continue;
      gistCount++;
      gistUser.set(String(e.id), {
        id: e.id,
        title: e.title || e.id,
        type: 'user',
        source: 'gist_coverage',
        status: !e.hasData
          ? 'unknown'
          : e.ambiguous
            ? 'ambiguous'
            : e.projected
              ? 'projected'
              : 'gist',
        // multi-populations : pourcentage exact impossible (poids absents) →
        // union non pondérée affichée comme couverture PROJETÉE (métrique
        // secondaire, étiquetée — jamais un % ordinaire).
        percentage:
          e.totalsAvailable && e.treatmentPct != null
            ? e.treatmentPct
            : e.projected && e.projectedTreatmentPct != null
              ? e.projectedTreatmentPct
              : null,
        gist: e,
        cmp: cmpById.get(String(e.id)) || null,
      });
    }
  }
  // Expériences observées par l'API mais absentes de l'export gist (non classées
  // localement, nom connu par le gist brut, ou hash sans nom) : une carte aussi.
  const cmpOnly = cmpList
    .filter((c) => !gistUser.has(String(c.id)))
    .map((c) => ({
      id: c.id,
      title: c.title || c.id,
      type: 'user',
      source: 'api_comparison',
      status: c.coverage ? 'gist' : 'detected',
      percentage: gistTreatmentPct(c.coverage),
      gist: null,
      cmp: c,
    }));

  // ---- Merge : gist (référence) > mesure propre > ancien fichier ----
  allExps = ((data && data.matchedExperiments) || [])
    .filter((e) => !(e && e.type === 'user' && (userExact.has(String(e.hash)) || gistUser.has(String(e.id)) || cmpById.has(String(e.id)))))
    .concat([...userExact.values()].filter((e) => !gistUser.has(String(e.id)) && !cmpHashes.has(String(e.hash))))
    .concat(cmpOnly)
    .concat([...gistUser.values()])
    .sort((a, b) => {
      const aPct = a.percentage != null ? a.percentage : -1;
      const bPct = b.percentage != null ? b.percentage : -1;
      if (bPct !== aPct) return bPct - aPct;
      return (a.id || a.title || '').localeCompare(b.id || b.title || '');
    });

  document.getElementById('stat-total').textContent = allExps.length;
  document.getElementById('stat-pct').textContent =
    allExps.filter((e) => e.percentage != null).length;
  document.getElementById('stat-full').textContent =
    allExps.filter((e) => e.percentage != null && e.percentage >= 100).length;
  const measuredCount = allExps.filter((e) => e.cmp && e.cmp.measurement && e.cmp.measurement.status === 'measured').length;
  document.getElementById('stat-fp').textContent = measuredCount || userMeasured;

  const sources = (data && data.sources) || {};
  const sourceParts = [];
  if (gistCount) {
    sourceParts.push(`Gist (référence): ${gistCount}`);
  }
  if (measuredCount) {
    const when = cmpData && cmpData.sources && cmpData.sources.sampling && cmpData.sources.sampling.observedAt;
    sourceParts.push(`Mesure Discord API: ${measuredCount} user` + (when ? ` · ${new Date(when).toLocaleString('fr-FR')}` : ''));
  } else if (userMeasured) {
    sourceParts.push(`User (mesure propre): ${userMeasured}`);
  }
  if (userDetected) {
    sourceParts.push(`User detectes (?%): ${userDetected}`);
  }
  if (sources.discordApi) {
    sourceParts.push(`Discord API: ${sources.discordApi.count ?? 0} guild exps`);
  }
  if (sources.fingerprintSampling) {
    const fp = sources.fingerprintSampling;
    if (fp.samples) {
      sourceParts.push(`Fingerprint: ${fp.samples} echantillons, ${fp.uniqueHashes ?? 0} hashes, ${fp.matched ?? 0} matches`);
    } else if (fp.error) {
      sourceParts.push(`Fingerprint: erreur`);
    }
  }
  sourcesEl.innerHTML = sourceParts.map((s) => `<span class="source-tag">${escapeHtml(s)}</span>`).join('');

  const dates = [(data && data.fetchedAt), (userData && userData.scrapedAt), (cmpData && cmpData.generatedAt)]
    .filter(Boolean)
    .sort()
    .reverse();
  const fetchedAt = dates[0] ? new Date(dates[0]).toLocaleString('fr-FR') : '-';
  meta.textContent = `${allExps.length} experiences · ${fetchedAt}`;
  document.getElementById('updated').textContent = fetchedAt;

  function statusBadge(status) {
    const labels = {
      full_rollout: { text: '100%', cls: 'badge-full' },
      full: { text: 'Full', cls: 'badge-full' },
      rolling_out: { text: 'En cours', cls: 'badge-partial' },
      ab_test: { text: 'A/B', cls: 'badge-partial' },
      estimated: { text: 'Mesuré', cls: 'badge-partial' },
      degraded: { text: 'n faible', cls: 'badge-na' },
      gist: { text: 'Gist', cls: 'badge-partial' },
      ambiguous: { text: 'Ambigu', cls: 'badge-na' },
      projected: { text: 'Projeté', cls: 'badge-na' },
      segmented: { text: 'Segmented', cls: 'badge-partial' },
      partial: { text: 'Partiel', cls: 'badge-partial' },
      not_started: { text: '0%', cls: 'badge-zero' },
      not_rolled_out: { text: '0%', cls: 'badge-zero' },
      no_rollout_data: { text: 'N/A', cls: 'badge-na' },
      detected: { text: '?', cls: 'badge-na' },
      unknown: { text: '?', cls: 'badge-na' },
    };
    const l = labels[status] || labels.unknown;
    return `<span class="badge ${l.cls}">${l.text}</span>`;
  }

  function pctBar(pct) {
    if (pct == null) return '';
    const w = Math.max(0, Math.min(100, pct));
    const color = pct >= 100 ? '#57f287' : pct > 0 ? '#fee75c' : '#ed4245';
    // Affichage français à 2 décimales, comme le rapport et les embeds :
    // « 2,50 % », « 0,01 % » — la résolution de la source est 0,01 point.
    const label = pct.toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `<div class="pct-bar"><div class="pct-fill" style="width:${w}%;background:${color}"></div><span class="pct-text">${label}&nbsp;%</span></div>`;
  }

  function sourceTag(source) {
    if (!source) return '';
    const labels = {
      discord_api: 'Discord API',
      fingerprint_sampling: 'Fingerprint',
      client_bundle: 'Client',
      own_sampling: 'Sampling (diagnostic)',
      gist_coverage: 'Gist (couverture)',
      api_comparison: 'Gist + API',
    };
    const label = labels[source] || escapeHtml(source);
    return `<span class="source-tag small">${label}</span>`;
  }

  /* Variants mesurés d'une expérience user v14 (k/n + Wilson + bornes indicatives) */
  function exactDetails(exp) {
    if (!exp.treatments || !exp.treatments.length) return '';
    const parts = [`<div class="fp-details">`];
    for (const t of exp.treatments) {
      let line =
        '<span class="fp-stat">' + escapeHtml(t.label || 'Bucket ' + t.bucket) + ': ' + t.pct + '%' + (t.sampleCount != null ? ' (' + t.sampleCount + '/' + exp.windowN + ')' : '') + '</span>';
      if (t.ci && Number.isFinite(t.ci.lo) && Number.isFinite(t.ci.hi)) {
        line += `<span class="fp-stat">IC 95%: [${t.ci.lo}, ${t.ci.hi}]</span>`;
      }
      parts.push(line);
      if (t.ranges && t.ranges.length) {
        const bounds = t.ranges.map((r) => `[${Math.round(r[0])}, ${Math.round(r[1])}]`).join(' + ');
        parts.push(
          `<span class="fp-stat">bornes reconstruites (indicatif): ${escapeHtml(bounds)}` +
          (t.indicativePct != null ? ` → ${t.indicativePct}%` + (t.indicativeCi != null ? ` ± ${t.indicativeCi}` : '') : '') + '</span>',
        );
      }
    }
    if (exp.windowN) {
      parts.push(`<span class="fp-stat">n=${exp.windowN}</span>`);
    }
    if (exp.platforms && exp.platforms.length) {
      parts.push(`<span class="fp-stat">${escapeHtml(exp.platforms.join(', '))}</span>`);
    }
    parts.push('</div>');
    return parts.join('');
  }

  /* Couverture de buckets d'une expérience user (gist agnonotdev, v2.6). */
  // Format français à 2 décimales — cohérent avec le rapport et les embeds.
  const fmtPct2 = (p) =>
    p.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function gistDetails(exp) {
    if (!exp.gist) return '';
    const g = exp.gist;
    const parts = ['<div class="fp-details">'];
    parts.push(
      '<span class="fp-stat">Couverture de buckets (gist) — pas une proportion d\'utilisateurs</span>',
    );
    if (g.projected) {
      // multi-populations : aucun pourcentage exact — union non pondérée en métrique secondaire
      parts.push(
        '<span class="fp-stat">ℹ multi-populations : pourcentage exact impossible — union non pondérée (projetée)</span>',
      );
    }
    for (const [k, v] of Object.entries(g.byVariant || {})) {
      parts.push(
        `<span class="fp-stat">Variant ${escapeHtml(k)} · ${escapeHtml(v.role || '?')} : ${
          v.pct != null ? fmtPct2(v.pct) + ' %' : 'indéterminé'
        }</span>`,
      );
    }
    if (g.totalsAvailable && g.unassignedPct != null) {
      parts.push(`<span class="fp-stat">espace non décrit : ${fmtPct2(g.unassignedPct)} %</span>`);
    }
    if (g.ambiguous && g.flags && g.flags.length) {
      parts.push(`<span class="fp-stat">⚠ ${escapeHtml(g.flags.join(', '))} — totaux indisponibles</span>`);
    }
    parts.push('</div>');
    return parts.join('');
  }

  /* Fraîcheur calculée à l'affichage : une vieille mesure reste visible mais datée. */
  function ageLabel(iso, staleH) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return { text: 'date inconnue', stale: true };
    const h = Math.max(0, (Date.now() - t) / 3600000);
    const text = h < 1 ? 'il y a moins d\'1 h' : h < 48 ? `il y a ${Math.round(h)} h` : `il y a ${Math.round(h / 24)} j`;
    return { text, stale: h > staleH };
  }
  const fmtDate = (iso) => (Number.isFinite(Date.parse(iso || '')) ? new Date(iso).toLocaleString('fr-FR') : 'inconnue');
  const fmtRange = (r) => `[${r[0]} ; ${r[1]}[`;

  function gistPanel(exp) {
    const g = exp.gist || (exp.cmp && exp.cmp.coverage);
    const c = exp.cmp && exp.cmp.coverage;
    const parts = ['<section class="cmp-panel" aria-label="Couverture gist">'];
    parts.push('<h4>Couverture gist <span class="cmp-tag">non vérifiée</span></h4>');
    if (!g || !g.hasData) {
      parts.push('<p class="cmp-big cmp-none">Pas de plage exploitable</p>');
      parts.push('</section>');
      return parts.join('');
    }
    const pct = gistTreatmentPct(g);
    parts.push(pct != null
      ? `<p class="cmp-big">${fmtPct2(pct)}&nbsp;%${g.projected ? ' <span class="cmp-sub">projeté</span>' : ''}</p>`
      : '<p class="cmp-big cmp-none">Total indisponible</p>');
    parts.push('<p class="cmp-line">Part de l\'espace de buckets décrite par le gist, pas une proportion d\'utilisateurs.</p>');
    if (g.projected) parts.push('<p class="cmp-line">Multi-populations : union non pondérée.</p>');
    const ranges = c && Array.isArray(c.sourceRanges) ? c.sourceRanges : null;
    if (ranges) {
      for (const v of ranges) {
        parts.push(`<p class="cmp-line">Variant ${escapeHtml(v.variant)} · ${escapeHtml(v.role)} : ${escapeHtml((v.ranges || []).map(fmtRange).join(' + '))}</p>`);
      }
    } else {
      for (const [k, v] of Object.entries(g.byVariant || {})) {
        parts.push(`<p class="cmp-line">Variant ${escapeHtml(k)} · ${escapeHtml(v.role || '?')} : ${v.pct != null ? fmtPct2(v.pct) + ' %' : 'indéterminé'}</p>`);
      }
    }
    if (g.ambiguous && g.flags && g.flags.length) parts.push(`<p class="cmp-line">⚠ ${escapeHtml(g.flags.join(', '))}</p>`);
    const upd = c && c.updatedAt;
    if (upd) {
      const age = ageLabel(upd, 72);
      parts.push(`<p class="cmp-line">Gist modifié : ${escapeHtml(fmtDate(upd))}${age.stale ? ' <span class="cmp-stale">ancien</span>' : ''}</p>`);
    }
    if (c && c.htmlUrl && /^https:\/\/gist\.github\.com\//.test(c.htmlUrl)) {
      parts.push(`<p class="cmp-line"><a href="${escapeHtml(c.htmlUrl)}" target="_blank" rel="noopener">Voir la source</a></p>`);
    }
    parts.push('</section>');
    return parts.join('');
  }

  function measurePanel(exp) {
    const m = exp.cmp && exp.cmp.measurement;
    const parts = ['<section class="cmp-panel" aria-label="Mesure API Discord">'];
    parts.push('<h4>Mesure API Discord <span class="cmp-tag">k/n</span></h4>');
    if (!m || m.status === 'not_observed') {
      parts.push('<p class="cmp-big cmp-none">Non observée</p>');
      parts.push('<p class="cmp-line">Aucune réponse API dans la fenêtre : pas de 0 % déduit.</p></section>');
      return parts.join('');
    }
    if (m.status === 'invalid') {
      parts.push('<p class="cmp-big cmp-none">Mesure invalide</p>');
      parts.push('<p class="cmp-line">Données incohérentes : aucun pourcentage affiché.</p></section>');
      return parts.join('');
    }
    if (m.pct != null && m.ci) {
      parts.push(`<p class="cmp-big">${fmtPct2(m.pct)}&nbsp;%</p>`);
      parts.push(`<p class="cmp-line">IC 95 % (Wilson) : [${fmtPct2(m.ci.lo)} ; ${fmtPct2(m.ci.hi)}] % · ${escapeHtml(m.k)}/${escapeHtml(m.n)} observations de traitement</p>`);
    } else {
      const o = m.observedAssignments;
      parts.push('<p class="cmp-big cmp-none">Rôle inconnu</p>');
      parts.push(`<p class="cmp-line">${o ? escapeHtml(o.k) + '/' + escapeHtml(o.n) + ' assignations observées (' + fmtPct2(o.pct) + ' %)' : 'Assignations observées'} — sans rôle gist, impossible de dire quelle part est un traitement.</p>`);
    }
    for (const v of (m.variants || []).length > 1 || m.pct == null ? m.variants : []) {
      parts.push(`<p class="cmp-line">Variant ${escapeHtml(v.bucket)} · ${escapeHtml(v.role)} : ${escapeHtml(v.k)}/${escapeHtml(v.n)} · ${fmtPct2(v.pct)} %${v.ci ? ' [' + fmtPct2(v.ci.lo) + ' ; ' + fmtPct2(v.ci.hi) + ']' : ''}</p>`);
    }
    const age = ageLabel(m.observedAt, 6);
    parts.push(`<p class="cmp-line">Mesuré : ${escapeHtml(fmtDate(m.observedAt))} (${age.text})${age.stale ? ' <span class="cmp-stale">historique</span>' : ''}</p>`);
    parts.push('<p class="cmp-line">Échantillons anonymes du collecteur, pas tous les utilisateurs ; filtres de population inconnus.</p>');
    parts.push('</section>');
    return parts.join('');
  }

  function compareNote(exp) {
    const cmp = exp.cmp;
    if (!cmp || !cmp.comparison) return '';
    const o = cmp.comparison.observation;
    if (o === 'inside_interval') {
      return '<p class="cmp-verdict ok">La couverture gist est dans l\'intervalle mesuré. Cela ne prouve pas que les populations sont identiques.</p>';
    }
    if (o === 'outside_interval') {
      const d = cmp.comparison.deltaPoints;
      return `<p class="cmp-verdict warn">Hors intervalle${d != null ? ' (écart ' + (d > 0 ? '+' : '') + fmtPct2(d) + ' pt)' : ''}. Filtres, plateformes, révision ou date peuvent l'expliquer : le gist n'est ni confirmé ni réfuté.</p>`;
    }
    return '';
  }

  function compareBlock(exp) {
    return `<div class="cmp">${gistPanel(exp)}${measurePanel(exp)}</div>${compareNote(exp)}`;
  }

  function fpDetails(exp) {
    if (exp.fpSamples == null && exp.source !== 'fingerprint_sampling') return '';
    const samples = exp.fpSamples ?? exp.samples ?? 0;
    if (samples === 0) return '';
    const enrolled = exp.fpEnrolled ?? exp.enrolled ?? 0;
    const treatments = exp.fpTreatmentDist ?? exp.treatmentDistribution ?? {};
    const parts = [`<div class="fp-details">`];
    parts.push(`<span class="fp-stat">Echantillons: ${samples}</span>`);
    parts.push(`<span class="fp-stat">Enrolled: ${enrolled}</span>`);
    const treatmentStr = Object.entries(treatments).map(([t, c]) => `T${t}:${c}`).join(' ');
    if (treatmentStr) parts.push(`<span class="fp-stat">${treatmentStr}</span>`);
    parts.push('</div>');
    return parts.join('');
  }

  function render() {
    const filtered = allExps.filter((e) => {
      if (currentFilter === 'with-pct' && e.percentage == null) return false;
      if (currentFilter === 'guild' && e.type !== 'guild') return false;
      if (currentFilter === 'user' && e.type !== 'user') return false;
      if (currentFilter === 'fp' && !(e.cmp && e.cmp.measurement && e.cmp.measurement.status === 'measured') && e.fpSamples == null && e.source !== 'fingerprint_sampling') return false;

      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        const text = `${e.id || ''} ${e.title || ''} ${e.hash || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty">Aucun resultat</div>';
      return;
    }

    const shown = filtered.slice(0, limit);
    grid.innerHTML = shown.map((e) => {
      const rawId = e.id || `hash_${e.hash}`;
      const id = escapeHtml(rawId);
      const title = escapeHtml(e.title || rawId);
      const type = e.type || 'unknown';
      const pct = e.percentage;
      const source = e.source || '';
      let note = e.note || '';
      if (type === 'user' && source === 'client_bundle' && pct == null) {
        note = 'Pas encore mesuré — Discord ne publie pas ce pourcentage. Apparaîtra automatiquement dès le début du rollout.';
      }

      const withCmp = type === 'user' && (e.gist || e.cmp);
      return `<div class="card ${type}${withCmp ? ' has-cmp' : ''}" data-id="${id}">
        <div class="card-head">
          <span class="card-id">${id}</span>
          <span class="card-type type-${type}">${type}</span>
        </div>
        <div class="card-title">${title}</div>
        ${withCmp ? '' : pctBar(pct)}
        <div class="card-foot">
          ${statusBadge(e.status)}
          ${sourceTag(source)}
        </div>
        ${withCmp ? compareBlock(e) : (gistDetails(e) || exactDetails(e) || fpDetails(e))}
        ${note ? `<div class="card-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
    }).join('');
    if (filtered.length > shown.length) {
      const rest = filtered.length - shown.length;
      grid.insertAdjacentHTML('beforeend', `<div class="more-wrap"><button type="button" class="chip" id="more">Afficher plus (${shown.length} sur ${filtered.length}, ${rest} restantes)</button></div>`);
      document.getElementById('more').addEventListener('click', () => {
        limit += PAGE;
        render();
      });
    }
  }

  search.addEventListener('input', (e) => {
    currentSearch = e.target.value;
    limit = PAGE;
    render();
  });

  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      limit = PAGE;
      render();
    });
  });

  render();
})();
