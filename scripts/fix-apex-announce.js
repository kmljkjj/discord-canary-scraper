#!/usr/bin/env node
/**
 * Harden apex_rollouts.js for trigger-apex-rollouts:
 * - announce keys only after successful webhook
 * - stable pctKey (rounded %)
 * - default MIN_DELTA 2
 */
const fs = require('fs');
const p = process.argv[2] || 'src/apex_rollouts.js';
let t = fs.readFileSync(p, 'utf8');
let n = 0;

function once(old, neu, label) {
  if (!t.includes(old)) {
    console.warn('skip (missing):', label);
    return false;
  }
  t = t.replace(old, neu);
  n++;
  console.log('ok', label);
  return true;
}

once(
  "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '0.5');",
  "const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '2');",
  'min-delta-2'
);

const oldPct = `function pctKey(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => String(t.bucket ?? t.label) + ':' + Number(t.pct).toFixed(1))
    .sort()
    .join('|');
}`;
const newPct = `function pctKey(e) {
  // Stable % fingerprint only — rounded to 0.1
  return (e.treatments || [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => {
      const b = t.bucket != null ? String(t.bucket) : String(t.label || '');
      const p = (Math.round(Number(t.pct) * 10) / 10).toFixed(1);
      return b + ':' + p;
    })
    .sort()
    .join('|');
}`;
once(oldPct, newPct, 'pctKey');

const oldAnnounce = `  // Mark announced for everything we are about to send + current state
  for (const e of compact) {
    if (e.id && e.fingerprint) announced[e.id] = e.fingerprint;
  }
  for (const e of diff.added) {
    if (e && e.id) announced[e.id] = pctKey(e);
  }
  for (const c of diff.changed) {
    if (c && c.after && c.after.id) announced[c.after.id] = pctKey(c.after);
  }
  for (const e of diff.removed) {
    if (e && e.id) announced[e.id] = 'REMOVED';
  }

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      sources,
      count: compact.length,
      experiments: compact,
      announced,
    },
    { spaces: 2 },
  );

  if (isFirst) {
    console.log('Seed', compact.length, '· recent', sources.recent, '· no notify');
    return;
  }
  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    console.log('No significant % change (anti-spam)');
    return;
  }
  if (!WEBHOOK) {
    console.warn('No webhook');
    return;
  }
  const sent = await postWebhook(buildEmbeds(diff, { sources }));
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  console.log('✅ Done');
}`;

const neu = `  // Baseline fingerprints from current scrape (for next-run diff)
  // Do NOT lock notify-candidates as announced until webhook succeeds.
  for (const e of compact) {
    if (e.id && e.fingerprint) announced[e.id] = e.fingerprint;
  }

  async function writeState() {
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        sources,
        count: compact.length,
        experiments: compact,
        announced,
      },
      { spaces: 2 },
    );
  }

  if (isFirst) {
    await writeState();
    console.log('Seed', compact.length, '· recent', sources.recent, '· no notify');
    return;
  }
  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    await writeState();
    console.log('No significant % change (anti-spam)');
    return;
  }
  if (!WEBHOOK) {
    await writeState();
    console.warn('No webhook');
    return;
  }

  const embeds = buildEmbeds(diff, { sources });
  if (!embeds.length) {
    await writeState();
    console.log('No embeds after build');
    return;
  }

  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (sent.ok) {
    for (const e of diff.added) {
      if (e && e.id) announced[e.id] = pctKey(e);
    }
    for (const c of diff.changed) {
      if (c && c.after && c.after.id) announced[c.after.id] = pctKey(c.after);
    }
    for (const e of diff.removed) {
      if (e && e.id) announced[e.id] = 'REMOVED';
    }
  } else {
    console.warn('Webhook failed — not marking announced (will retry next run)');
  }

  await writeState();
  console.log(sent.ok ? '✅ Done' : '⚠️ Done with webhook error');
}`;

if (t.includes(oldAnnounce)) {
  t = t.replace(oldAnnounce, neu);
  n++;
  console.log('ok safe-announce');
} else if (t.includes('not marking announced')) {
  console.log('safe-announce already present');
} else {
  console.error('FAILED: announce block not found');
  process.exit(1);
}

if (t.includes("Apex rollouts v4.4 (multi-token")) {
  t = t.replace(
    "console.log('📊 Apex rollouts v4.4 (multi-token + anti-spam)…');",
    "console.log('📊 Apex rollouts v4.5.1 (trigger-apex fixes)…');"
  );
  n++;
}
if (t.includes('Apex rollouts v4.5 —')) {
  t = t.replace(
    /Apex rollouts v4\.5[^\n]*/,
    'Apex rollouts v4.5.1 — crowd + safe announce (trigger-apex-rollouts fixes)'
  );
}

fs.writeFileSync(p, t);
console.log('wrote', p, 'patches', n);
