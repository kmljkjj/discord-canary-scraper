const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const metaEl = document.getElementById('meta');
const updatedEl = document.getElementById('updated');

let items = [];
let filter = 'all';

const TYPE_MAP = {
  0: 'avatar_decoration',
  1: 'profile_effect',
  2: 'nameplate',
  3: 'profile_frame',
  1000: 'bundle',
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function assetUrl(item) {
  if (item.image) return item.image;
  if (item.asset) {
    // avatar decoration presets
    if (item.type === 'avatar_decoration' || item.typeKey === 0) {
      return `https://cdn.discordapp.com/avatar-decoration-presets/${item.asset}.png?size=160`;
    }
    if (item.asset.startsWith('http')) return item.asset;
    return `https://cdn.discordapp.com/assets/collectibles/${item.asset}`;
  }
  return null;
}

function normalizeShop(data) {
  const out = [];
  if (Array.isArray(data?.items)) {
    for (const it of data.items) out.push(it);
  }
  // collectibles-categories shape
  const cats = data?.categories || data;
  if (Array.isArray(cats)) {
    for (const cat of cats) {
      const products = cat.products || cat.items || [];
      for (const p of products) {
        const typeKey = p.type ?? p.product_type;
        const type = TYPE_MAP[typeKey] || p.type_name || 'other';
        const name =
          p.name ||
          p.title ||
          p.summary ||
          p.sku_id ||
          'Item';
        const asset =
          p.items?.[0]?.asset ||
          p.asset ||
          p.styles?.[0]?.asset ||
          null;
        const price =
          p.prices?.[0]?.amount != null
            ? (p.prices[0].amount / 100).toFixed(2) + ' ' + (p.prices[0].currency || '')
            : p.price_label || null;
        out.push({
          id: p.sku_id || p.id || name,
          name,
          type,
          typeKey,
          asset,
          image: p.image || null,
          price,
          category: cat.name || cat.title || null,
        });
      }
    }
  }
  return out;
}

async function loadShop() {
  const urls = [
    './data/shop.json',
    'https://raw.githubusercontent.com/kmljkjj/discord-canary-scraper/main/docs/data/shop.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url + (url.startsWith('http') ? '?t=' + Date.now() : ''), {
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      const list = normalizeShop(data);
      if (list.length) return { list, scrapedAt: data.scrapedAt || null };
    } catch {}
  }
  // Demo showcase if no data yet (styled placeholders using public CDN patterns)
  return {
    list: [
      {
        id: 'demo-1',
        name: 'Ajoute data/shop.json',
        type: 'avatar_decoration',
        asset: null,
        price: '—',
        category: 'Setup',
      },
    ],
    scrapedAt: null,
    demo: true,
  };
}

function matches(it, q) {
  if (!q) return true;
  return [it.name, it.type, it.category, it.id].join(' ').toLowerCase().includes(q);
}

function typeOk(it) {
  if (filter === 'all') return true;
  return (it.type || '') === filter;
}

function render() {
  const q = (searchInput.value || '').trim().toLowerCase();
  const list = items.filter((it) => typeOk(it) && matches(it, q));
  metaEl.textContent = list.length + ' items';

  if (!list.length) {
    grid.innerHTML =
      '<div class="empty">Aucun item.<br/>Lance un scrape boutique ou ajoute <code>docs/data/shop.json</code>.</div>';
    return;
  }

  grid.innerHTML = list
    .map((it, i) => {
      const img = assetUrl(it);
      return (
        '<article class="card shop-card" style="--accent:var(--pink);animation-delay:' +
        Math.min(i, 30) * 0.015 +
        's">' +
        '<div class="shop-preview">' +
        (img
          ? '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'" />'
          : '<span style="font-size:2rem">✦</span>') +
        '</div>' +
        '<div class="shop-name">' +
        escapeHtml(it.name) +
        '</div>' +
        '<div class="tag-row" style="justify-content:center">' +
        '<span class="badge shop">' +
        escapeHtml(it.type || 'item') +
        '</span></div>' +
        (it.price ? '<div class="shop-price">' + escapeHtml(it.price) + '</div>' : '') +
        '</article>'
      );
    })
    .join('');
}

document.querySelectorAll('#filters .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filters .chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

searchInput.addEventListener('input', render);

(async function init() {
  const data = await loadShop();
  items = data.list;
  document.getElementById('stat-items').textContent = items.length;
  const cats = new Set(items.map((i) => i.category).filter(Boolean));
  document.getElementById('stat-cats').textContent = cats.size || '—';
  if (data.scrapedAt) updatedEl.textContent = 'Updated ' + new Date(data.scrapedAt).toLocaleString();
  if (data.demo) {
    metaEl.textContent = 'Mode démo — ajoute docs/data/shop.json pour la vraie boutique';
  }
  render();
})();
