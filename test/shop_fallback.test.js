'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFallbackShop } = require('../src/shop');

// Structure observée sur https://itemshop.gg/discord (7 novembre 2026) :
// en-tête, collections, compteurs, puis le motif « nom / type / prix ».
const PAGE = [
  'Discord Shop Today',
  'November 7, 2026',
  'Deadpool/Wolverine',
  '14',
  'Deadpool Bundle',
  'Bundle',
  '30.99USD',
  'Wolverine Bundle',
  'Bundle',
  '30.99USD',
  'Deadpool',
  'Avatar Decoration',
  '8.99USD',
  'Deadpool',
  'Nameplate',
  '8.99USD',
  'Advertisement',
  'Día de Muertos',
  '7',
  'Todos Santos Bundle',
  'Bundle',
  '14400',
  'Ofrenda',
  'Avatar Decoration',
  '4100',
  'Calavera (Purple)',
  'Nameplate',
  '4100',
].join('\n');

test('parseFallbackShop : texte structuré -> items (nom + type)', () => {
  const items = parseFallbackShop(PAGE);
  assert.equal(items.length, 7);
  assert.deepEqual(items[0], {
    key: 'Deadpool Bundle|Bundle',
    name: 'Deadpool Bundle',
    type: 'Bundle',
    source: 'itemshop',
  });
  assert.ok(items.some((i) => i.key === 'Deadpool|Avatar Decoration'));
  assert.ok(items.some((i) => i.key === 'Deadpool|Nameplate'));
  assert.ok(items.some((i) => i.key === 'Calavera (Purple)|Nameplate'));
});

test('parseFallbackShop : HTML brut -> mêmes items après strip des tags', () => {
  const html = PAGE.split('\n').map((l) => '<div>' + l + '</div>').join('\n');
  const items = parseFallbackShop(html);
  assert.equal(items.length, 7);
  assert.equal(items[6].name, 'Calavera (Purple)');
});

test('parseFallbackShop : page sans types -> tableau vide', () => {
  assert.deepEqual(parseFallbackShop(''), []);
  assert.deepEqual(parseFallbackShop('nimporte quoi\nsans types\n123'), []);
});
