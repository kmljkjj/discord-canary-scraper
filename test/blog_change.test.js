'use strict';

/**
 * Blog tracker — affichage des changements de corps d'article :
 * fenêtre centrée sur la première divergence + blocs de code nettoyés.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { changeText } = require('../src/blog_tracker');

test('changeText : corps modifié → fenêtres Before/After en blocs de code', () => {
  const before = 'A'.repeat(150) + ' Settings Profile Nitro vs. Non-Nitro Access';
  const after = 'A'.repeat(150) + ' Nitro rollout for mobile users';
  const ct = changeText({ _changes: [{ kind: 'body', before, after }] });
  const text = ct.content;
  assert.ok(text.includes('**Body** · modified'));
  assert.match(text, /-# First change around character 152/);
  assert.ok(text.includes('**Before**'));
  assert.ok(text.includes('**After**'));
  assert.ok(text.includes('Settings Profile'));
  assert.ok(text.includes('Nitro rollout'));
  // exactement 2 blocs de code = 4 fences
  assert.equal((text.match(/```/g) || []).length, 4);
});

test('changeText : backticks du corps neutralisés — le bloc ne casse pas', () => {
  const before = 'texte avec ```python\nprint(1)``` dedans puis du texte';
  const after = 'texte avec du code retiré puis du texte';
  const text = changeText({ _changes: [{ kind: 'body', before, after }] }).content;
  assert.equal((text.match(/```/g) || []).length, 4);
});

test('changeText : aperçus identiques → modified beyond the captured excerpt', () => {
  const text = changeText({ _changes: [{ kind: 'body', before: 'same', after: 'same' }] }).content;
  assert.ok(text.includes('Modified beyond the captured excerpt'));
});

test('changeText : titre modifié → ligne Title conservée', () => {
  const text = changeText({ _changes: [{ kind: 'title', before: 'Old', after: 'New' }] }).content;
  assert.ok(text.includes('**Title** ·'));
});

test('changeText : aucun changement → null', () => {
  assert.equal(changeText({ _changes: [] }), null);
});
