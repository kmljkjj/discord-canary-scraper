'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countryCodeToFlag } = require('../src/quests');

test('countryCodeToFlag convertit les codes ISO en drapeaux', () => {
  assert.strictEqual(countryCodeToFlag('FR'), '🇫🇷');
  assert.strictEqual(countryCodeToFlag('US'), '🇺🇸');
  assert.strictEqual(countryCodeToFlag('DE'), '🇩🇪');
  assert.strictEqual(countryCodeToFlag('JP'), '🇯🇵');
  assert.strictEqual(countryCodeToFlag('GB'), '🇬🇧');
  assert.strictEqual(countryCodeToFlag('BR'), '🇧🇷');
});

test('countryCodeToFlag gère la casse', () => {
  assert.strictEqual(countryCodeToFlag('fr'), '🇫🇷');
  assert.strictEqual(countryCodeToFlag('Us'), '🇺🇸');
  assert.strictEqual(countryCodeToFlag(' dE '), '🇩🇪');
});

test('countryCodeToFlag retourne chaîne vide pour codes invalides', () => {
  assert.strictEqual(countryCodeToFlag(''), '');
  assert.strictEqual(countryCodeToFlag(null), '');
  assert.strictEqual(countryCodeToFlag(undefined), '');
  assert.strictEqual(countryCodeToFlag('USA'), '');
  assert.strictEqual(countryCodeToFlag('F'), '');
  assert.strictEqual(countryCodeToFlag('123'), '');
  assert.strictEqual(countryCodeToFlag('F1'), '');
});
