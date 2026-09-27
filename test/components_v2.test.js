/**
 * Tests for src/lib/components_v2.js
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  IS_COMPONENTS_V2_FLAG,
  TEXT_DISPLAY_MAX,
  MESSAGE_MAX_COMPONENTS,
  textDisplay,
  separator,
  container,
  linkButton,
  dismissButton,
  addDismissToMessages,
  chunkText,
  chunkIntoMessages,
  buildSectionMessages,
  embedToComponents,
  embedsToComponents,
} = require('../src/lib/components_v2');

test('IS_COMPONENTS_V2_FLAG is 32768', () => {
  assert.strictEqual(IS_COMPONENTS_V2_FLAG, 32768);
  assert.strictEqual(IS_COMPONENTS_V2_FLAG, 1 << 15);
});

test('textDisplay builds type 10 component', () => {
  const td = textDisplay('hello world');
  assert.strictEqual(td.type, 10);
  assert.strictEqual(td.content, 'hello world');
});

test('textDisplay truncates to TEXT_DISPLAY_MAX', () => {
  const long = 'a'.repeat(TEXT_DISPLAY_MAX + 100);
  const td = textDisplay(long);
  assert.strictEqual(td.content.length, TEXT_DISPLAY_MAX);
});

test('separator builds type 14 component', () => {
  const sep = separator();
  assert.strictEqual(sep.type, 14);
  assert.strictEqual(sep.divider, true);
  assert.strictEqual(sep.spacing, 1);
});

test('container builds type 17 component with accent color', () => {
  const c = container([textDisplay('hi')], 0xff0000);
  assert.strictEqual(c.type, 17);
  assert.strictEqual(c.components.length, 1);
  assert.strictEqual(c.accent_color, 0xff0000);
});

test('container without accent color omits the field', () => {
  const c = container([textDisplay('hi')]);
  assert.strictEqual(c.type, 17);
  assert.strictEqual(c.components.length, 1);
  assert.strictEqual(c.accent_color, undefined);
});

test('chunkText returns single chunk when under limit', () => {
  const result = chunkText('short text');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], 'short text');
});

test('chunkText splits long text at newline boundaries', () => {
  const line = 'a'.repeat(100) + '\n';
  const text = line.repeat(50); // ~5050 chars
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TEXT_DISPLAY_MAX, `chunk too long: ${chunk.length}`);
  }
  // Verify reassembly
  assert.strictEqual(chunks.join(''), text);
});

test('chunkText handles empty string', () => {
  const result = chunkText('');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], '');
});

test('chunkText handles null/undefined', () => {
  assert.strictEqual(chunkText(null).length, 1);
  assert.strictEqual(chunkText(undefined).length, 1);
});

test('chunkText hard-cuts when no break point found', () => {
  const text = 'a'.repeat(TEXT_DISPLAY_MAX * 2 + 100);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TEXT_DISPLAY_MAX);
  }
  assert.strictEqual(chunks.join(''), text);
});

test('chunkIntoMessages respects component limit per message', () => {
  // Create 50 components — should split into 2+ messages
  const components = [];
  for (let i = 0; i < 50; i++) {
    components.push(textDisplay(`item ${i}`));
  }
  const messages = chunkIntoMessages(components, 0x5865f2);
  assert.ok(messages.length >= 2);
  // Each message should have at most CONTAINER_MAX_COMPONENTS + 1 (container itself)
  for (const msg of messages) {
    assert.ok(msg.length <= MESSAGE_MAX_COMPONENTS);
  }
});

test('embedToComponents converts basic embed', () => {
  const embed = {
    title: 'Test Title',
    description: 'Test description',
    color: 0x5865f2,
  };
  const messages = embedToComponents(embed);
  assert.ok(messages.length >= 1);
  // First message should contain a container
  const first = messages[0];
  assert.strictEqual(first[0].type, 17); // Container
  // Container should have text display components
  const container = first[0];
  assert.ok(container.components.length >= 1);
  assert.strictEqual(container.components[0].type, 10); // TextDisplay
});

test('embedToComponents handles embed with fields', () => {
  const embed = {
    title: 'Test',
    fields: [
      { name: 'Field 1', value: 'Value 1' },
      { name: 'Field 2', value: 'Value 2' },
    ],
  };
  const messages = embedToComponents(embed);
  assert.ok(messages.length >= 1);
});

test('embedToComponents handles embed with author and footer', () => {
  const embed = {
    author: { name: 'TestBot' },
    title: 'Title',
    footer: { text: 'Footer text' },
  };
  const messages = embedToComponents(embed);
  assert.ok(messages.length >= 1);
  // Check that footer text is included as a TextDisplay
  const allContent = JSON.stringify(messages);
  assert.ok(allContent.includes('Footer text'));
});

test('embedToComponents handles empty embed', () => {
  const embed = {};
  const messages = embedToComponents(embed);
  assert.ok(messages.length >= 1);
});

test('embedsToComponents converts multiple embeds', () => {
  const embeds = [
    { title: 'First', description: 'First desc', color: 0xff0000 },
    { title: 'Second', description: 'Second desc', color: 0x00ff00 },
  ];
  const messages = embedsToComponents(embeds);
  assert.ok(messages.length >= 1);
  // Should have separators between embeds
  const allContent = JSON.stringify(messages);
  assert.ok(allContent.includes('First'));
  assert.ok(allContent.includes('Second'));
});

test('buildSectionMessages builds from sections', () => {
  const sections = [
    {
      label: 'Experiments',
      color: 0x5865f2,
      count: 5,
      lines: ['exp1', 'exp2', 'exp3'],
    },
    {
      label: 'Strings',
      color: 0x57f287,
      count: 3,
      lines: ['str1', 'str2', 'str3'],
    },
  ];
  const messages = buildSectionMessages({
    title: 'Experiments',
    bn: '300000',
    ts: new Date().toISOString(),
    sections,
  });
  assert.ok(messages.length >= 1);
  // Verify container has content
  const container = messages[0][0];
  assert.strictEqual(container.type, 17);
  assert.ok(container.components.length >= 1);
});

test('buildSectionMessages handles empty sections', () => {
  const messages = buildSectionMessages({
    title: 'Test',
    bn: '100',
    ts: '',
    sections: [],
  });
  // No sections → no components, but should return empty array
  assert.ok(Array.isArray(messages));
});

test('buildSectionMessages uses first section color as container accent', () => {
  const sections = [
    { label: 'A', color: 0x123456, count: 1, lines: ['x'] },
    { label: 'B', color: 0xabcdef, count: 1, lines: ['y'] },
  ];
  const messages = buildSectionMessages({
    title: 'T',
    bn: '1',
    ts: '',
    sections,
  });
  assert.ok(messages.length >= 1);
  const container = messages[0][0];
  assert.strictEqual(container.accent_color, 0x123456);
});

test('chunkText preserves text exactly when reassembled', () => {
  // Generate text with various break points
  const parts = [];
  for (let i = 0; i < 100; i++) {
    parts.push(`Line ${i}: ${'x'.repeat(50)}`);
  }
  const text = parts.join('\n');
  const chunks = chunkText(text, 200);
  assert.strictEqual(chunks.join(''), text);
});

test('linkButton builds a style 5 button', () => {
  const btn = linkButton('Click me', 'https://example.com');
  assert.strictEqual(btn.type, 2);
  assert.strictEqual(btn.style, 5);
  assert.strictEqual(btn.label, 'Click me');
  assert.strictEqual(btn.url, 'https://example.com');
});

test('linkButton truncates label to 80 chars', () => {
  const btn = linkButton('a'.repeat(100), 'https://example.com');
  assert.strictEqual(btn.label.length, 80);
});

test('dismissButton builds an ActionRow with a link button', () => {
  const row = dismissButton();
  assert.strictEqual(row.type, 1); // ActionRow
  assert.strictEqual(row.components.length, 1);
  assert.strictEqual(row.components[0].type, 2); // Button
  assert.strictEqual(row.components[0].style, 5); // Link
  assert.ok(row.components[0].label);
  assert.ok(row.components[0].url);
});

test('dismissButton accepts custom label', () => {
  const row = dismissButton('Effacer');
  assert.strictEqual(row.components[0].label, 'Effacer');
});

test('addDismissToMessages adds button to container', () => {
  const messages = [[
    container([textDisplay('hello')], 0xff0000),
  ]];
  addDismissToMessages(messages);
  const c = messages[0][0];
  // Container should now have 2 components: textDisplay + dismiss ActionRow
  assert.strictEqual(c.components.length, 2);
  assert.strictEqual(c.components[1].type, 1); // ActionRow
  assert.strictEqual(c.components[1].components[0].style, 5); // Link button
});

test('addDismissToMessages handles full container', () => {
  // Fill container to max
  const children = [];
  for (let i = 0; i < 10; i++) children.push(textDisplay(`item ${i}`));
  const messages = [[container(children, 0xff0000)]];
  addDismissToMessages(messages);
  // Dismiss button should be added as top-level component
  assert.ok(messages[0].length >= 2);
  const last = messages[0][messages[0].length - 1];
  assert.strictEqual(last.type, 1); // ActionRow
});

test('embedsToComponents with withDismiss=true adds dismiss button', () => {
  const embeds = [{ title: 'Test', description: 'Hello' }];
  const messages = embedsToComponents(embeds, true);
  assert.ok(messages.length >= 1);
  // Last component of last message should be an ActionRow (dismiss button)
  const lastMsg = messages[messages.length - 1];
  const container = lastMsg[0];
  const lastComp = container.components[container.components.length - 1];
  assert.strictEqual(lastComp.type, 1); // ActionRow
  assert.strictEqual(lastComp.components[0].style, 5); // Link button
});

test('buildSectionMessages with withDismiss=true adds dismiss button', () => {
  const sections = [
    { label: 'Experiments', color: 0x5865f2, count: 2, lines: ['exp1', 'exp2'] },
  ];
  const messages = buildSectionMessages({
    title: 'Experiments',
    bn: '300000',
    ts: '',
    sections,
    withDismiss: true,
  });
  assert.ok(messages.length >= 1);
  const container = messages[0][0];
  const lastComp = container.components[container.components.length - 1];
  assert.strictEqual(lastComp.type, 1); // ActionRow
  assert.strictEqual(lastComp.components[0].style, 5); // Link button
});
