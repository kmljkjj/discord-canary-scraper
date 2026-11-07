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

const { capKnownIds } = require('../src/lib/utils');
test('capKnownIds keeps currently-extracted keys over the cap', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  capKnownIds(ids, 3, { a: 1, b: 1 });
  assert.deepStrictEqual(ids, ['a', 'b', 'e']);
  const small = ['x'];
  capKnownIds(small, 3, {});
  assert.deepStrictEqual(small, ['x']);
  const allLive = ['a', 'b', 'c'];
  capKnownIds(allLive, 2, { a: 1, b: 1, c: 1 });
  assert.deepStrictEqual(allLive, ['a', 'b', 'c']);
});
