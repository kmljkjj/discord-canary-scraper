'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXcliJsonl, parseSyndicationProfile } = require('../src/x_news');

test('parseXcliJsonl : lignes JSONL -> posts internes', () => {
  const lines = [
    JSON.stringify({
      kind: 'x/tweet',
      id: '2112345678901234567',
      text: 'Discord update is rolling out!',
      created_at: '2026-10-30T09:00:00Z',
      author: { username: 'DiscordNEW8r', rest_id: '2073982489836584960' },
      media: [{ type: 'photo', preview_image: 'https://pbs.twimg.com/media/abc?format=jpg&name=small' }],
    }),
    JSON.stringify({ id: '2112345678901234568', text: 'Second post' }),
  ].join('\n');
  const posts = parseXcliJsonl(lines, 'DiscordNEW8r');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, '2112345678901234567');
  assert.equal(posts[0].text, 'Discord update is rolling out!');
  assert.equal(posts[0].url, 'https://x.com/DiscordNEW8r/status/2112345678901234567');
  assert.ok(posts[0].image.startsWith('https://pbs.twimg.com/'));
  assert.equal(posts[1].image, null);
  assert.equal(posts[1].createdAt, null);
});

test('parseXcliJsonl : lignes vides, invalides, ids courts, doublons -> ignores', () => {
  const lines = [
    '',
    '   ',
    'not json',
    JSON.stringify({ id: '123', text: 'id trop court' }),
    JSON.stringify({ id: '2112345678901234567', text: 'ok' }),
    JSON.stringify({ id: '2112345678901234567', text: 'doublon' }),
    JSON.stringify({ text: 'sans id' }),
  ].join('\n');
  const posts = parseXcliJsonl(lines, 'DiscordNEW8r');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'ok');
});

test('parseXcliJsonl : entree vide ou null -> tableau vide', () => {
  assert.deepEqual(parseXcliJsonl('', 'a'), []);
  assert.deepEqual(parseXcliJsonl(null, 'a'), []);
});

test('parseSyndicationProfile : HTML __NEXT_DATA__ -> posts internes', () => {
  const html = "<html><script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"timeline\":{\"entries\":[{\"type\":\"tweet\",\"content\":{\"tweet\":{\"id_str\":\"2095896111131058484\",\"full_text\":\"Canary build 657616 is rolling out\",\"created_at\":\"Wed Oct 30 09:12:33 +0000 2026\",\"user\":{\"screen_name\":\"DiscordNEW8r\"},\"extended_entities\":{\"media\":[{\"media_url_https\":\"https://pbs.twimg.com/media/abc.jpg\"}]}}}},{\"type\":\"tweet\",\"content\":{\"tweet\":{\"id_str\":\"2095200425125327172\",\"full_text\":\"Canary build 657616 is rolling out\",\"created_at\":\"Wed Oct 30 09:12:33 +0000 2026\",\"user\":{\"screen_name\":\"DiscordNEW8r\"},\"extended_entities\":{\"media\":[{\"media_url_https\":\"https://pbs.twimg.com/media/abc.jpg\"}]}}}}]}}}}</script></html>";
  const posts = parseSyndicationProfile(html, 'DiscordNEW8r');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, '2095896111131058484');
  assert.equal(posts[0].text, 'Canary build 657616 is rolling out');
  assert.equal(posts[0].url, 'https://x.com/DiscordNEW8r/status/2095896111131058484');
  assert.ok(posts[0].createdAt.startsWith('2026-10-30T'));
  assert.ok(posts[0].image.startsWith('https://pbs.twimg.com/'));
});

test('parseSyndicationProfile : sans NEXT_DATA ou JSON invalide -> vide', () => {
  assert.deepEqual(parseSyndicationProfile('<html>rien</html>', 'a'), []);
  assert.deepEqual(parseSyndicationProfile('<script id="__NEXT_DATA__" type="application/json">{pas json</script>', 'a'), []);
  assert.deepEqual(parseSyndicationProfile(null, 'a'), []);
});
