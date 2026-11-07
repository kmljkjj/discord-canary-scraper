'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyNotifyResult } = require('../src/blog_tracker');

test('blog applyNotifyResult drops unsent added items so they are re-notified', () => {
  const prev = [{ id: '1', source: 'blog', title: 'a' }];
  const fresh = [prev[0], { id: '2', source: 'blog', title: 'b' }];
  const out = applyNotifyResult(
    prev,
    fresh,
    { items: [{ e: fresh[1], action: 'added', source: 'blog', sent: false }] },
    'blog',
  );
  assert.deepStrictEqual(
    out.map((e) => e.id),
    ['1'],
  );
});
