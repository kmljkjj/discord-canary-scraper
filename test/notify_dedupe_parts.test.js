'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

test('notify : parties « suite » au contenu proche toutes envoyées (pas de faux CLAIM skip)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
  process.env.NOTIFY_DEDUPE_FILE = path.join(tmp, 'dedupe.json');
  const webhookPath = require.resolve('../src/lib/webhook');
  const sent = [];
  require.cache[webhookPath] = {
    id: webhookPath,
    filename: webhookPath,
    loaded: true,
    exports: {
      sendEmbeds: async (url, base, embeds) => {
        sent.push(embeds[0]);
        return { ok: true, status: 204, text: '' };
      },
    },
  };
  delete require.cache[require.resolve('../src/lib/webhook_dedupe')];
  delete require.cache[require.resolve('../src/lib/notify')];
  const { notifyNormal } = require('../src/lib/notify');
  // Build 1 puis build 2 (< 24 h) : mêmes routes + une nouvelle à la fin.
  // Avant : les messages « suite » identiques au build 1 étaient sautés (CLAIM skip).
  const added = {};
  for (let i = 0; i < 400; i++) added['ROUTE_' + String(i).padStart(5, '0')] = '/x/' + 'y'.repeat(60);
  const send = (bn, diff) =>
    notifyNormal({
      build: { buildNumber: bn },
      strDiff: {},
      rtDiff: { added: diff, modified: {}, removed: {} },
      webhookUrl: 'https://discord.com/api/webhooks/1/x',
    });
  assert.equal(await send('1', added), true);
  sent.length = 0;
  const added2 = { ...added, ZZZ_NEW_ROUTE: '/new' };
  assert.equal(await send('2', added2), true);
  const text = sent.map((e) => (e.fields || []).map((f) => f.value).join('\n')).join('\n');
  for (const k of Object.keys(added2)) assert.ok(text.includes(k), 'manquant ' + k);
  delete require.cache[webhookPath];
});
