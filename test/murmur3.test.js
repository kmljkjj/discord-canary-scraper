'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { murmur3 } = require('../src/lib/murmur3');

test('murmur3 retourne un entier 32 bits non signé', () => {
  const h = murmur3('2024-01_some_experiment');
  assert.equal(typeof h, 'number');
  assert.ok(h >= 0 && h <= 0xffffffff);
  assert.equal(h, h >>> 0);
});

test('murmur3 est déterministe (même clé → même hash)', () => {
  const key = '2024-06_user_profiles_redesign';
  assert.equal(murmur3(key), murmur3(key));
});

test('murmur3 avec seed différent donne un hash différent', () => {
  const key = 'test_experiment';
  const h0 = murmur3(key, 0);
  const h1 = murmur3(key, 1);
  assert.notEqual(h0, h1);
});

test('murmur3 distribue les clés différentes', () => {
  const keys = ['a', 'b', 'c', 'aa', 'ab', 'ba', 'hello', 'world'];
  const hashes = new Set(keys.map((k) => murmur3(k)));
  // au moins 7 des 8 devraient être distincts
  assert.ok(hashes.size >= 7, `trop de collisions: ${hashes.size}/8`);
});

test('murmur3 gère les entrées non-chaînes (numérique)', () => {
  const h = murmur3(12345);
  assert.equal(h, murmur3('12345'));
  assert.equal(typeof h, 'number');
});

test('murmur3 gère la chaîne vide', () => {
  const h = murmur3('');
  assert.equal(typeof h, 'number');
  assert.equal(h, h >>> 0);
});

test('murmur3 gère les caractères Unicode', () => {
  const h = murmur3('café');
  assert.equal(typeof h, 'number');
  assert.equal(h, h >>> 0);
});
