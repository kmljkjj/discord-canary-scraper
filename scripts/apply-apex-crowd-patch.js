#!/usr/bin/env node
/**
 * Apply Escoteiros/Wumpus-style crowd hash_result aggregation to apex_rollouts.js
 */
const fs = require('fs');
const p = process.argv[2] || 'src/apex_rollouts.js';
let t = fs.readFileSync(p, 'utf8');
let n = 0;

function rep(old, neu, label) {
  if (!t.includes(old)) {
    console.error('MISSING block:', label);
    process.exit(1);
  }
  t = t.replace(old, neu);
  n++;
  console.log('ok', label);
}

rep(
`        if (!ag) {
          ag = {
            id: e.id,
            hash: e.hash,
            revision: e.revision,
            buckets: new Map(),
            samples: 0,
            recent: e.recent,
            title: e.title,
          };
          userAgg.set(hk, ag);
        }
        if (String(ag.id).startsWith('hash:') && !String(e.id).startsWith('hash:')) ag.id = e.id;
        const b = e.assignedBucket;
        if (b != null) ag.buckets.set(b, (ag.buckets.get(b) || 0) + 1);
        ag.samples++;
        if (e.revision != null) ag.revision = e.revision;
        continue;`,
`        if (!ag) {
          ag = {
            id: e.id,
            hash: e.hash,
            revision: e.revision,
            buckets: new Map(),
            hrs: new Map(),
            samples: 0,
            recent: e.recent,
            title: e.title,
            contributors: [],
          };
          userAgg.set(hk, ag);
        }
        if (String(ag.id).startsWith('hash:') && !String(e.id).startsWith('hash:')) {
          ag.id = e.id;
          ag.title = e.title || e.id;
        }
        const bkt = e.assignedBucket;
        if (bkt != null) {
          ag.buckets.set(bkt, (ag.buckets.get(bkt) || 0) + 1);
          if (e.hashResult != null && Number.isFinite(Number(e.hashResult))) {
            if (!ag.hrs.has(bkt)) ag.hrs.set(bkt, []);
            ag.hrs.get(bkt).push(Number(e.hashResult));
          }
        }
        ag.samples++;
        if (e.revision != null) ag.revision = e.revision;
        continue;`,
'ingest-hrs'
);

rep(
`  // build aggregated user entries (sample % across tokens)
  for (const ag of userAgg.values()) {
    const total = Math.max(1, ag.samples);
    const treatments = [...ag.buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, n]) => ({
        bucket,
        label: tLabel(bucket),
        pct: Math.round((n / total) * 1000) / 10,
        samples: n,
        assigned: true,
      }));
    const fingerprint =
      'user-agg|' +
      treatments.map((t) => t.bucket + ':' + t.pct.toFixed(1)).join(',') +
      '|n:' +
      total +
      '|rev:' +
      ag.revision;
    byKey.set('user:' + (ag.hash != null ? ag.hash : ag.id), {
      id: String(ag.id),
      type: 'user',
      title: String(ag.title || ag.id),
      treatments,
      populations: [],
      overrideIdCount: 0,
      populationCount: 0,
      fingerprint,
      revision: ag.revision,
      hash: ag.hash,
      recent: !!ag.recent,
      source: 'discord-assignment',
      hasGlobalPct: treatments.some((t) => t.pct != null),
      sampleCount: total,
    });
  }`,
`  // build aggregated user entries — crowd method (Escoteiros/Wumpus Apex research)
  for (const ag of userAgg.values()) {
    const total = Math.max(1, ag.samples);
    const treatments = [];
    const bucketKeys = new Set([...ag.buckets.keys(), ...(ag.hrs ? ag.hrs.keys() : [])]);
    for (const bucket of [...bucketKeys].sort((x, y) => x - y)) {
      const n = ag.buckets.get(bucket) || 0;
      const hrs = (ag.hrs && ag.hrs.get(bucket)) || [];
      let pct = Math.round((n / total) * 1000) / 10;
      let range = null;
      if (hrs.length >= 1) {
        const mn = Math.min(...hrs);
        const mx = Math.max(...hrs);
        const start = Math.round(mn / 500) * 500;
        const end = Math.min(SCALE, Math.round(mx / 500) * 500 || mx);
        range = [start, end];
        if (hrs.length >= 2 || total >= 2) {
          const span = Math.max(0, end - start);
          pct = Math.min(100, Math.round((span / SCALE) * 10000) / 100);
        }
        if (hrs.length === 1 && total === 1) pct = null;
      } else if (total < 2) {
        pct = null;
      }
      treatments.push({
        bucket,
        label: tLabel(bucket),
        pct,
        range,
        samples: Math.max(n, hrs.length),
        assigned: true,
      });
    }
    const fingerprint =
      'user-crowd|' +
      treatments
        .map((t) => t.bucket + ':' + (t.pct != null ? Number(t.pct).toFixed(1) : 'x') + (t.range ? '@' + t.range.join('-') : ''))
        .join(',') +
      '|n:' +
      total +
      '|rev:' +
      ag.revision;
    byKey.set('user:' + (ag.hash != null ? ag.hash : ag.id), {
      id: String(ag.id),
      type: 'user',
      title: String(ag.title || ag.id),
      treatments,
      populations: [],
      overrideIdCount: 0,
      populationCount: 0,
      fingerprint,
      revision: ag.revision,
      hash: ag.hash,
      recent: !!ag.recent,
      source: 'apex-crowd',
      hasGlobalPct: treatments.some((t) => t.pct != null && Number.isFinite(t.pct)),
      sampleCount: total,
    });
  }`,
'build-crowd'
);

rep(
`function isLiveGuild(e) {
  return e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user';
}
/** Only real guild % changes from Discord/advaith — never workers spam. */
function diffExperiments(prev, next) {
  const pMap = new Map(prev.map((e) => [e.id, e]));
  const nMap = new Map(next.map((e) => [e.id, e]));
  const added = [], removed = [], changed = [];
  for (const [id, n] of nMap) {
    if (!isLiveGuild(n)) continue;`,
`function isLiveGuild(e) {
  return e && (e.source === 'discord' || e.source === 'advaith') && e.type !== 'user';
}
function isLiveRollout(e) {
  if (!e || !e.id) return false;
  if (String(e.id).startsWith('hash:')) return false;
  if (isLiveGuild(e)) return true;
  if (e.type === 'user' && (e.source === 'apex-crowd' || e.source === 'discord-assignment')) {
    return !!(e.hasGlobalPct && (e.sampleCount || 0) >= 2);
  }
  return false;
}
/** Guild exact % + user crowd hash_result ranges */
function diffExperiments(prev, next) {
  const pMap = new Map(prev.map((e) => [e.id, e]));
  const nMap = new Map(next.map((e) => [e.id, e]));
  const added = [], removed = [], changed = [];
  for (const [id, n] of nMap) {
    if (!isLiveRollout(n)) continue;`,
'isLiveRollout'
);

rep(
`  for (const [id, p] of pMap) {
    if (nMap.has(id)) continue;
    if (!isLiveGuild(p)) continue;
    if (p.recent || isRecent(p.id)) removed.push(p);
  }`,
`  for (const [id, p] of pMap) {
    if (nMap.has(id)) continue;
    if (!isLiveRollout(p)) continue;
    if (p.recent || isRecent(p.id)) removed.push(p);
  }`,
'removed-filter'
);

if (t.includes("Apex rollouts v4.4")) {
  t = t.replace('Apex rollouts v4.4 — multi-token user + guild % anti-spam', 'Apex rollouts v4.5 — crowd hash_result (Escoteiros/Wumpus) + guild');
  n++;
  console.log('ok version bump');
}

const oldFmt = `function fmtTreat(ts, max = 10) {
  const lines = (ts || []).slice(0, max).map((t) => '• **' + (t.label || 'Bucket ' + t.bucket) + '** · \`' + t.pct + '%\`');
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + ' autres_');
  return lines.join('\\n') || '_—_';
}`;
const newFmt = `function fmtTreat(ts, max = 10) {
  const lines = (ts || []).slice(0, max).map((t) => {
    let s = '• **' + (t.label || 'Bucket ' + t.bucket) + '** · \`' + (t.pct != null ? t.pct + '%' : '?') + '\`';
    if (t.range && Array.isArray(t.range)) s += ' \`(' + t.range[0] + ' - ' + t.range[1] + ')\`';
    return s;
  });
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + ' autres_');
  return lines.join('\\n') || '_—_';
}`;
if (t.includes(oldFmt)) {
  t = t.replace(oldFmt, newFmt);
  n++;
  console.log('ok fmtTreat');
} else {
  console.warn('fmtTreat block not exact — skip');
}

fs.writeFileSync(p, t);
console.log('wrote', p, 'patches', n);
