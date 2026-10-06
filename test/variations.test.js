'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractObjectLiteralPairs,
  extractVariationBlock,
  parseTopLevelBlocks,
} = require('../src/lib/extract');

test('extractObjectLiteralPairs: extrait les paires clé:valeur simples', () => {
  const body = 'enabled:!1,variant:0';
  const pairs = extractObjectLiteralPairs(body);
  assert.deepStrictEqual(pairs, { enabled: false, variant: 0 });
});

test('extractObjectLiteralPairs: gère true/false/!0/!1', () => {
  const body = 'a:true,b:!0,c:false,d:!1';
  const pairs = extractObjectLiteralPairs(body);
  assert.deepStrictEqual(pairs, { a: true, b: true, c: false, d: false });
});

test('extractObjectLiteralPairs: gère null et nombres', () => {
  const body = 'x:null,y:42,z:3.14';
  const pairs = extractObjectLiteralPairs(body);
  assert.deepStrictEqual(pairs, { x: null, y: 42, z: 3.14 });
});

test('extractObjectLiteralPairs: gère les strings', () => {
  const body = 'name:"test",label:"hello world"';
  const pairs = extractObjectLiteralPairs(body);
  assert.deepStrictEqual(pairs, { name: 'test', label: 'hello world' });
});

test('extractVariationBlock: extrait le bloc d\'une variation', () => {
  const body = '0:{enabled:!1,variant:0},1:{enabled:!0}';
  const block = extractVariationBlock(body, '0');
  assert.ok(block);
  const pairs = extractObjectLiteralPairs(block);
  assert.deepStrictEqual(pairs, { enabled: false, variant: 0 });
});

test('extractVariationBlock: extrait le bloc de la variation 1', () => {
  const body = '0:{enabled:!1,variant:0},1:{enabled:!0}';
  const block = extractVariationBlock(body, '1');
  assert.ok(block);
  const pairs = extractObjectLiteralPairs(block);
  assert.deepStrictEqual(pairs, { enabled: true });
});

test('extractVariationBlock: retourne null si la clé n\'existe pas', () => {
  const body = '0:{enabled:!1},1:{enabled:!0}';
  const block = extractVariationBlock(body, '99');
  assert.strictEqual(block, null);
});

test('parseTopLevelBlocks: parse les blocs d\'un tableau', () => {
  const body = '{id:0,enabled:!1,variant:0},{id:1,enabled:!0}';
  const blocks = parseTopLevelBlocks(body, '{', '}');
  assert.strictEqual(blocks.length, 2);
  const pairs0 = extractObjectLiteralPairs(blocks[0]);
  assert.deepStrictEqual(pairs0, { id: 0, enabled: false, variant: 0 });
  const pairs1 = extractObjectLiteralPairs(blocks[1]);
  assert.deepStrictEqual(pairs1, { id: 1, enabled: true });
});

test('parseTopLevelBlocks: gère les objets imbriqués', () => {
  const body = '{config:{nested:!0},enabled:!1},{id:1,enabled:!0}';
  const blocks = parseTopLevelBlocks(body, '{', '}');
  assert.strictEqual(blocks.length, 2);
});

test('extractObjectLiteralPairs: ignore les objets imbriqués', () => {
  // extractObjectLiteralPairs ne doit capturer que les valeurs simples
  const body = 'enabled:!1,config:{nested:!0}';
  const pairs = extractObjectLiteralPairs(body);
  // enabled est capturé, config ne l'est pas (c'est un objet)
  assert.strictEqual(pairs.enabled, false);
  assert.ok(!pairs.config);
});

test('simulate full variations extraction like user example', () => {
  // Simule le cas de l'utilisateur: variations avec configs complètes
  const body = '0:{enabled:!1,variant:0},1:{enabled:!0}';
  const keys = [...body.matchAll(/(?:^|[,{}])\s*(\d+)\s*:/g)].map((x) => x[1]);
  assert.deepStrictEqual(keys, ['0', '1']);

  const out = {};
  for (const k of keys) {
    const block = extractVariationBlock(body, k);
    if (block) {
      const pairs = extractObjectLiteralPairs(block);
      out[k] = Object.keys(pairs).length ? pairs : { id: Number(k) };
    } else {
      out[k] = { id: Number(k) };
    }
  }

  // L'utilisateur veut ce format:
  // "0": { enabled: false, variant: 0 }
  // "1": { enabled: true }
  assert.deepStrictEqual(out['0'], { enabled: false, variant: 0 });
  assert.deepStrictEqual(out['1'], { enabled: true });
});
