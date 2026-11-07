const test = require('node:test');
const assert = require('node:assert');
const { parseRss, cmpIdDesc } = require('../src/x_news');

test('parseRss decodes HTML entities in titles', () => {
  const xml = '<rss><item><title>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s</title>' +
    '<link>https://x.com/a/status/12345678901234567</link><pubDate>garbage</pubDate></item></rss>';
  const [p] = parseRss(xml);
  assert.strictEqual(p.text, 'Tom & Jerry <3 "hi" it\'s');
  assert.strictEqual(p.id, '12345678901234567');
  assert.strictEqual(p.createdAt, null);
});

test('cmpIdDesc sorts snowflakes newest first across lengths', () => {
  assert.deepStrictEqual(['999', '1000', '1001'].sort(cmpIdDesc), ['1001', '1000', '999']);
});
