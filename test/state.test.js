'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExperiments,
  makeRunId,
  SCHEMA_VERSION,
} = require('../src/lib/state');

test('normalizeExperiments accepte un tableau', () => {
  const input = [
    { id: 1, type: 'guild', title: 'Test 1' },
    { id: 2, type: 'user', title: 'Test 2' },
  ];
  const out = normalizeExperiments(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, '1');
  assert.equal(out[0].type, 'guild');
  assert.equal(out[0].title, 'Test 1');
});

test('normalizeExperiments accepte { experiments: [...] }', () => {
  const input = { experiments: [{ id: 'abc', type: 'guild' }] };
  const out = normalizeExperiments(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'abc');
});

test('normalizeExperiments déduplique par id', () => {
  const input = [
    { id: 'dup', title: 'First' },
    { id: 'dup', title: 'Second' },
  ];
  const out = normalizeExperiments(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'First');
});

test('normalizeExperiments ignore les entrées sans id', () => {
  const input = [
    { id: 'ok', title: 'Has ID' },
    { title: 'No ID' },
    null,
    {},
  ];
  const out = normalizeExperiments(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
});

test('normalizeExperiments normalise le type', () => {
  assert.equal(normalizeExperiments([{ id: '1', type: 'guild' }])[0].type, 'guild');
  assert.equal(normalizeExperiments([{ id: '1', type: 'user' }])[0].type, 'user');
  assert.equal(normalizeExperiments([{ id: '1', type: 'unknown' }])[0].type, 'unknown');
  assert.equal(normalizeExperiments([{ id: '1' }])[0].type, 'unknown');
});

test('normalizeExperiments accepte un objet simple avec valeurs', () => {
  const input = {
    a: { id: 'a', type: 'guild' },
    b: { id: 'b', type: 'user' },
    c: { notExp: true },
  };
  const out = normalizeExperiments(input);
  assert.equal(out.length, 2);
});

test('makeRunId génère un id unique avec buildNumber', () => {
  const id1 = makeRunId('123456');
  const id2 = makeRunId('123456');
  assert.notEqual(id1, id2, 'runIds should be unique');
  assert.ok(id1.includes('123456'), 'runId should contain buildNumber');
});

test('makeRunId gère un buildNumber manquant', () => {
  const id = makeRunId(null);
  assert.ok(id.includes('_na_'), 'runId should contain "na" for missing buildNumber');
});

test('SCHEMA_VERSION est 2', () => {
  assert.equal(SCHEMA_VERSION, 2);
});
