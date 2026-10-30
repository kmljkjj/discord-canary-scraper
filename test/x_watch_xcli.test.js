'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXcliJsonl } = require('../src/x_watch');

test('parseXcliJsonl : lignes JSONL -> posts internes (champ date)', () => {
  const lines = [
    JSON.stringify({
      kind: 'x/tweet',
      id: '2112345678901234567',
      text: 'Rollout of the new profile theme!',
      created_at: '2026-10-30T10:00:00Z',
      author: { username: 'DiscordNEW8r', rest_id: '2073982489836584960' },
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/xyz?format=jpg&name=large' }],
    }),
    JSON.stringify({ id: '2112345678901234568', text: 'Second post' }),
  ].join('\n');
  const posts = parseXcliJsonl(lines, 'DiscordNEW8r');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, '2112345678901234567');
  assert.equal(posts[0].url, 'https://x.com/DiscordNEW8r/status/2112345678901234567');
  assert.equal(posts[0].date, '2026-10-30T10:00:00Z');
  assert.ok(posts[0].image.startsWith('https://pbs.twimg.com/'));
  assert.equal(posts[1].image, null);
});

test('parseXcliJsonl : invalides, ids courts, doublons -> ignores', () => {
  const lines = [
    '',
    'garbage',
    JSON.stringify({ id: '42', text: 'court' }),
    JSON.stringify({ id: '2112345678901234567', text: 'ok' }),
    JSON.stringify({ id: '2112345678901234567', text: 'doublon' }),
  ].join('\n');
  const posts = parseXcliJsonl(lines, 'DiscordNEW8r');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'ok');
});

test('parseXcliJsonl : entree vide -> tableau vide', () => {
  assert.deepEqual(parseXcliJsonl('', 'a'), []);
  assert.deepEqual(parseXcliJsonl(null, 'a'), []);
});
