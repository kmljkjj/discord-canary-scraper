'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXcliJsonl } = require('../src/x_news');

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
