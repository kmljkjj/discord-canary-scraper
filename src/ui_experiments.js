/**
 * Link UI component names to nearby experiment IDs in Discord client JS.
 * Static analysis only — cannot know if a user has the experiment activated.
 */

const UI_SUFFIX =
  'Modal|Panel|Popout|Drawer|Sheet|Sidebar|Overlay|TabBar|Tooltip|Banner|Card|Dialog|Menu|Picker|Coachmark|Nudge|Pill|Chip|Badge|Tray|Spotlight|Notice|Toast|Row|Header|Footer|Button|View|Screen|Page|Section|Container|Wrapper|List|Item|Tile|Grid|Stack|Form|Field|Input|Select|Toggle|Switch|Slider|Stepper|Tabs|Tab|Nav|Navbar|SidebarItem';

function kindFromName(name) {
  if (/Modal|Dialog/i.test(name)) return 'modal';
  if (/Panel|Sidebar|Drawer|Sheet|Tray/i.test(name)) return 'panel';
  if (/Popout|Overlay|Tooltip|Spotlight/i.test(name)) return 'overlay';
  if (/Banner|Notice|Toast|Nudge|Coachmark/i.test(name)) return 'notice';
  if (/Menu|Picker|Select/i.test(name)) return 'menu';
  if (/Tab|Nav/i.test(name)) return 'nav';
  return 'component';
}

function isExpId(id) {
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

/**
 * Extract UI components + experiments and link them when they appear close in source.
 */
function extractUiAndExperiments(content) {
  const experiments = new Map();
  const ui = new Map();

  const idRe = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80})["']/gi;
  let m;
  while ((m = idRe.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isExpId(id)) continue;
    if (!experiments.has(id)) {
      experiments.set(id, {
        id,
        type: /guild/i.test(id) ? 'guild' : 'user',
        isApex: /apex|_aa_|-aa-/i.test(id),
        relatedUI: [],
      });
    }
  }

  const uiRe = new RegExp(
    `["']([A-Z][A-Za-z0-9]*(?:${UI_SUFFIX}))["']`,
    'g',
  );
  while ((m = uiRe.exec(content)) !== null) {
    const name = m[1];
    if (name.length < 5 || name.length > 80) continue;
    // skip noise
    if (/^(HTML|SVG|CSS|XML|JSON|URL|API|ID)/.test(name)) continue;
    if (!ui.has(name)) {
      ui.set(name, {
        name,
        kind: kindFromName(name),
        relatedExperiments: [],
      });
    }
  }

  // Link: experiment ID window ↔ UI names
  const uiList = [...ui.keys()];
  for (const exp of experiments.values()) {
    const re = new RegExp(
      exp.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'gi',
    );
    const related = new Set();
    let hit;
    let guards = 0;
    while ((hit = re.exec(content)) !== null && guards < 30) {
      guards++;
      const start = Math.max(0, hit.index - 1800);
      const end = Math.min(content.length, hit.index + exp.id.length + 1800);
      const win = content.slice(start, end);
      for (const name of uiList) {
        if (win.includes(`"${name}"`) || win.includes(`'${name}'`) || win.includes(name)) {
          related.add(name);
        }
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
  // Prioritize UI linked to experiments
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

function formatExperimentWithUi(exp, buildNumber) {
  const isApex = exp.isApex || exp.aaMode;
  const type = exp.kind || exp.type || 'user';
  const variants = (exp.treatments || []).length
    ? exp.treatments.map((t) => `* Variant ${t.id}${t.label ? ` — ${t.label}` : ''}`)
    : ['* Variant 0', '* Variant 1'];
  const lines = [
    `+ \`${exp.id}\` (**${type}**)`,
    ...variants.slice(0, 8),
    `Type: **${type}**`,
    `Build: **${buildNumber}**`,
  ];
  if ((exp.relatedUI || []).length) {
    lines.push(`UI: ${exp.relatedUI.slice(0, 6).map((n) => `\`${n}\``).join(', ')}`);
  }
  return {
    title: isApex ? 'New Apex Experiment' : 'New Experiment',
    description: lines.join('\n'),
    color: isApex ? 0xfee75c : 0xeb459e,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  extractUiAndExperiments,
  formatNewUiDescription,
  formatExperimentWithUi,
  kindFromName,
};
