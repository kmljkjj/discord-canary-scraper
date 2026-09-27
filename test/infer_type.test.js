'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferType } = require('../src/lib/infer_type');

test('inferType classifie les expériences guild', () => {
  const guildIds = [
    '2024-01_guild_role_icons',
    '2024-02_server_raid_protection',
    '2024-03_community_onboarding',
    '2024-04_automod_v2_rules',
    '2024-05_channel_list_redesign',
    '2024-06_moderation_tools',
    '2024-07_role_subscription',
  ];
  for (const id of guildIds) {
    assert.equal(inferType(id), 'guild', `expected guild for ${id}`);
  }
});

test('inferType classifie les expériences user', () => {
  const userIds = [
    '2024-01_user_profiles',
    '2024-02_message_effects',
    '2024-03_settings_ui',
    '2024-04_payment_flow',
  ];
  for (const id of userIds) {
    assert.equal(inferType(id), 'user', `expected user for ${id}`);
  }
});

test('inferType retourne user par défaut', () => {
  assert.equal(inferType('2024-01_something_random'), 'user');
});

test('inferType gère les entrées vides ou nulles', () => {
  assert.equal(inferType(''), 'user');
  assert.equal(inferType(null), 'user');
  assert.equal(inferType(undefined), 'user');
  assert.equal(inferType(0), 'user');
});

test('inferType est insensible à la casse', () => {
  assert.equal(inferType('2024-01_GUILD_FOO'), 'guild');
  assert.equal(inferType('2024-01_Guild_Bar'), 'guild');
  assert.equal(inferType('2024-01_SERVER_Baz'), 'guild');
});
