'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendWebhook, sendEmbeds } = require('../src/lib/webhook');

const reply = { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };

test('chaque type de notification fournit son nom et son avatar aux messages', async () => {
  const sent = [];
  const opts = { identity: 'quests', minGapMs: 0, fetchImpl: async (_url, req) => { sent.push(JSON.parse(req.body)); return reply; } };
  await sendWebhook('https://example.com/webhook', { content: 'hello', username: 'ancien' }, opts);
  assert.equal(sent[0].username, 'Datamining · Quêtes');
  assert.match(sent[0].avatar_url, /noto-emoji.*3D\/png\/512\/emoji_u1f3c6\.png$/); // trophée Noto 3D 512 px
  assert.equal(sent[0].content, 'hello');
});

test('les messages Components V2 conservent leur identité', async () => {
  let sent;
  const opts = { identity: 'mobile', minGapMs: 0, fetchImpl: async (_url, req) => { sent = JSON.parse(req.body); return reply; } };
  await sendEmbeds('https://example.com/webhook', { username: 'ancien' }, [{ title: 'Une version' }], opts);
  assert.equal(sent.username, 'Datamining · Mobile');
  assert.match(sent.avatar_url, /1f4f1\.png$/);
  assert.equal(sent.flags, 32768);
});

test('identités actus : toutes définies et résolues', () => {
  const { webhookIdentity } = require('../src/lib/webhook_identity');
  for (const t of ['newsMonde', 'newsSocial', 'newsFoot', 'newsTech', 'newsSpotify']) {
    const id = webhookIdentity(t);
    assert.ok(id.username.startsWith('Datamining · Actus · '), t);
    assert.match(id.avatar_url, /noto-emoji@99701e07d3d1fe1bdbcdb14964547f0fd592966f/);
    assert.ok(id.username.length <= 80);
  }
});
