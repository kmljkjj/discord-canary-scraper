'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractRoutes,
  extractLocaleStrings,
  extractCoreParallel,
  flattenIcu,
  decodeJsStringLiteral,
} = require('../src/lib/extract');
const {
  chunkIntoMessages,
  textDisplay,
  MESSAGE_MAX_TEXT_CHARS,
  componentTextLen,
} = require('../src/lib/components_v2');

test('locale : la valeur ICU complète gagne (pas de fragment "percent")', () => {
  const out = {};
  extractLocaleStrings(
    `a.exports=JSON.parse('{"2L/ygS":[[1,"percent"]," percent complete"],"xb78ZZ":["checked"],"q1w2e3":["It\\'s ok \\\\\\\\o/"]}')`,
    out,
  );
  assert.equal(out['2L/ygS'], '{percent} percent complete');
  assert.equal(out.xb78ZZ, 'checked');
  assert.equal(out.q1w2e3, "It's ok \\o/");
});

test('flattenIcu : pluriels', () => {
  assert.equal(
    flattenIcu([[6, 'count', { one: [[7], ' Post'], other: [[7], ' Posts'] }, 0, 'cardinal']]),
    '{count, plural, one {# Post} other {# Posts}}',
  );
});

test('decodeJsStringLiteral', () => {
  assert.equal(decodeJsStringLiteral("a\\'b\\\\c\\u00e9\\x41"), "a'b\\céA");
});

test('core web.* ne produit plus de faux strings', async () => {
  const strings = {};
  await extractCoreParallel('x={"bottom":"top","hidden":"visible","qMj+2W":"userName"}', {
    routes: {},
    expSet: new Map(),
    strings,
  });
  assert.deepEqual(strings, {});
});

test('routes dynamiques minifiées', () => {
  const out = {};
  extractRoutes(
    'USER:e=>`/users/${e}`,USER_BADGE:(e,t)=>`/users/${e}/badges/${t}`,VOICE_PUBLIC_KEYS:()=>"/voice/public-keys",GUILDS:"/guilds",HELP:`//${x}/hc`',
    out,
  );
  assert.equal(out.USER, '/users/:param');
  assert.equal(out.USER_BADGE, '/users/:param/badges/:param');
  assert.equal(out.VOICE_PUBLIC_KEYS, '/voice/public-keys');
  assert.equal(out.GUILDS, '/guilds');
  assert.equal(out.HELP, undefined);
});

test('Components V2 : ≤ 4000 caractères de texte par message', () => {
  const comps = [];
  for (let i = 0; i < 12; i++) comps.push(textDisplay('x'.repeat(1000)));
  const msgs = chunkIntoMessages(comps, 0);
  assert.ok(msgs.length >= 4);
  for (const m of msgs) {
    const n = m.reduce((s, c) => s + componentTextLen(c), 0);
    assert.ok(n <= MESSAGE_MAX_TEXT_CHARS, 'message trop long: ' + n);
  }
  const total = msgs.flat().reduce((s, c) => s + componentTextLen(c), 0);
  assert.equal(total, 12000);
});
