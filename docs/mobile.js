/**
 * Mobile versions page — loads data from the scraper repo.
 * Shows iOS (stable + beta) and Android (stable + beta + alpha) versions.
 */
const DATA_BASE = 'https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/data/';
const DATA_FALLBACK = './data/';

const channelColors = {
  stable: { bg: 'var(--green-soft)', fg: '#6ddf9a', dot: 'var(--green)' },
  beta:   { bg: 'var(--orange-soft)', fg: '#f5d489', dot: 'var(--orange)' },
  alpha:  { bg: 'var(--red-soft)', fg: '#f5a3a5', dot: 'var(--red)' },
};

const platformLabels = {
  ios: { name: 'iOS', icon: '🍎', store: 'App Store' },
  android: { name: 'Android', icon: '🤖', store: 'Play Store' },
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

async function loadJson(filename) {
  const urls = [
    DATA_BASE + filename + '?t=' + Date.now(),
    DATA_FALLBACK + filename,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status + ' ' + url);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No data for ' + filename);
}

function versionCard(channel) {
  const cc = channelColors[channel.channel] || channelColors.stable;
  const plat = platformLabels[channel.platform] || { name: channel.platform, icon: '📱', store: '' };
  const available = channel.available !== false && channel.version;
  const version = available ? channel.version : 'N/A';
  const build = channel.build ? `<div class="vc-build">Build <code>${escapeHtml(channel.build)}</code></div>` : '';
  const commit = channel.commit ? `<div class="vc-commit">Commit <code>${escapeHtml(String(channel.commit).slice(0, 12))}</code></div>` : '';
  const releaseName = channel.releaseName ? `<div class="vc-release">${escapeHtml(channel.releaseName)}</div>` : '';
  const releaseDate = channel.releaseDate ? `<div class="vc-date">Publié le ${fmtDate(channel.releaseDate)}</div>` : '';
  const notes = channel.releaseNotes ? `<details class="vc-notes"><summary>Notes de version</summary><p>${escapeHtml(channel.releaseNotes)}</p></details>` : '';
  const note = channel.note ? `<div class="vc-note">${escapeHtml(channel.note)}</div>` : '';
  const storeUrl = channel.storeUrl ? `<a href="${escapeHtml(channel.storeUrl)}" target="_blank" rel="noopener" class="vc-store">${escapeHtml(plat.store)}</a>` : '';
  const source = channel.source ? `<span class="vc-source">${escapeHtml(channel.source)}</span>` : '';

  return (
    `<div class="version-card ${available ? '' : 'unavailable'}" style="--accent: ${cc.dot}">` +
    `<div class="vc-top">` +
    `<span class="vc-platform">${plat.icon} ${escapeHtml(plat.name)}</span>` +
    `<span class="vc-channel" style="background:${cc.bg};color:${cc.fg}">${escapeHtml(channel.channel)}</span>` +
    `</div>` +
    `<div class="vc-version">${escapeHtml(version)}</div>` +
    build + commit + releaseName + releaseDate + note + notes +
    `<div class="vc-footer">${storeUrl}${source}</div>` +
    `</div>`
  );
}

function otaCard(entry, platform) {
  const plat = platformLabels[platform] || { name: platform, icon: '📱' };
  return (
    `<div class="ota-card">` +
    `<div class="ota-version">${escapeHtml(entry.version)}</div>` +
    `<div class="ota-platform">${plat.icon} ${escapeHtml(plat.name)}</div>` +
    (entry.build ? `<div class="ota-build">Build <code>${escapeHtml(entry.build)}</code></div>` : '') +
    (entry.commit ? `<div class="ota-commit"><code>${escapeHtml(String(entry.commit).slice(0, 12))}</code></div>` : '') +
    (entry.releaseName ? `<div class="ota-release">${escapeHtml(entry.releaseName)}</div>` : '') +
    `</div>`
  );
}

function changeEntry(change) {
  const arrow = change.from ? `${escapeHtml(change.from)} → <strong>${escapeHtml(change.to)}</strong>` : `<strong>${escapeHtml(change.to)}</strong>`;
  const build = change.build ? ` · build <code>${escapeHtml(change.build)}</code>` : '';
  return (
    `<div class="change-row">` +
    `<span class="change-key">${escapeHtml(change.key)}</span>` +
    `<span class="change-version">${arrow}${build}</span>` +
    `<span class="change-date">${fmtDate(change.at)}</span>` +
    `</div>`
  );
}

function renderStats(data) {
  const channels = data.channels || [];
  const available = channels.filter((c) => c.available !== false && c.version);
  const total = channels.length;
  const iosCount = channels.filter((c) => c.platform === 'ios').length;
  const androidCount = channels.filter((c) => c.platform === 'android').length;

  document.getElementById('stats').innerHTML = [
    { val: available.length, label: 'Disponibles' },
    { val: total - available.length, label: 'Indisponibles' },
    { val: iosCount, label: 'iOS' },
    { val: androidCount, label: 'Android' },
  ].map((s) =>
    `<div class="stat"><span class="stat-val">${s.val}</span><span class="stat-label">${s.label}</span></div>`
  ).join('');
}

function renderMobileExpInfo(expData) {
  const el = document.getElementById('mobile-exp-info');
  if (!expData || !expData.experiments) {
    el.innerHTML = '<div class="empty">Données mobiles non disponibles (MOBILE_DATAMINE_REPO requis).</div>';
    return;
  }
  const exps = expData.experiments || [];
  const strings = Object.keys(expData.strings || {});
  const userCount = exps.filter((e) => e.type === 'user').length;
  const guildCount = exps.filter((e) => e.type === 'guild').length;

  const stats = [
    { val: exps.length, label: 'Experiments' },
    { val: userCount, label: 'User' },
    { val: guildCount, label: 'Guild' },
    { val: strings.length, label: 'Strings' },
  ];

  const meta = [
    expData.sourceCommit ? `Commit <code>${escapeHtml(expData.sourceCommit)}</code>` : '',
    expData.sourceMessage ? escapeHtml(expData.sourceMessage) : '',
    expData.scrapedAt ? `Scrapé ${fmtDate(expData.scrapedAt)}` : '',
  ].filter(Boolean).join(' · ');

  el.innerHTML =
    `<div class="stats" style="margin-bottom:1rem">` +
    stats.map((s) => `<div class="stat"><span class="stat-val">${s.val}</span><span class="stat-label">${s.label}</span></div>`).join('') +
    `</div>` +
    `<div class="card-meta">${meta}</div>`;
}

async function main() {
  document.getElementById('updated').textContent = new Date().toLocaleString('fr-FR');

  // Load versions data
  let versionData;
  try {
    versionData = await loadJson('mobile_versions.json');
  } catch (e) {
    document.getElementById('version-cards').innerHTML =
      '<div class="empty">Impossible de charger les données mobiles.</div>';
    console.error(e);
    return;
  }

  // Render version cards
  const cards = (versionData.channels || [])
    .sort((a, b) => {
      const order = { ios: 0, android: 1 };
      const chOrder = { stable: 0, beta: 1, alpha: 2 };
      const p = (order[a.platform] || 2) - (order[b.platform] || 2);
      if (p !== 0) return p;
      return (chOrder[a.channel] || 3) - (chOrder[b.channel] || 3);
    })
    .map(versionCard)
    .join('');

  document.getElementById('version-cards').innerHTML = cards || '<div class="empty">Aucune donnée.</div>';
  renderStats(versionData);

  // Render OTA history
  const otaIos = (versionData.otaIndex?.ios || []).map((e) => otaCard(e, 'ios')).join('');
  const otaAndroid = (versionData.otaIndex?.android || []).map((e) => otaCard(e, 'android')).join('');
  const otaHtml =
    (otaIos ? `<div class="ota-group"><h3>🍎 iOS</h3><div class="ota-list">${otaIos}</div></div>` : '') +
    (otaAndroid ? `<div class="ota-group"><h3>🤖 Android</h3><div class="ota-list">${otaAndroid}</div></div>` : '') ||
    '<div class="empty">Aucune version OTA trouvée.</div>';
  document.getElementById('ota-history').innerHTML = otaHtml;

  // Render change history
  const history = versionData.history || [];
  if (history.length) {
    document.getElementById('history-section').style.display = '';
    document.getElementById('change-history').innerHTML =
      history.slice(0, 20).map(changeEntry).join('');
  }

  // Load mobile experiments data
  try {
    const expData = await loadJson('mobile_experiments.json');
    renderMobileExpInfo(expData);
  } catch {
    renderMobileExpInfo(null);
  }
}

main().catch((e) => {
  document.getElementById('version-cards').innerHTML =
    '<div class="empty">Erreur: ' + escapeHtml(String(e.message || e)) + '</div>';
});
