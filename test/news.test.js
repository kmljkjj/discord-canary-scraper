'use strict';

/**
 * Actus — filtre anti-politique, plafonds anti-spam, parsing RSS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPolitical, pickItems, parseRssItems, normalizeTitle } = require('../src/news');

test('isPolitical : blocklist globale, tolérante aux faux positifs', () => {
  assert.equal(isPolitical('Le Congrès américain vote une loi sur les tech', '', 'social'), true);
  assert.equal(isPolitical('Elections en Allemagne : les résultats', '', 'monde'), true);
  assert.equal(isPolitical('Le gouvernement dévoile son budget', '', 'monde'), true);
  assert.equal(isPolitical('WhatsApp change sa politique de confidentialité', '', 'social'), false);
  assert.equal(isPolitical('PSG : le président du club annonce un recrutement', '', 'foot'), false);
  assert.equal(isPolitical('Le président du club annonce un recrutement', '', 'monde'), true);
});

test('pickItems : plafonds par run, catégorie et source', () => {
  const mk = (i, cat, sourceId) => ({ i, cat, sourceId });
  const items = [
    mk(1, 'foot', 'a'),
    mk(2, 'foot', 'a'),
    mk(3, 'foot', 'a'), // source « a » plafonnée à 2
    mk(4, 'foot', 'b'),
    mk(5, 'foot', 'b'), // catégorie foot plafonnée à 3
    mk(6, 'tech', 'c'),
    mk(7, 'spotify', 'd'),
  ];
  const picked = pickItems(items, { maxPerRun: 10, maxPerCategory: 3, maxPerSource: 2 });
  assert.deepEqual(
    picked.map((p) => p.i),
    [1, 2, 4, 6, 7],
  );
  const cappedRun = pickItems(items, { maxPerRun: 2, maxPerCategory: 3, maxPerSource: 2 });
  assert.deepEqual(
    cappedRun.map((p) => p.i),
    [1, 2],
  );
});

test('parseRssItems : RSS avec CDATA, entités et item sans lien ignoré', () => {
  const xml = [
    '<rss><channel><item><title><![CDATA[Spotify lance un nouveau abonnement]]></title>',
    '<link>https://example.com/a?utm_source=x</link>',
    '<pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate>',
    '<description>&lt;b&gt;Test&lt;/b&gt; description</description>',
    '<source>Le Monde</source></item>',
    '<item><title>Sans lien</title><description>x</description></item></channel></rss>',
  ].join('');
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.ok(items[0].title.includes('Spotify'));
  assert.equal(items[0].desc, 'Test description');
  assert.equal(items[0].sourceTag, 'Le Monde');
});

test('normalizeTitle : clé stable sans accents', () => {
  assert.equal(normalizeTitle('Élections en Allemagne'), normalizeTitle('elections en allemagne'));
});
