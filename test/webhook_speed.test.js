const test = require('node:test');
const assert = require('node:assert');
const { sendWebhook, _resetBucket } = require('../src/lib/webhook');

function fakeFetch(remaining) {
  return async () => ({
    ok: true,
    status: 204,
    headers: { get: (n) => (n === 'x-ratelimit-remaining' ? remaining : null) },
    text: async () => '',
  });
}
const URL1 = 'https://discord.com/api/webhooks/1/speedtoken';

test('webhook: pas de pause fixe par défaut entre deux envois', async () => {
  _resetBucket();
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const r = await sendWebhook(URL1, { content: 'x' }, { fetchImpl: fakeFetch('4') });
    assert.ok(r.ok);
  }
  assert.ok(Date.now() - t0 < 150, 'les envois doivent partir immédiatement');
});

test('webhook: minGapMs ignoré si Discord annonce du quota restant', async () => {
  _resetBucket();
  const t0 = Date.now();
  await sendWebhook(URL1, { content: 'x' }, { fetchImpl: fakeFetch('3'), minGapMs: 500 });
  assert.ok(Date.now() - t0 < 300);
});

test('webhook: minGapMs appliqué si aucun header de quota', async () => {
  _resetBucket();
  const t0 = Date.now();
  await sendWebhook(URL1, { content: 'x' }, { fetchImpl: fakeFetch(null), minGapMs: 60 });
  assert.ok(Date.now() - t0 >= 55);
});
