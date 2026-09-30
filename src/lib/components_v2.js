/**
 * Discord Components V2 builder.
 *
 * Converts legacy embed structures to Components V2 format:
 * - Container (type 17) with accent_color replaces embed color
 * - TextDisplay (type 10) replaces fields/title/description
 * - Separator (type 14) between sections
 *
 * Limits handled automatically:
 * - TextDisplay content: 4000 chars (auto-split into multiple TextDisplays)
 * - Components per Container: 10 (auto-split into multiple Containers)
 * - Total components per message: 40
 * - Messages sent sequentially via webhook URL queue
 *
 * @see https://docs.discord.com/developers/components/reference
 */

const IS_COMPONENTS_V2_FLAG = 1 << 15; // 32768

/** Maximum characters per TextDisplay content. */
const TEXT_DISPLAY_MAX = 4000;

/** Maximum components per Container. */
const CONTAINER_MAX_COMPONENTS = 10;

/** Maximum total components per message. */
const MESSAGE_MAX_COMPONENTS = 40;

/**
 * Build a single TextDisplay component.
 * @param {string} content - Markdown text (max 4000 chars)
 * @returns {{type:number,content:string}}
 */
function textDisplay(content) {
  return { type: 10, content: String(content).slice(0, TEXT_DISPLAY_MAX) };
}

/**
 * Build a Separator component.
 * @param {boolean} [divider=true] - Show a divider line
 * @param {number} [spacing=1] - 1=small, 2=large
 * @returns {{type:number,divider:boolean,spacing:number}}
 */
function separator(divider = true, spacing = 1) {
  return { type: 14, divider, spacing };
}

/**
 * Build a Container component.
 * @param {Array} components - Child components
 * @param {number} [accentColor] - RGB color
 * @returns {{type:number,components:Array,accent_color?:number}}
 */
function container(components, accentColor) {
  const c = { type: 17, components };
  if (accentColor != null) c.accent_color = accentColor;
  return c;
}

/**
 * Split text into chunks that fit within TextDisplay limit.
 * Tries to split on newlines, then on spaces, then hard-cuts.
 * @param {string} text - Text to chunk
 * @param {number} [maxLen=TEXT_DISPLAY_MAX] - Max chars per chunk
 * @returns {string[]} Array of text chunks
 */
function chunkText(text, maxLen = TEXT_DISPLAY_MAX) {
  const str = String(text || '');
  if (str.length <= maxLen) return [str];

  const chunks = [];
  let pos = 0;
  while (pos < str.length) {
    let end = pos + maxLen;
    if (end >= str.length) {
      chunks.push(str.slice(pos));
      break;
    }

    // Try to find a newline to split on (within the last 200 chars)
    let splitAt = -1;
    for (let i = end; i > end - 200 && i > pos; i--) {
      if (str[i] === '\n') {
        splitAt = i + 1;
        break;
      }
    }
    // Fall back to space
    if (splitAt < 0) {
      for (let i = end; i > end - 200 && i > pos; i--) {
        if (str[i] === ' ') {
          splitAt = i + 1;
          break;
        }
      }
    }
    // Hard cut
    if (splitAt < 0) splitAt = end;

    chunks.push(str.slice(pos, splitAt));
    pos = splitAt;
  }
  return chunks;
}

/**
 * Build a link button (style 5) that works on non-app webhooks.
 * @param {string} label - Button text
 * @param {string} url - URL to open
 * @returns {{type:number,style:number,label:string,url:string}}
 */
function linkButton(label, url) {
  return { type: 2, style: 5, label: String(label).slice(0, 80), url: String(url).slice(0, 512) };
}

/**
 * Build an ActionRow containing a dismiss button.
 * Uses link button (style 5) since webhooks can't handle interactions.
 * The button links to discord.com so the user can navigate to the message
 * and delete it manually.
 * @param {string} [label='Dismiss'] - Button label
 * @returns {{type:number,components:Array}}
 */
function dismissButton(label = 'Dismiss') {
  return {
    type: 1, // ActionRow
    components: [linkButton(label, 'https://discord.com')],
  };
}

/**
 * Add a dismiss button to the last container of each message.
 * If the last component is a Container, adds the ActionRow inside it.
 * Otherwise, adds the ActionRow as a top-level component.
 *
 * @param {Array<Array>} messages - Array of message component arrays
 * @returns {Array<Array>} Messages with dismiss button added
 */
function addDismissToMessages(messages) {
  for (const msg of messages) {
    // Find the last container in the message
    let lastContainer = null;
    for (const comp of msg) {
      if (comp.type === 17) lastContainer = comp;
    }
    if (lastContainer && lastContainer.components.length < CONTAINER_MAX_COMPONENTS) {
      lastContainer.components.push(dismissButton());
    } else {
      // No container or container is full — add as top-level
      msg.push(dismissButton());
    }
  }
  return messages;
}

/**
 * Split a list of components into messages that respect the 40-component limit.
 * Each message gets its own Container with the accent color.
 * @param {Array} components - Flat list of components
 * @param {number} [accentColor] - Container accent color
 * @param {boolean} [withDismiss=false] - Add a dismiss button to each message
 * @returns {Array<Array>} Array of message component arrays
 */
function chunkIntoMessages(components, accentColor, withDismiss = false) {
  const messages = [];
  let current = [];
  let containerCount = 0;

  for (const comp of components) {
    // Each component counts toward the 40 limit (containers count too)
    if (current.length >= CONTAINER_MAX_COMPONENTS || containerCount >= MESSAGE_MAX_COMPONENTS - 1) {
      messages.push([container(current, accentColor)]);
      current = [];
      containerCount = 0;
    }
    current.push(comp);
    containerCount++;
  }
  if (current.length) {
    messages.push([container(current, accentColor)]);
  }
  if (withDismiss) {
    addDismissToMessages(messages);
  }
  return messages;
}

/**
 * Convert lines (like the old chunkLines output) into Components V2.
 * Each section becomes a Container with TextDisplay children and separators.
 *
 * @param {Object} params
 * @param {string} params.title - Message title (e.g. "Experiments")
 * @param {string} params.bn - Build number
 * @param {string} params.ts - ISO timestamp
 * @param {string} [params.botName] - Bot name for header
 * @param {string} [params.avatarUrl] - Avatar URL
 * @param {Array} params.sections - Array of {label, color, count, lines}
 * @param {boolean} [params.withDismiss=false] - Add a dismiss button to each message
 * @returns {Array<Array>} Array of message payloads (each is a components array)
 */
function buildSectionMessages({ title, bn, ts, sections, withDismiss = false }) {
  const allComponents = [];

  for (const sec of sections) {
    if (!sec.lines || !sec.lines.length) continue;

    // Build header text for this section
    const headerText = `### ${sec.label}\nBuild ${bn} · **${sec.count}** items`;

    // Join all lines into one text block
    const fullText = sec.lines.join('\n');

    // Split into TextDisplay-sized chunks
    const textChunks = chunkText(fullText);

    // Add header as first TextDisplay
    allComponents.push(textDisplay(headerText));

    // Add text chunks
    for (const chunk of textChunks) {
      allComponents.push(textDisplay(chunk));
    }

    // Add separator between sections
    allComponents.push(separator(true, 1));
  }

  // Remove trailing separator
  if (allComponents.length && allComponents[allComponents.length - 1].type === 14) {
    allComponents.pop();
  }

  // Split into messages (respecting 40-component limit)
  // Use the first section's color as the container accent
  const accentColor = sections.find((s) => s.color != null)?.color;
  return chunkIntoMessages(allComponents, accentColor, withDismiss);
}

/**
 * Convert a legacy embed object to Components V2 message(s).
 * Handles title, description, fields, color, footer, author.
 *
 * @param {Object} embed - Legacy Discord embed
 * @param {boolean} [withDismiss=false] - Add a dismiss button to each message
 * @returns {Array<Array>} Array of message component arrays
 */
function embedToComponents(embed, withDismiss = false) {
  const components = [];

  // Author + Title
  const headerParts = [];
  if (embed.author && embed.author.name) headerParts.push(`**${embed.author.name}**`);
  if (embed.title) headerParts.push(`## ${embed.title}`);
  if (headerParts.length) {
    const header = headerParts.join('\n');
    for (const chunk of chunkText(header)) {
      components.push(textDisplay(chunk));
    }
  }

  // Description
  if (embed.description) {
    for (const chunk of chunkText(embed.description)) {
      components.push(textDisplay(chunk));
    }
  }

  // Fields
  if (embed.fields && embed.fields.length) {
    for (const field of embed.fields) {
      const fieldText = `**${field.name || ''}**\n${field.value || ''}`;
      for (const chunk of chunkText(fieldText)) {
        components.push(textDisplay(chunk));
      }
    }
  }

  // Footer
  if (embed.footer && embed.footer.text) {
    if (components.length > 0) components.push(separator(false, 1));
    components.push(textDisplay(`-# ${embed.footer.text}`));
  }

  if (!components.length) {
    components.push(textDisplay(' '));
  }

  const accentColor = embed.color;
  return chunkIntoMessages(components, accentColor, withDismiss);
}

/**
 * Convert multiple legacy embeds into Components V2 message(s).
 * Embeds are concatenated and split respecting limits.
 *
 * @param {Array} embeds - Array of legacy Discord embeds
 * @param {boolean} [withDismiss=false] - Add a dismiss button to each message
 * @returns {Array<Array>} Array of message component arrays
 */
function embedsToComponents(embeds, withDismiss = false) {
  const allComponents = [];

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    if (i > 0) allComponents.push(separator(true, 2));

    // Add embed content
    const headerParts = [];
    if (embed.author && embed.author.name) headerParts.push(`**${embed.author.name}**`);
    if (embed.title) headerParts.push(`## ${embed.title}`);

    if (headerParts.length) {
      const header = headerParts.join('\n');
      for (const chunk of chunkText(header)) {
        allComponents.push(textDisplay(chunk));
      }
    }

    if (embed.description) {
      for (const chunk of chunkText(embed.description)) {
        allComponents.push(textDisplay(chunk));
      }
    }

    if (embed.fields && embed.fields.length) {
      for (const field of embed.fields) {
        const fieldText = `**${field.name || ''}**\n${field.value || ''}`;
        for (const chunk of chunkText(fieldText)) {
          allComponents.push(textDisplay(chunk));
        }
      }
    }

    if (embed.footer && embed.footer.text) {
      allComponents.push(textDisplay(`-# ${embed.footer.text}`));
    }
  }

  if (!allComponents.length) {
    allComponents.push(textDisplay(' '));
  }

  // Use first embed's color
  const accentColor = embeds.find((e) => e && e.color != null)?.color;
  return chunkIntoMessages(allComponents, accentColor, withDismiss);
}

module.exports = {
  IS_COMPONENTS_V2_FLAG,
  TEXT_DISPLAY_MAX,
  CONTAINER_MAX_COMPONENTS,
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
};
