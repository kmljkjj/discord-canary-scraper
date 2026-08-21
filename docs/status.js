const SUMMARY_URL = 'https://discordstatus.com/api/v2/summary.json';
const INCIDENTS_URL = 'https://discordstatus.com/api/v2/incidents.json';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function levelFromIndicator(ind) {
  if (ind === 'none' || ind === 'operational') return 'ok';
  if (ind === 'minor') return 'warn';
  return 'bad';
}

function levelFromComponent(status) {
  if (status === 'operational') return 'ok';
  if (status === 'degraded_performance' || status === 'partial_outage') return 'warn';
  return 'bad';
}

function labelStatus(s) {
  return (s || '').replace(/_/g, ' ');
}

async function main() {
  const [summaryRes, incidentsRes] = await Promise.all([
    fetch(SUMMARY_URL, { cache: 'no-store' }),
    fetch(INCIDENTS_URL, { cache: 'no-store' }),
  ]);
  const summary = await summaryRes.json();
  const incidentsData = await incidentsRes.json();

  const ind = summary.status?.indicator || 'none';
  const desc = summary.status?.description || '';
  const level = levelFromIndicator(ind);

  const dot = document.getElementById('hero-dot');
  dot.className = 'status-dot ' + level;
  document.getElementById('hero-title').textContent = desc || ind;
  document.getElementById('hero-sub').textContent =
    'Mis à jour ' + new Date(summary.page?.updated_at || Date.now()).toLocaleString();
  document.getElementById('updated').textContent = new Date().toLocaleString();

  const components = (summary.components || []).filter((c) => !c.group);
  const counts = { operational: 0, degraded_performance: 0, partial_outage: 0, major_outage: 0, other: 0 };
  for (const c of components) {
    if (counts[c.status] != null) counts[c.status]++;
    else counts.other++;
  }

  const compEl = document.getElementById('components');
  compEl.innerHTML = components
    .map((c) => {
      const lv = levelFromComponent(c.status);
      return (
        '<div class="component-row">' +
        '<span class="component-name">' +
        escapeHtml(c.name) +
        '</span>' +
        '<span class="badge ' +
        lv +
        ' component-status">' +
        escapeHtml(labelStatus(c.status)) +
        '</span></div>'
      );
    })
    .join('');

  const incidents = (incidentsData.incidents || []).slice(0, 12);
  const incEl = document.getElementById('incidents');
  if (!incidents.length) {
    incEl.innerHTML = '<div class="empty">Aucun incident récent.</div>';
  } else {
    incEl.innerHTML = incidents
      .map((inc) => {
        return (
          '<div class="incident">' +
          '<div style="font-weight:700;margin-bottom:0.25rem"><a href="' +
          escapeHtml(inc.shortlink || '#') +
          '" target="_blank" rel="noopener">' +
          escapeHtml(inc.name) +
          '</a></div>' +
          '<div class="card-meta">Impact: ' +
          escapeHtml(inc.impact || '—') +
          ' · Status: ' +
          escapeHtml(inc.status || '—') +
          ' · ' +
          escapeHtml(new Date(inc.created_at).toLocaleString()) +
          '</div></div>'
        );
      })
      .join('');
  }

  // Charts
  const ctx1 = document.getElementById('chartStatus');
  new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: ['Operational', 'Degraded', 'Partial outage', 'Major outage', 'Other'],
      datasets: [
        {
          data: [
            counts.operational,
            counts.degraded_performance,
            counts.partial_outage,
            counts.major_outage,
            counts.other,
          ],
          backgroundColor: ['#23a559', '#f0b232', '#eb7c3e', '#ed4245', '#6b7280'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9aa0b0', boxWidth: 12 } },
      },
      maintainAspectRatio: false,
    },
  });

  const impactCount = { none: 0, minor: 0, major: 0, critical: 0 };
  for (const inc of incidents) {
    const k = inc.impact || 'none';
    if (impactCount[k] != null) impactCount[k]++;
    else impactCount.none++;
  }

  const ctx2 = document.getElementById('chartImpact');
  new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: ['None', 'Minor', 'Major', 'Critical'],
      datasets: [
        {
          label: 'Incidents',
          data: [impactCount.none, impactCount.minor, impactCount.major, impactCount.critical],
          backgroundColor: ['#5865f2', '#f0b232', '#eb7c3e', '#ed4245'],
          borderRadius: 8,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#9aa0b0' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: {
          beginAtZero: true,
          ticks: { color: '#9aa0b0', stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
      maintainAspectRatio: false,
    },
  });
}

main().catch((e) => {
  document.getElementById('hero-title').textContent = 'Erreur de chargement';
  document.getElementById('hero-sub').textContent = String(e.message || e);
});
