function escapeHtml(s){return String(s==null?"":s).replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">").replace(/"/g,""");}
/* Rollouts page — fetch experiment_rollouts.json and render cards */
(async () => {
  const grid = document.getElementById('grid');
  const meta = document.getElementById('meta');
  const sourcesEl = document.getElementById('sources');
  const search = document.getElementById('search');
  const filterChips = document.querySelectorAll('.chip');
  let allExps = [];
  let currentFilter = 'all';
  let currentSearch = '';

  // Load data
  let data;
  try {
    const res = await fetch('data/experiment_rollouts.json');
    data = await res.json();
  } catch (e) {
    grid.innerHTML = '<div class="empty">Erreur de chargement</div>';
    return;
  }

  allExps = (data.matchedExperiments || []).slice().sort((a, b) => {
    // Sort: with percentage first, then by percentage desc, then by id
    const aPct = a.percentage != null ? a.percentage : -1;
    const bPct = b.percentage != null ? b.percentage : -1;
    if (bPct !== aPct) return bPct - aPct;
    return (a.id || a.title || '').localeCompare(b.id || b.title || '');
  });

  // Stats
  document.getElementById('stat-total').textContent = data.summary?.total ?? allExps.length;
  document.getElementById('stat-pct').textContent = data.summary?.withPercentage ?? 0;
  document.getElementById('stat-full').textContent = data.summary?.fullRollout ?? 0;
  document.getElementById('stat-fp').textContent = data.summary?.fpSampled ?? 0;

  // Sources info
  const sources = data.sources || {};
  const sourceParts = [];
  if (sources.discordApi) {
    sourceParts.push(`Discord API: ${sources.discordApi.count ?? 0} guild exps`);
  }
  if (sources.workerApi) {
    sourceParts.push(`Worker API: ${sources.workerApi.count ?? 0} exps`);
  }
  if (sources.fingerprintSampling) {
    const fp = sources.fingerprintSampling;
    if (fp.samples) {
      sourceParts.push(`Fingerprint: ${fp.samples} échantillons, ${fp.uniqueHashes ?? 0} hashes, ${fp.matched ?? 0} matchés`);
    } else if (fp.error) {
      sourceParts.push(`Fingerprint: erreur`);
    }
  }
  sourcesEl.innerHTML = sourceParts.map(s => `<span class="source-tag">${s}</span>`).join('');

  const fetchedAt = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString('fr-FR') : '—';
  meta.textContent = `${allExps.length} expériences · ${fetchedAt}`;
  document.getElementById('updated').textContent = fetchedAt;

  // Status badge helper
  function statusBadge(status) {
    const labels = {
      full_rollout: { text: '100%', cls: 'badge-full' },
      partial: { text: 'Partiel', cls: 'badge-partial' },
      not_started: { text: '0%', cls: 'badge-zero' },
      no_rollout_data: { text: 'N/A', cls: 'badge-na' },
      unknown: { text: '?', cls: 'badge-na' },
    };
    const l = labels[status] || labels.unknown;
    return `<span class="badge ${l.cls}">${l.text}</span>`;
  }

  // Percentage bar helper
  function pctBar(pct) {
    if (pct == null) return '';
    const w = Math.max(0, Math.min(100, pct));
    const color = pct >= 100 ? '#57f287' : pct > 0 ? '#fee75c' : '#ed4245';
    return `<div class="pct-bar"><div class="pct-fill" style="width:${w}%;background:${color}"></div><span class="pct-text">${pct}%</span></div>`;
  }

  // Source tag helper
  function sourceTag(source) {
    if (!source) return '';
    const labels = {
      discord_api: 'Discord API',
      worker_api: 'Worker API',
      fingerprint_sampling: 'Fingerprint',
      client_bundle: 'Client',
    };
    const label = labels[source] || escapeHtml(source);
    return `<span class="source-tag small">${label}</span>`;
  }

  // Fingerprint details helper
  function fpDetails(exp) {
    if (exp.fpSamples == null && exp.source !== 'fingerprint_sampling') return '';
    const samples = exp.fpSamples ?? exp.samples ?? 0;
    if (samples === 0) return '';
    const enrolled = exp.fpEnrolled ?? exp.enrolled ?? 0;
    const treatments = exp.fpTreatmentDist ?? exp.treatmentDistribution ?? {};
    const parts = [`<div class="fp-details">`];
    parts.push(`<span class="fp-stat">Échantillons: ${samples}</span>`);
    parts.push(`<span class="fp-stat">Enrolled: ${enrolled}</span>`);
    const treatmentStr = Object.entries(treatments).map(([t, c]) => `T${t}:${c}`).join(' ');
    if (treatmentStr) parts.push(`<span class="fp-stat">${treatmentStr}</span>`);
    parts.push('</div>');
    return parts.join('');
  }

  // Render
  function render() {
    const filtered = allExps.filter((e) => {
      // Filter
      if (currentFilter === 'with-pct' && e.percentage == null) return false;
      if (currentFilter === 'guild' && e.type !== 'guild') return false;
      if (currentFilter === 'user' && e.type !== 'user') return false;
      if (currentFilter === 'fp' && e.fpSamples == null && e.source !== 'fingerprint_sampling') return false;

      // Search
      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        const text = `${e.id || ''} ${e.title || ''} ${e.hash || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty">Aucun résultat</div>';
      return;
    }

    grid.innerHTML = filtered.slice(0, 500).map((e) => {
      const rawId = e.id || `hash_${e.hash}`; const id = escapeHtml(rawId);
      const title = escapeHtml(e.title || rawId);
      const type = e.type || 'unknown';
      const pct = e.percentage;
      const source = e.source || '';
      const note = e.note || '';

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
        ${fpDetails(e)}
        ${note ? `<div class="card-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Search
  search.addEventListener('input', (e) => {
    currentSearch = e.target.value;
    render();
  });

  // Filters
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
