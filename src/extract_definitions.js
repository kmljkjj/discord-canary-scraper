/**
 * Extract experiment definitions from Discord client JS.
 * Gives human-readable label, treatment descriptions, defaultConfig,
 * and a short "purpose" summary (what it does).
 */

const fs = require('fs-extra');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'definitions_client.json');

function parseConfigObj(s) {
  if (!s) return null;
  try {
    let t = s;
    t = t.replace(/!0/g, 'true').replace(/!1/g, 'false').replace(/void 0/g, 'null');
    t = t.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    t = t.replace(/(\d)e(\d+)/g, (_, a, b) => String(Number(`${a}e${b}`)));
    // trailing commas
    t = t.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(t);
  } catch {
    return { _raw: String(s).slice(0, 240) };
  }
}

function buildPurpose(def) {
  const parts = [];
  if (def.label) parts.push(def.label);
  const treats = (def.treatments || []).filter((t) => t.label && t.id !== 0);
  if (treats.length === 1) {
    parts.push(`→ ${treats[0].label}`);
  } else if (treats.length > 1) {
    parts.push(
      'Variants: ' +
        treats
          .slice(0, 5)
          .map((t) => `T${t.id}: ${t.label}`)
          .join(' · '),
    );
  }
  if (def.defaultConfig && typeof def.defaultConfig === 'object') {
    const keys = Object.keys(def.defaultConfig).filter((k) => k !== '_raw');
    if (keys.length && keys.length <= 6) {
      parts.push(`Config keys: ${keys.join(', ')}`);
    }
  }
  // Guess from id tokens
  if (!def.label && def.id) {
    const nice = String(def.id)
      .replace(/^20\d{2}-\d{2}[_-]/, '')
      .replace(/[_-]+/g, ' ');
    parts.unshift(nice);
  }
  return parts.join(' — ').slice(0, 500) || null;
}

function extractFromContent(content) {
  const defs = new Map();

  // id + label + defaultConfig (+ treatments nearby)
  const reA =
    /\{kind:"(user|guild)",id:"(20[2-3]\d-[0-1]\d_[a-z0-9_]+)",label:"((?:[^"\\]|\\.)*)",defaultConfig:(\{[\s\S]*?\})(?=,treatments:|,variations:|\})/g;
  let m;
  while ((m = reA.exec(content)) !== null) {
    const kind = m[1];
    const id = m[2];
    let label = m[3];
    try {
      label = JSON.parse(`"${label}"`);
    } catch {}
    const defaultConfig = parseConfigObj(m[4]);
    const rest = content.slice(m.endIndex || m.index + m[0].length, (m.index || 0) + 2500);
    // fix endIndex - use lastIndex
    const after = content.slice(reA.lastIndex, reA.lastIndex + 2500);
    const treatments = [];
    const tm = after.match(/treatments:\[([\s\S]*?)\](?:,|\})/);
    if (tm) {
      const tre = /\{id:(\d+),label:"((?:[^"\\]|\\.)*)"(?:,config:(\{[\s\S]*?\}))?/g;
      let t;
      while ((t = tre.exec(tm[1])) !== null) {
        let tlabel = t[2];
        try {
          tlabel = JSON.parse(`"${tlabel}"`);
        } catch {}
        treatments.push({
          id: Number(t[1]),
          label: tlabel,
          config: t[3] ? parseConfigObj(t[3]) : null,
        });
      }
    }
    defs.set(id, {
      id,
      kind,
      label,
      defaultConfig,
      treatments,
      source: 'client_definition',
    });
  }

  // name + variations style
  const reB =
    /\{name:"(20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]+)",kind:"(user|guild)",defaultConfig:(\{[\s\S]*?\})(?:,variations:(\{[\s\S]*?\}))?/g;
  while ((m = reB.exec(content)) !== null) {
    const id = m[1];
    const kind = m[2];
    const defaultConfig = parseConfigObj(m[3]);
    const treatments = [];
    if (m[4]) {
      const vre = /(\d+):(\{[\s\S]*?\})(?=,|\})/g;
      let v;
      while ((v = vre.exec(m[4])) !== null) {
        treatments.push({
          id: Number(v[1]),
          label: `Variation ${v[1]}`,
          config: parseConfigObj(v[2]),
        });
      }
    }
    if (!defs.has(id) || (treatments.length && !(defs.get(id).treatments || []).length)) {
      defs.set(id, {
        id,
        kind,
        label: id.replace(/^20\d{2}-\d{2}[_-]/, '').replace(/[_-]+/g, ' '),
        defaultConfig,
        treatments,
        source: 'client_name_variations',
      });
    }
  }

  // Attach purpose
  for (const d of defs.values()) {
    d.purpose = buildPurpose(d);
  }
  return defs;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(ASSETS_DIR))) {
    console.log('No assets dir — skip client definition extract');
    await fs.writeJson(OUT_FILE, { scrapedAt: new Date().toISOString(), definitions: {} }, { spaces: 2 });
    return;
  }
  const files = (await fs.readdir(ASSETS_DIR)).filter((f) => f.endsWith('.js'));
  files.sort((a, b) => (/^web\./i.test(a) ? 0 : 1) - (/^web\./i.test(b) ? 0 : 1));

  const all = new Map();
  for (const file of files.slice(0, 25)) {
    const full = path.join(ASSETS_DIR, file);
    const st = await fs.stat(full);
    if (st.size > 20_000_000) continue;
    let content = await fs.readFile(full, 'utf8');
    if (st.size > 12_000_000) content = content.slice(0, 12_000_000);
    const found = extractFromContent(content);
    for (const [id, def] of found) {
      const prev = all.get(id);
      if (
        !prev ||
        (def.treatments?.length || 0) > (prev.treatments?.length || 0) ||
        (def.label && !prev.label)
      ) {
        all.set(id, def);
      }
    }
    if (found.size) console.log(`  ${file}: +${found.size} defs`);
  }

  const definitions = Object.fromEntries(
    [...all.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
  await fs.writeJson(
    OUT_FILE,
    {
      scrapedAt: new Date().toISOString(),
      count: Object.keys(definitions).length,
      definitions,
    },
    { spaces: 2 },
  );
  console.log(`📚 definitions_client.json — ${Object.keys(definitions).length} experiments with metadata`);
}

module.exports = { extractFromContent, buildPurpose, main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
