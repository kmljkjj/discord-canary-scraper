'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableStatus, extractRetryAfterMs, backoffMs } = require('../src/lib/http');

test('isRetryableStatus: 429 et 5xx sont retryable', () => {
  assert.strictEqual(isRetryableStatus(429), true);
  assert.strictEqual(isRetryableStatus(500), true);
  assert.strictEqual(isRetryableStatus(502), true);
  assert.strictEqual(isRetryableStatus(503), true);
  assert.strictEqual(isRetryableStatus(599), true);
});

test('isRetryableStatus: 4xx (hors 429) et 2xx ne sont pas retryable', () => {
  assert.strictEqual(isRetryableStatus(200), false);
  assert.strictEqual(isRetryableStatus(301), false);
  assert.strictEqual(isRetryableStatus(400), false);
  assert.strictEqual(isRetryableStatus(401), false);
  assert.strictEqual(isRetryableStatus(403), false);
  assert.strictEqual(isRetryableStatus(404), false);
  assert.strictEqual(isRetryableStatus(422), false);
});

test('extractRetryAfterMs: lit le header retry-after', () => {
  const fakeRes = {
    headers: {
      get: (name) => (name === 'retry-after' ? '2.5' : null),
    },
  };
  assert.strictEqual(extractRetryAfterMs(fakeRes, null), 2500);
});

test('extractRetryAfterMs: lit retry_after du body JSON', () => {
  const fakeRes = {
    headers: {
      get: () => null,
    },
  };
  assert.strictEqual(extractRetryAfterMs(fakeRes, { retry_after: 1.5 }), 1500);
});

test('extractRetryAfterMs: retourne 0 si rien trouvé', () => {
  const fakeRes = {
    headers: {
      get: () => null,
    },
  };
  assert.strictEqual(extractRetryAfterMs(fakeRes, null), 0);
});

test('extractRetryAfterMs: prend le max des candidats', () => {
  const fakeRes = {
    headers: {
      get: (name) => (name === 'retry-after' ? '3' : name === 'x-ratelimit-reset-after' ? '5' : null),
    },
  };
  assert.strictEqual(extractRetryAfterMs(fakeRes, { retry_after: 2 }), 5000);
});

test('backoffMs: augmente avec les tentatives', () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 15000 };
  const d0 = backoffMs(0, opts);
  const d1 = backoffMs(1, opts);
  const d2 = backoffMs(2, opts);
  // Le backoff exponentiel augmente (avec jitter, on vérifie juste les bornes)
  assert.ok(d0 >= 250 && d0 <= 500, `attempt 0: ${d0}`);
  assert.ok(d1 >= 500 && d1 <= 1000, `attempt 1: ${d1}`);
  assert.ok(d2 >= 1000 && d2 <= 2000, `attempt 2: ${d2}`);
});

test('backoffMs: plafonné par maxDelayMs', () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 1000 };
  const d10 = backoffMs(10, opts);
  assert.ok(d10 <= 1000, `should be capped: ${d10}`);
});
