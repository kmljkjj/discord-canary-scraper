/**
 * Extract UI symbols + experiments from Discord asset JS.
 */

function kindFromName(name) {
  const n = String(name || '');
  if (/Modal$/i.test(n)) return 'modal';
  if (/Popout$/i.test(n)) return 'popout';
  if (/(Sheet|BottomSheet)$/i.test(n)) return 'sheet';
  if (/(Page|Screen)$/i.test(n)) return 'page';
  if (/(Panel|Sidebar)$/i.test(n)) return 'panel';
  if (/(Button|Btn)$/i.test(n)) return 'button';
  if (/(Menu|ContextMenu)$/i.test(n)) return 'menu';
  if (/(Banner|Notice|Toast)$/i.test(n)) return 'notice';
  return 'component';
}

function extractUiAndExperiments(content) {
  const experiments = new Map();
  const ui = new Map();

  // experiment ids like 2026-07-desktop-channel-tabs
  const expRe =
    /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,80})["']/gi;
  let m;
  while ((m = expRe.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (!experiments.has(id)) {
      experiments.set(id, {
        id,
        kind: /guild|server/i.test(id) ? 'guild' : 'user',
        type: /guild|server/i.test(id) ? 'guild' : 'user',
        treatments: [{ id: 0 }, { id: 1 }],
        isApex: /apex|_aa_|-aa-|holdout/i.test(id),
        aaMode: /_aa_|-aa-|holdout/i.test(id),
        relatedUI: [],
      });
    }
  }

  // treatment / variation counts near experiment definitions
  const treatBlock =
    /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80})["'][\s\S]{0,400}?treatments\s*:\s*\[([\s\S]{0,800}?)\]/gi;
  while ((m = treatBlock.exec(content)) !== null) {
    const id = m[1];
    if (!experiments.has(id)) continue;
    const body = m[2] || '';
    const ids = [...body.matchAll(/["']?id["']?\s*:\s*(\d+)/g)].map((x) => Number(x[1]));
    const labels = [...body.matchAll(/["']label["']\s*:\s*["']([^"']+)["']/g)].map((x) => x[1]);
    if (ids.length) {
      const exp = experiments.get(id);
      exp.treatments = ids.map((tid, i) => ({
        id: tid,
        label: labels[i] || null,
      }));
    }
  }

  // UI-ish PascalCase component names
  const uiRe =
    /\b([A-Z][a-zA-Z0-9]{2,}(?:Modal|Popout|Sheet|Panel|Page|Screen|Banner|Notice|Toast|Menu|Button))\b/g;
  while ((m = uiRe.exec(content)) !== null) {
    const name = m[1];
    if (name.length > 60) continue;
    if (!ui.has(name)) {
      ui.set(name, {
        name,
        kind: kindFromName(name),
        relatedExperiments: [],
      });
    }
  }

  // link experiments ↔ nearby UI names (window of text)
  const uiList = [...ui.keys()];
  for (const exp of experiments.values()) {
    const related = new Set();
    const re = new RegExp(
      `.{0,200}${exp.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,200}`,
      'gi',
    );
    let wm;
    while ((wm = re.exec(content)) !== null) {
      const win = wm[0];
      for (const name of uiList) {
        if (win.includes(name)) related.add(name);
      }
    }
    exp.relatedUI = [...related].slice(0, 10);
  }

  for (const u of ui.values()) {
    const related = [];
    for (const exp of experiments.values()) {
      if ((exp.relatedUI || []).includes(u.name)) related.push(exp.id);
    }
    u.relatedExperiments = related.slice(0, 8);
  }

  return {
    experiments: [...experiments.values()],
    ui: [...ui.values()],
  };
}

function formatNewUiDescription(newUI, buildNumber) {
  const lines = [];
  const sorted = [...newUI].sort((a, b) => {
    const ae = (a.relatedExperiments || []).length;
    const be = (b.relatedExperiments || []).length;
    if (be !== ae) return be - ae;
    return a.name.localeCompare(b.name);
  });

  for (const u of sorted.slice(0, 30)) {
    lines.push(`+ \`${u.name}\` (**${u.kind}**)`);
    const exps = u.relatedExperiments || [];
    if (exps.length) {
      lines.push(`  → experiment: \`${exps.slice(0, 3).join('`, `')}\``);
    }
  }
  lines.push('');
  lines.push(`**Build Id** — ${buildNumber}`);
  return lines.join('\n');
}

/**
 * Discord embed for a newly detected experiment.
 * Matches the channel style the user requested.
 */
function formatExperimentWithUi(exp, buildNumber) {
  const isApex = !!(exp.isApex || exp.aaMode);
  const type = exp.kind || exp.type || 'user';
  const treatments = exp.treatments && exp.treatments.length
    ? exp.treatments
    : [{ id: 0 }, { id: 1 }];

  const lines = [
    '**Name**',
    String(exp.id),
    '**Type** ' + type,
    '**Variations**',
  ];
  for (const t of treatments.slice(0, 12)) {
    const label = t.label ? ` — ${t.label}` : '';
    lines.push(`Variation ${t.id}${label}`);
  }
  lines.push(`**Build:** ${buildNumber}`);
  if ((exp.relatedUI || []).length) {
    lines.push(
      '**UI:** ' + exp.relatedUI.slice(0, 6).map((n) => '`' + n + '`').join(', '),
    );
  }

  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    description: lines.join('\n'),
    color: isApex ? 0xfee75c : 0xeb459e,
    timestamp: new Date().toISOString(),
    footer: { text: 'Canary · experiments' },
  };
}

module.exports = {
  extractUiAndExperiments,
  formatNewUiDescription,
  formatExperimentWithUi,
  kindFromName,
};
