'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

test('fetchJsonWithRetry: body non-JSON → null, body lu une seule fois (diagnostic conservé)', async () => {
  const orig = Module._load;
  const calls = [];
  Module._load = function (req, ...rest) {
    if (req === 'node-fetch') {
      return async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
        text: async () => { calls.push('text'); return '<html>cf</html>'; },
        json: async () => { throw new Error('res.json ne doit plus être utilisé'); },
      });
    }
    return orig.call(this, req, ...rest);
  };
  const id = require.resolve('../src/lib/http');
  delete require.cache[id];
  try {
    const { fetchJsonWithRetry } = require('../src/lib/http');
    assert.equal(await fetchJsonWithRetry('https://x.test', { maxAttempts: 1 }), null);
    assert.deepEqual(calls, ['text']);
  } finally {
    Module._load = orig;
    delete require.cache[id];
  }
});

test('safeJson: JSON valide parsé, invalide → null', async () => {
  const { safeJson } = require('../src/lib/http');
  const mk = (t) => ({ headers: { get: () => '' }, text: async () => t });
  assert.deepEqual(await safeJson(mk('{"a":1}')), { a: 1 });
  assert.equal(await safeJson(mk('<html>')), null);
});

test('trimRecent: garde les plus récents (ordre d\'insertion), pas le tri lexical', () => {
  const { trimRecent } = require('../src/lib/utils');
  const s = new Set(['zzz', 'aaa', 'mmm', 'bbb']);
  assert.deepEqual(trimRecent(s, 2), ['mmm', 'bbb']);
  assert.deepEqual(trimRecent(s, 10), ['zzz', 'aaa', 'mmm', 'bbb']);
  assert.deepEqual(trimRecent(['1', '1', '2'], 5), ['1', '2']);
  assert.deepEqual(trimRecent(null, 3), []);
});
