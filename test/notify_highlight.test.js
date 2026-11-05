'use strict';

/**
 * Mise en avant : le contenu le plus important de chaque section
 * (Strings, Routes, Experiments) apparaît en bloc de code — « ✨ À la une »
 * pour les grandes sections, tout le contenu pour les petites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

// Répertoire temporaire isolé : ne JAMAIS toucher au vrai data/notify_dedupe.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-highlight-'));
process.env.NOTIFY_DEDUPE_FILE = path.join(DATA, 'notify_dedupe.json');

const { sectionEmbeds } = require('../src/lib/notify');

const BASE = { title: 'Experiments', bn: '123', ts: '2026-10-29T00:00:00.000Z' };

test('grande section : « ✨ À la une » en bloc de code, puis la liste complète', () => {
  const lines = Array.from({ length: 30 }, (_, i) => '+ ' + 'x'.repeat(96) + String(i + 1).padStart(2, '0'));
  const embeds = sectionEmbeds({ label: 'Added · 30', color: 0x57f287, count: 30, lines }, BASE);
  assert.equal(embeds.length, 1);
  const fields = embeds[0].fields;
  assert.equal(fields[0].name, '✨ À la une');
  assert.match(fields[0].value, /^```/);
  assert.match(fields[0].value, /```$/);
  assert.equal((fields[0].value.match(/\n/g) || []).length, 6, '5 entrées mises en avant');
  assert.equal(fields.length, 5, 'à la une + 4 morceaux de liste (blocs diff)');
  assert.equal(fields[1].name, 'Added · 30');
  assert.ok(fields[1].value.includes('01'), 'la liste complète commence à la 1re entrée');
  assert.equal(embeds[0].title, 'Experiments · Build 123');
  for (const f of fields) assert.ok(f.value.length <= 1024, 'champ sous la limite Discord');
});

test('section moyenne en un seul bloc : pas de « À la une » en doublon', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `+ exp_${i}`);
  const embeds = sectionEmbeds({ label: 'Added · 8', color: 0x57f287, count: 8, lines }, BASE);
  assert.equal(embeds[0].fields.length, 1);
  assert.equal(embeds[0].fields[0].name, 'Added · 8');
  assert.match(embeds[0].fields[0].value, /^```diff\n/);
});

test('petite section : tout le contenu en bloc de code sous le libellé', () => {
  const sec = {
    label: 'Ajouté · 2',
    color: 0x57f287,
    count: 2,
    lines: ['Nouvelle phrase ajoutée au client', 'Une autre phrase'],
  };
  const embeds = sectionEmbeds(sec, BASE);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].fields.length, 1);
  const f = embeds[0].fields[0];
  assert.equal(f.name, 'Ajouté · 2');
  assert.ok(f.value.startsWith('```diff\n'));
  assert.ok(f.value.endsWith('\n```'));
  assert.ok(f.value.includes('Nouvelle phrase ajoutée au client'));
  assert.ok(f.value.includes('Une autre phrase'));
});

test('les backticks triples du contenu ne cassent pas le bloc de code', () => {
  const embeds = sectionEmbeds(
    { label: 'Modified · 1', color: 0xe67e22, count: 1, lines: ['avant ``` après'] },
    BASE,
  );
  const v = embeds[0].fields[0].value;
  assert.equal((v.match(/```/g) || []).length, 2, 'seules les clôtures du bloc restent');
});

test('mise en avant : une ligne par entrée, les détails restent dans la liste', () => {
  const lines = [
    '+ exp_multi\nType user · apex\nUn libellé long',
    ...Array.from({ length: 40 }, (_, i) => `+ exp_${i}_${'x'.repeat(40)}`),
  ];
  const embeds = sectionEmbeds({ label: 'Added · 41', color: 0x57f287, count: 41, lines }, BASE);
  assert.equal(embeds.length, 1);
  const fields = embeds[0].fields;
  assert.equal(fields[0].name, '✨ À la une');
  assert.ok(fields[0].value.includes('+ exp_multi'));
  assert.ok(!fields[0].value.includes('Un libellé long'), 'une seule ligne par entrée');
  assert.equal(fields[1].name, 'Added · 41');
  assert.ok(fields[1].value.includes('Un libellé long'), 'la liste garde les détails');
});

test('les longues entrées sont tronquées dans la mise en avant, jamais dans la liste', () => {
  const long = 'phrase très longue '.repeat(12); // ~204 caractères
  const lines = [long, ...Array.from({ length: 30 }, (_, i) => `ligne ${i} ${'x'.repeat(40)}`)];
  const embeds = sectionEmbeds({ label: 'Modifié · 31', color: 0xe67e22, count: 31, lines }, BASE);
  const hl = embeds[0].fields[0];
  const first = hl.value.split('\n')[1];
  assert.equal(first.length, 100, '99 caractères + ellipse');
  assert.ok(first.endsWith('…'));
  assert.ok(embeds[0].fields[1].value.includes(long), 'liste complète non tronquée');
});
