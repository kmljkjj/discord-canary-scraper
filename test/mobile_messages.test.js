/**
 * Tests for mobile notification message builders.
 */
const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/mobile_versions');
const f = require('../src/mobile_from_files');

const ios = {
  platform: 'ios', channel: 'stable', version: '347.0', size: '250 MB', requires: 'iOS 16.0+',
  artwork: 'https://example.com/icon.png', releaseDate: '2026-10-28T10:00:00Z',
  releaseNotes: 'Bug fixes\nPerformance', source: 'itunes_lookup', storeUrl: 'https://apps.apple.com/app/id985746746',
  checkedAt: '2026-10-29T12:00:00Z',
};

test('bumpKind detects major/minor', () => {
  assert.strictEqual(m.bumpKind('346.5', '347.0'), 'major');
  assert.strictEqual(m.bumpKind('346.5', '346.6'), 'minor');
  assert.strictEqual(m.bumpKind(null, '346.6'), null);
});

test('release components: section with thumbnail, timestamps, buttons, footer', () => {
  const comps = m.buildReleaseComponents({ type: 'updated', channel: ios, previous: { version: '346.0' } });
  assert.strictEqual(comps[0].type, 9);
  assert.strictEqual(comps[0].accessory.type, 11);
  assert.match(comps[0].components[0].content, /346\.0 → 347\.0/);
  assert.match(comps[0].components[0].content, /Major update/);
  const text = JSON.stringify(comps);
  assert.match(text, /<t:\d+:R>/);
  assert.ok(comps.some((c) => c.type === 1 && c.components.length >= 1));
  assert.match(comps[comps.length - 1].content, /^-# Datamining/);
});

test('release components without artwork fall back to text header', () => {
  const comps = m.buildReleaseComponents({ type: 'new', channel: { platform: 'android', channel: 'beta', version: '348.1', build: '34810100463173', checkedAt: '2026-10-29T12:00:00Z' } });
  assert.strictEqual(comps[0].type, 10);
  assert.match(comps[0].content, /First seen/);
  assert.match(JSON.stringify(comps), /track 1 \(beta\)/);
});

test('summary groups by platform and sortChanges orders ios first', () => {
  const changes = m.sortChanges([
    { type: 'new', channel: { platform: 'android', channel: 'alpha', version: '349.0' } },
    { type: 'updated', channel: { platform: 'ios', channel: 'stable', version: '347.0' }, previous: { version: '346.0' } },
  ]);
  assert.strictEqual(changes[0].channel.platform, 'ios');
  const s = JSON.stringify(m.buildSummaryComponents(changes));
  assert.match(s, /2 new versions/);
  assert.match(s, /iOS/);
  assert.match(s, /Android/);
});

test('trimText cuts on word boundary with ellipsis', () => {
  const out = m.trimText('hello world foo bar baz', 15);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 16);
});

test('mobile files: grouped experiments embed', () => {
  const e = f.experimentsEmbed([{ id: '2026-10_foo', type: 'guild' }, { id: '2026-10_bar', type: 'user' }], { commit: 'abc', message: 'rev' });
  assert.match(e.title, /2 new/);
  assert.ok(e.fields.some((x) => /guild/.test(x.name)));
  const s = f.stringsEmbed({ ABCDEF: 'Hello' }, { commit: 'abc' });
  assert.match(s.description, /```diff/);
});
