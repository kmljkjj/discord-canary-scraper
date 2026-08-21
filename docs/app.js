/**
 * Experiments gallery — loads findings from the scraper repo
 */
const DATA_URLS = [
  // Same-origin when data is published under docs/
  './data/findings.json',
  // Fallback: live raw from GitHub main
  'https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/data/findings.json',
];

const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const metaEl = document.getElementById('meta');
const updatedEl = document.getElementById('updated');

let all = [];
let filter = 'all';

async function loadData() {
  let lastErr;
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url + (url.startsWith('http') ? '?t=' + Date.now() : ''), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(res.status + ' ' + url);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No data');
}

function normalize(raw) {
  const list = Array.isArray(raw?.experiments) ? raw.experiments : Array.isArray(raw) ? raw : [];
  return list.map((e) => ({
    id: e.id || e.name || 'unknown',
    type: (e.type || 'unknown').toLowerCase(),
    isApex: !!(e.isApex || e.apex || /apex/i.test(e.type || '')),
    relatedUI: e.relatedUI || e.related_ui || [],
    variations: e.variations || e.treatments || null,
  }));
}

function matches(exp, q) {
  if (!q) return true;
  const hay = [exp.id, exp.type, ...(exp.relatedUI || [])].join(' ').toLowerCase();
  return hay.includes(q);
}

function typeOk(exp) {
  if (filter === 'all') return true;
  if (filter === 'apex') return exp.isApex;
  if (filter === 'user') return exp.type === 'user' || exp.type === 'user_experiment';
  if (filter === 'guild') return exp.type === 'guild' || exp.type === 'guild_experiment';
  return true;
}

function accentFor(exp) {
  if (exp.isApex) return 'var(--pink)';
  if (exp.type === 'guild' || exp.type === 'guild_experiment') return 'var(--green)';
  return 'var(--blurple)';
}

function render() {
  const q = (searchInput.value || '').trim().toLowerCase();
  const list = all.filter((e) => typeOk(e) && matches(e, q));

  metaEl.textContent = list.length + ' / ' + all.length + ' experiments';

  if (!list.length) {
    grid.innerHTML = '<div class="empty">Aucun experiment trouvé.</div>';
    return;
  }

  grid.innerHTML = list
    .map((exp, i) => {
      const badges = [];
      const t = exp.type.includes('guild') ? 'guild' : exp.type.includes('user') ? 'user' : 'unknown';
      badges.push('<span class="badge ' + t + '">' + t + '</span>');
      if (exp.isApex) badges.push('<span class="badge apex">apex</span>');

      const ui =
        exp.relatedUI && exp.relatedUI.length
          ? '<div class="ui-list">' +
            exp.relatedUI
              .slice(0, 6)
              .map((u) => '<span class="ui-tag">' + escapeHtml(String(u)) + '</span>')
              .join('') +
            '</div>'
          : '';

      return (
        '<article class="card" style="--accent:' +
        accentFor(exp) +
        ';animation-delay:' +
        Math.min(i, 24) * 0.02 +
        's">' +
        '<div class="card-top"><div class="badges">' +
        badges.join('') +
        '</div></div>' +
        '<div class="card-id">' +
        escapeHtml(exp.id) +
        '</div>' +
        '<div class="card-meta">' +
        (exp.variations != null
          ? '<span>Variations / treatments: ' + escapeHtml(String(exp.variations)) + '</span>'
          : '') +
        '</div>' +
        ui +
        '</article>'
      );
    })
    .join('');
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateStats() {
  const total = all.length;
  const user = all.filter((e) => e.type.includes('user')).length;
  const guild = all.filter((e) => e.type.includes('guild')).length;
  const apex = all.filter((e) => e.isApex).length;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-user').textContent = user;
  document.getElementById('stat-guild').textContent = guild;
  document.getElementById('stat-apex').textContent = apex;
}

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

searchInput.addEventListener('input', () => render());

(async function init() {
  try {
    const data = await loadData();
    all = normalize(data).sort((a, b) => b.id.localeCompare(a.id));
    updateStats();
    if (data.scrapedAt) {
      updatedEl.textContent = 'Updated ' + new Date(data.scrapedAt).toLocaleString();
    }
    render();
  } catch (e) {
    metaEl.textContent = 'Erreur de chargement';
    grid.innerHTML =
      '<div class="empty">Impossible de charger <code>findings.json</code>.<br/>Lance un scrape puis réessaie.<br/><small>' +
      escapeHtml(String(e.message || e)) +
      '</small></div>';
  }
})();
