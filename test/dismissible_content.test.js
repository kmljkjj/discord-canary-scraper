'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissible-'));
process.env.NOTIFY_DEDUPE_FILE = path.join(DATA, 'notify_dedupe.json');

const dc = require('../src/lib/dismissible_content');
const { sectionEmbeds } = require('../src/lib/notify');

function bundle(members, v = 'i') {
  const parts = members.map(([k, n], idx) =>
    idx === 0 ? `(${v}={})[${v}.${k}=${n}]="${k}"` : `${v}[${v}.${k}=${n}]="${k}"`,
  );
  return 'var x=1,a=(' + parts.join(',') + `,${v}),b={FOO_BAR:12,BAZ_QUX:13};`;
}

const BASE = [['DISMISSIBLE_CONTENT_UNSPECIFIED', 0]];
for (let i = 1; i <= 20; i++) BASE.push(['ITEM_' + i, i]);

test('extraction : enum TS compilé (format Discord réel)', () => {
  const src = bundle([...BASE, ['PERSONAL_WIDGET_GOING_AWAY_COACHMARK', 874]]);
  const out = {};
  dc.extractDismissibleContent(src, out);
  assert.equal(out.PERSONAL_WIDGET_GOING_AWAY_COACHMARK, 874);
  assert.equal(out.ITEM_1, 1);
  assert.equal(Object.keys(out).length, 21);
  assert.ok(!('DISMISSIBLE_CONTENT_UNSPECIFIED' in out));
  assert.ok(!('FOO_BAR' in out), 'pas de faux positifs hors enum');
});

test('extraction : variable minifiée avec $', () => {
  const out = {};
  dc.extractDismissibleContent(bundle(BASE, '$e'), out);
  assert.equal(Object.keys(out).length, 20);
});

test('extraction : rien sans ancre / enum trop court', () => {
  const out = {};
  dc.extractDismissibleContent('a={FOO_BAR:1,BAR_BAZ:2}', out);
  dc.extractDismissibleContent(bundle(BASE.slice(0, 4)), out);
  assert.deepEqual(out, {});
});

test('diff : ajouté / modifié / supprimé', () => {
  const d = dc.diffDismissible({ A: 1, B: 3, D: 4 }, { A: 1, B: 2, C: 5 });
  assert.deepEqual(d.added, { D: 4 });
  assert.deepEqual(d.removed, { C: 5 });
  assert.deepEqual(d.modified, { B: { from: 2, to: 3 } });
});

test('rendu : même format que Experiments, sans emoji', () => {
  const e = sectionEmbeds(
    { label: 'Ajoutés · 1', color: 0x57f287, count: 1, lines: ['+ PERSONAL_WIDGET_GOING_AWAY_COACHMARK = 874'] },
    { title: 'Dismissible Content', bn: '1', ts: '2026-11-03T00:00:00.000Z' },
  );
  assert.equal(e[0].title, 'Dismissible Content · Build 1');
  assert.match(e[0].fields[0].value, /^```diff\n\+ PERSONAL_WIDGET_GOING_AWAY_COACHMARK = 874\n```$/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(e)));
});

test('process : seed puis notif + baseline conservée si webhook KO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
  const cur = Object.fromEntries(BASE.slice(1));
  const r1 = await dc.processDismissibleContent({ dataDir: dir, current: cur, buildNumber: 1, webhookUrl: null, isSeed: true });
  assert.equal(r1.notified, false);
  assert.equal((await dc.loadState(dir)).data.ITEM_1, 1);

  const next = { ...cur, NEW_ONE: 900 };
  const http = require('http');
  let calls = 0;
  let status = 400;
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      calls++;
      bodies.push(b);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"id":"1"}' : '{"message":"bad"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/webhooks/1/tok`;
  try {
    const r2 = await dc.processDismissibleContent({ dataDir: dir, current: next, buildNumber: 2, webhookUrl: url, isSeed: false });
    assert.equal(r2.notified, false);
    assert.ok(calls >= 1);
    assert.ok(!('NEW_ONE' in (await dc.loadState(dir)).data), 'baseline non avancée');
    status = 200;
    const r3 = await dc.processDismissibleContent({ dataDir: dir, current: next, buildNumber: 2, webhookUrl: url, isSeed: false });
    assert.equal(r3.notified, true);
    assert.equal((await dc.loadState(dir)).data.NEW_ONE, 900);
    assert.ok(bodies.at(-1).includes('NEW_ONE = 900'));
  } finally {
    srv.close();
  }
});
