'use strict';

/**
 * Rendu des sections (Strings, Routes, Experiments, Dismissible Content) :
 * tout le contenu en blocs de code « diff », sans section « À la une ».
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

test('grande section : plus de « À la une », la liste complète en blocs diff', () => {
  const lines = Array.from({ length: 30 }, (_, i) => '+ ' + 'x'.repeat(96) + String(i + 1).padStart(2, '0'));
  const embeds = sectionEmbeds({ label: 'Added · 30', color: 0x57f287, count: 30, lines }, BASE);
  assert.equal(embeds.length, 1);
  const fields = embeds[0].fields;
  assert.ok(!fields.some((f) => /la une/i.test(f.name)), 'aucun champ « À la une »');
  assert.equal(fields[0].name, 'Added · 30');
  assert.ok(fields[0].value.includes('01'), 'la liste complète commence à la 1re entrée');
  assert.ok(fields.every((f) => /^```diff\n/.test(f.value)));
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

test('grande section : la liste garde toutes les lignes, détails compris', () => {
  const long = 'phrase très longue '.repeat(12);
  const lines = [
    '+ exp_multi\nType user · apex\nUn libellé long',
    long,
    ...Array.from({ length: 40 }, (_, i) => `+ exp_${i}_${'x'.repeat(40)}`),
  ];
  const embeds = sectionEmbeds({ label: 'Added · 42', color: 0x57f287, count: 42, lines }, BASE);
  const fields = embeds[0].fields;
  assert.equal(fields[0].name, 'Added · 42');
  assert.ok(fields[0].value.includes('Un libellé long'), 'la liste garde les détails');
  assert.ok(fields[0].value.includes(long), 'liste complète non tronquée');
});
