function escapeHtml(s) {
  const amp = String.fromCharCode(38);
  return String(s == null ? '' : s)
    .replace(/&/g, amp + 'amp;')
    .replace(/</g, amp + 'lt;')
    .replace(/>/g, amp + 'gt;')
    .replace(/"/g, amp + 'quot;');
}
/* Rollouts page — guild: experiment_rollouts.json · user: user_rollouts.json (v13, mesure propre) */
(async () => {
  const grid = document.getElementById('grid');
  const meta = document.getElementById('meta');
  const sourcesEl = document.getElementById('sources');
  const search = document.getElementById('search');
  const filterChips = document.querySelectorAll('.chip');
  let allExps = [];
  let currentFilter = 'all';
  let currentSearch = '';

  // Load data — les deux sources en parallèle
  let data = null;
  let userData = null;
  try {
    [data, userData] = await Promise.all([
      fetch('data/experiment_rollouts.json').then((r) => r.json()).catch(() => null),
      fetch('data/user_rollouts.json').then((r) => r.json()).catch(() => null),
    ]);
    if (!data && !userData) {
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

  // ---- Merge : les user exps EXACTES remplacent celles de l'ancien fichier ----
  allExps = ((data && data.matchedExperiments) || [])
    .filter((e) => !(e && e.type === 'user' && userExact.has(String(e.hash))))
    .concat([...userExact.values()])
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
  document.getElementById('stat-fp').textContent = userMeasured;

  const sources = (data && data.sources) || {};
  const sourceParts = [];
  if (userMeasured) {
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

  const dates = [(data && data.fetchedAt), (userData && userData.scrapedAt)]
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
    return `<div class="pct-bar"><div class="pct-fill" style="width:${w}%;background:${color}"></div><span class="pct-text">${pct}%</span></div>`;
  }

  function sourceTag(source) {
    if (!source) return '';
    const labels = {
      discord_api: 'Discord API',
      fingerprint_sampling: 'Fingerprint',
      client_bundle: 'Client',
      own_sampling: 'Mesure propre',
    };
    const label = labels[source] || escapeHtml(source);
    return `<span class="source-tag small">${label}</span>`;
  }

  /* Variants mesurés d'une expérience user v13 (binomial k/n) */
  function exactDetails(exp) {
    if (!exp.treatments || !exp.treatments.length) return '';
    const parts = [`<div class="fp-details">`];
    for (const t of exp.treatments) {
      parts.push(
        '<span class="fp-stat">' + escapeHtml(t.label || 'Bucket ' + t.bucket) + ': ' + t.pct + '%' + (t.sampleCount != null ? ' (' + t.sampleCount + '/' + exp.windowN + ')' : '') + '</span>',
      );
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
      if (currentFilter === 'fp' && e.fpSamples == null && e.source !== 'fingerprint_sampling') return false;

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

    grid.innerHTML = filtered.slice(0, 500).map((e) => {
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

      return `<div class="card ${type}" data-id="${id}">
        <div class="card-head">
          <span class="card-id">${id}</span>
          <span class="card-type type-${type}">${type}</span>
        </div>
        <div class="card-title">${title}</div>
        ${pctBar(pct)}
        <div class="card-foot">
          ${statusBadge(e.status)}
          ${sourceTag(source)}
        </div>
        ${exactDetails(e) || fpDetails(e)}
        ${note ? `<div class="card-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
    }).join('');
  }

  search.addEventListener('input', (e) => {
    currentSearch = e.target.value;
    render();
  });

  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      render();
    });
  });

  render();
})();
