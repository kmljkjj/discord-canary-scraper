const test = require('node:test');
const assert = require('node:assert');
const { resolveEnUsLocaleUrls } = require('../src/lib/extract');

const MAP = '283896:"81405dcb12e2bcfb",444819:"0123456789abcdef"';

test('resolveEnUsLocaleUrls : n.e(123) non quoté (format canary actuel)', () => {
  const web = `{${MAP}};x={"en-US":()=>n.e(283896).then(n.bind(n,980075))}`;
  const urls = resolveEnUsLocaleUrls(web);
  assert.deepStrictEqual(urls, ['https://canary.discord.com/assets/81405dcb12e2bcfb.js']);
});

test('resolveEnUsLocaleUrls : ancien format n.e("123") toujours supporté', () => {
  const web = `{${MAP}};x={"en-US":()=>n.e("283896")}`;
  assert.strictEqual(resolveEnUsLocaleUrls(web).length, 1);
});
