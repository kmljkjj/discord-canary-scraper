'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sleep,
  redactSecrets,
  loadTokens,
  firstToken,
  DEFAULT_UA,
  DEFAULT_BOT_NAME,
  DEFAULT_AVATAR_URL,
} = require('../src/lib/utils');

test('sleep returns a promise that resolves', async () => {
  const start = Date.now();
  await sleep(50);
  assert.ok(Date.now() - start >= 40, 'sleep should wait at least the requested duration');
});

test('redactSecrets masque les JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789';
  const redacted = redactSecrets('Token: ' + jwt);
  assert.ok(!redacted.includes(jwt), 'JWT should be redacted');
  assert.ok(redacted.includes('[REDACTED_JWT]'));
});

test('redactSecrets masque les MFA tokens', () => {
  const token = 'mfa.abcdef1234567890123456789012345';
  const redacted = redactSecrets('Error: ' + token);
  assert.ok(!redacted.includes(token));
  assert.ok(redacted.includes('[REDACTED_TOKEN]'));
});

test('redactSecrets masque les Bot tokens', () => {
  const token = 'Bot abcdefghijklmnopqrstuvwxyz1234567890';
  const redacted = redactSecrets('Auth: ' + token);
  assert.ok(!redacted.includes(token));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redactSecrets gère les entrées nulles ou vides', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
});

test('redactSecrets ne modifie pas les messages normaux', () => {
  const msg = 'Build 123456 updated successfully';
  assert.equal(redactSecrets(msg), msg);
});

test('DEFAULT_UA est une chaîne non vide', () => {
  assert.equal(typeof DEFAULT_UA, 'string');
  assert.ok(DEFAULT_UA.length > 20);
  assert.ok(DEFAULT_UA.includes('Chrome'));
});

test('DEFAULT_BOT_NAME est une chaîne non vide', () => {
  assert.equal(typeof DEFAULT_BOT_NAME, 'string');
  assert.ok(DEFAULT_BOT_NAME.length > 0);
});

test('DEFAULT_AVATAR_URL est une URL valide', () => {
  assert.ok(DEFAULT_AVATAR_URL.startsWith('https://'));
});

test('loadTokens retourne un tableau', () => {
  const tokens = loadTokens();
  assert.ok(Array.isArray(tokens));
});

test('loadTokens déduplique les tokens', () => {
  // If DISCORD_TOKEN is set to the same value as DISCORD_USER_TOKEN, it should be deduplicated
  const tokens = loadTokens();
  const unique = new Set(tokens);
  assert.equal(tokens.length, unique.size, 'tokens should be unique');
});

test('firstToken retourne null si aucun token', () => {
  // Save and clear env
  const saved = {};
  for (const k of ['DISCORD_USER_TOKENS', 'DISCORD_USER_TOKEN', 'DISCORD_TOKEN']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (let i = 1; i <= 10; i++) {
    saved['DISCORD_USER_TOKEN_' + i] = process.env['DISCORD_USER_TOKEN_' + i];
    saved['DISCORD_USER_TOKENS' + i] = process.env['DISCORD_USER_TOKENS' + i];
    delete process.env['DISCORD_USER_TOKEN_' + i];
    delete process.env['DISCORD_USER_TOKENS' + i];
  }
  const result = firstToken();
  // Restore env
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  assert.equal(result, null);
});
