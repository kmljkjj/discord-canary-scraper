'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDownloadStats,
  resetDownloadStats,
  DOWNLOAD_CONCURRENCY,
} = require('../src/lib/download');

test('getDownloadStats retourne un objet avec tous les compteurs', () => {
  const stats = getDownloadStats();
  assert.ok(typeof stats === 'object');
  assert.ok('jobs' in stats);
  assert.ok('downloaded' in stats);
  assert.ok('skipped' in stats);
  assert.ok('failed' in stats);
  assert.ok('retried' in stats);
  assert.ok('http429' in stats);
  assert.ok('http5xx' in stats);
});

test('resetDownloadStats remet tous les compteurs à zéro', () => {
  resetDownloadStats();
  const stats = getDownloadStats();
  for (const [key, val] of Object.entries(stats)) {
    assert.equal(val, 0, `${key} should be 0 after reset`);
  }
});

test('getDownloadStats retourne une copie (immuable)', () => {
  resetDownloadStats();
  const stats1 = getDownloadStats();
  stats1.downloaded = 999;
  const stats2 = getDownloadStats();
  assert.equal(stats2.downloaded, 0, 'mutating returned stats should not affect internal state');
});

test('DOWNLOAD_CONCURRENCY est un nombre positif', () => {
  assert.ok(typeof DOWNLOAD_CONCURRENCY === 'number');
  assert.ok(DOWNLOAD_CONCURRENCY > 0);
});
