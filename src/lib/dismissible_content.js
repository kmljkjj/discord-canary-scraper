'use strict';
const fs = require('fs-extra');
const path = require('path');
const STATE = 'dismissible_content.json';

// Discord compile l'enum TypeScript DismissibleContent en :
//   ((i={})[i.DISMISSIBLE_CONTENT_UNSPECIFIED=0]="DISMISSIBLE_CONTENT_UNSPECIFIED",
//    i[i.HUB_EVENT_HEADER_UPSELL=2]="HUB_EVENT_HEADER_UPSELL", ...)
// On s'ancre sur le premier membre (unique dans le bundle) puis on lit les
// membres contigus avec une regex « sticky » : O(taille de l'enum), aucun
// faux positif venant d'autres enums.
const DC_ANCHOR = 'DISMISSIBLE_CONTENT_UNSPECIFIED=0]';

function escapeRe(x) {
  return x.replace(/[$]/g, '\\$');
}

function extractDismissibleContent(content, out) {
  if (!content || !out) return 0;
  // L'enum est unique : s'il a déjà été trouvé (bundle web.*), inutile de
  // rescanner les chunks secondaires.
  for (const k in out) if (Object.prototype.hasOwnProperty.call(out, k)) return 0;
  let from = 0;
  let total = 0;
  for (;;) {
    const at = content.indexOf(DC_ANCHOR, from);
    if (at < 0) break;
    from = at + DC_ANCHOR.length;
    // 1er membre : « (i={})[i.X=0] » ou « i[i.X=0] » → variable « i »
    const head = content.slice(Math.max(0, at - 80), at);
    const vm = /(?:\(([A-Za-z_$][\w$]*)=\{\}\)|([A-Za-z_$][\w$]*))\[([A-Za-z_$][\w$]*)\.$/.exec(head);
    if (!vm || (vm[1] || vm[2]) !== vm[3]) continue;
    const v = escapeRe(vm[3]);
    const re = new RegExp(
      '(?:\\(' + v + '=\\{\\}\\)|' + v + ')\\[' + v + '\\.([A-Za-z_$][\\w$]*)=(-?\\d+)\\]="[^"]*"',
      'y',
    );
    re.lastIndex = at - vm[0].length;
    const found = {};
    let n = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      found[m[1]] = Number(m[2]);
      n++;
      if (content.charCodeAt(re.lastIndex) !== 44) break; // ','
      re.lastIndex++;
    }
    if (n >= 10) {
      delete found.DISMISSIBLE_CONTENT_UNSPECIFIED;
      Object.assign(out, found);
      total += n;
    }
  }
  return total;
}

function diffDismissible(cur, prev) {
  const added = {}, removed = {}, modified = {};
  cur = cur || {};
  prev = prev || {};
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in prev)) added[k] = v;
    else if (Number(prev[k]) !== Number(v)) modified[k] = { from: prev[k], to: v };
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in cur)) removed[k] = v;
  }
  return { added, removed, modified };
}

async function loadState(dataDir) {
  const fp = path.join(dataDir, STATE);
  try {
    if (!(await fs.pathExists(fp))) return { data: {} };
    const raw = await fs.readJson(fp);
    return { data: (raw && raw.data) || {}, buildNumber: raw.buildNumber };
  } catch {
    return { data: {} };
  }
}

async function saveState(dataDir, data, buildNumber) {
  const fp = path.join(dataDir, STATE);
  const tmp = fp + '.tmp';
  await fs.writeJson(tmp, {
    updatedAt: new Date().toISOString(),
    buildNumber: buildNumber != null ? String(buildNumber) : null,
    count: Object.keys(data || {}).length,
    data: data || {},
  }, { spaces: 2 });
  await fs.move(tmp, fp, { overwrite: true });
}

async function notifyDismissible({ webhookUrl, buildNumber, diff }) {
  // require tardif : évite tout cycle de chargement notify ↔ extract
  const { sendDismissible } = require('./notify');
  return sendDismissible(webhookUrl, buildNumber, diff);
}

async function processDismissibleContent({ dataDir, current, buildNumber, webhookUrl, isSeed }) {
  const cur = current || {};
  const count = Object.keys(cur).length;
  const prevState = await loadState(dataDir);
  const prev = prevState.data || {};
  const prevCount = Object.keys(prev).length;
  console.log('Dismissible Content extracted:', count, '| previous:', prevCount);
  if (count < 10) {
    console.log('Dismissible Content: too few — skip');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }
  const diff = diffDismissible(cur, prev);
  const nAdd = Object.keys(diff.added).length;
  const nRem = Object.keys(diff.removed).length;
  const nMod = Object.keys(diff.modified).length;
  if (prevCount >= 30 && nRem > prevCount * 0.5 && nAdd < 5) {
    console.warn('Dismissible Content: mass removal — skip');
    return { notified: false, diff: { added: {}, removed: {}, modified: {} }, count };
  }
  let notified = false;
  if (!isSeed && prevCount >= 10 && (nAdd || nRem || nMod)) {
    if (!webhookUrl) {
      console.log('Dismissible Content: no webhook — baseline updated');
      await saveState(dataDir, cur, buildNumber);
      return { notified: false, diff, count };
    }
    console.log('Dismissible Content diff', { added: nAdd, removed: nRem, modified: nMod });
    notified = await notifyDismissible({ webhookUrl, buildNumber, diff });
  } else {
    console.log('Dismissible Content: seeding baseline', count);
  }
  // Échec d'envoi → on NE met PAS à jour la baseline : le run suivant réessaie
  // (la dedupe empêche tout doublon des parties déjà postées).
  if (!isSeed && prevCount >= 10 && (nAdd || nRem || nMod) && !notified) {
    console.warn('Dismissible Content: webhook failed — baseline kept for retry');
    return { notified, diff, count };
  }
  await saveState(dataDir, cur, buildNumber);
  return { notified, diff, count };
}

module.exports = {
  extractDismissibleContent,
  diffDismissible,
  loadState,
  saveState,
  notifyDismissible,
  processDismissibleContent,
};
