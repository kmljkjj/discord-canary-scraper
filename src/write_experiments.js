/**
 * Builds data/experiments.json after a scrape.
 * Merges client findings, guild %, user sampling, and rich definitions
 * (label, purpose, treatment configs).
 */
const fs = require('fs-extra');
const path = require('path');
const { buildExperimentsCatalog } = require('./experiments_catalog');
const { buildPurpose } = require('./extract_definitions');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const EXPERIMENTS_FILE = path.join(DATA_DIR, 'experiments.json');
const USER_ROLLOUTS_FILE = path.join(DATA_DIR, 'user_rollouts.json');
const CLIENT_DEFS_FILE = path.join(DATA_DIR, 'definitions_client.json');

function normalizeId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/-/g, '_');
}

async function main() {
  await fs.ensureDir(DATA_DIR);

  let findings = { experiments: [] };
  let guild = [];
  let build = {};
  let userRollouts = { experiments: [] };
  let clientDefs = { definitions: {} };

  try {
    if (await fs.pathExists(FINDINGS_FILE)) findings = await fs.readJson(FINDINGS_FILE);
  } catch {}
  try {
    if (await fs.pathExists(GUILD_EXP_FILE)) guild = await fs.readJson(GUILD_EXP_FILE);
  } catch {}
  try {
    if (await fs.pathExists(BUILD_FILE)) build = await fs.readJson(BUILD_FILE);
  } catch {}
  try {
    if (await fs.pathExists(USER_ROLLOUTS_FILE))
      userRollouts = await fs.readJson(USER_ROLLOUTS_FILE);
  } catch {}
  try {
    if (await fs.pathExists(CLIENT_DEFS_FILE))
      clientDefs = await fs.readJson(CLIENT_DEFS_FILE);
  } catch {}

  let previousCatalog = null;
  try {
    if (await fs.pathExists(EXPERIMENTS_FILE)) {
      previousCatalog = await fs.readJson(EXPERIMENTS_FILE);
    }
  } catch {}

  // Index definitions by normalized id
  const defById = new Map();
  for (const [id, def] of Object.entries(clientDefs.definitions || {})) {
    defById.set(normalizeId(id), def);
    defById.set(normalizeId(id.replace(/_/g, '-')), def);
  }

  const guildEnriched = (Array.isArray(guild) ? guild : []).map((g) => ({
    ...g,
    id: g.id || g.definitionId || (g.hash != null ? `hash:${g.hash}` : null),
    aaMode: g.aaMode,
    rolloutSummary: g.rolloutSummary || [],
  }));

  const userById = new Map();
  const userByHash = new Map();
  for (const u of userRollouts.experiments || []) {
    if (u.id) userById.set(normalizeId(u.id), u);
    if (u.hash != null) userByHash.set(Number(u.hash), u);
  }

  const clientEnriched = (findings.experiments || []).map((e) => {
    const def =
      defById.get(normalizeId(e.id)) ||
      defById.get(normalizeId(String(e.id).replace(/-/g, '_'))) ||
      null;
    const sampled =
      userById.get(normalizeId(e.id)) ||
      (e.hash != null ? userByHash.get(Number(e.hash)) : null);

    let treatments = e.treatments || [];
    if (def?.treatments?.length) {
      treatments = def.treatments.map((t) => {
        const match = (sampled?.treatments || []).find(
          (s) => String(s.id) === String(t.id),
        );
        return {
          id: t.id,
          label: t.label,
          config: t.config || null,
          percent: match?.percent,
          ranges: match?.ranges,
        };
      });
    } else if (sampled?.treatments?.length && !treatments.length) {
      treatments = sampled.treatments;
    }

    const label = def?.label || e.label || null;
    const defaultConfig = def?.defaultConfig || e.defaultConfig || null;
    const purpose =
      def?.purpose ||
      buildPurpose({
        id: e.id,
        label,
        treatments,
        defaultConfig,
      });

    return {
      ...e,
      label,
      purpose,
      defaultConfig,
      treatments,
      definitionSource: def?.source || null,
      sampledRollout: sampled
        ? {
            reliability: sampled.reliability,
            method: sampled.method,
            totalSamples: sampled.totalSamples,
          }
        : null,
    };
  });

  // Add defs not in client scan
  const seen = new Set(clientEnriched.map((e) => normalizeId(e.id)));
  for (const [id, def] of Object.entries(clientDefs.definitions || {})) {
    if (seen.has(normalizeId(id))) continue;
    clientEnriched.push({
      id: def.id,
      kind: def.kind || 'user',
      type: def.kind || 'user',
      label: def.label,
      purpose: def.purpose || buildPurpose(def),
      defaultConfig: def.defaultConfig,
      treatments: def.treatments || [],
      definitionSource: def.source,
      isApex: false,
    });
  }

  const catalog = buildExperimentsCatalog({
    clientEnriched,
    guildEnriched,
    previousCatalog,
    buildNumber: build.buildNumber || null,
    scrapedAt: build.scrapedAt || new Date().toISOString(),
  });

  // Final enrich catalog rows
  catalog.experiments = catalog.experiments.map((e) => {
    const def = defById.get(normalizeId(e.id));
    const sampled = userById.get(normalizeId(e.id));
    const purpose =
      e.purpose ||
      def?.purpose ||
      buildPurpose({
        id: e.id,
        label: e.label || def?.label,
        treatments: e.treatments || def?.treatments,
        defaultConfig: def?.defaultConfig,
      });

    const base = {
      ...e,
      label: e.label || def?.label || null,
      purpose,
      defaultConfig: e.defaultConfig || def?.defaultConfig || null,
    };

    if (e.kind === 'guild' && e.treatments?.length) {
      return {
        ...base,
        percentSource: 'api_guild_populations',
        percentReliable: true,
      };
    }
    if (sampled) {
      return {
        ...base,
        percentSource: 'sampled_user_assignments',
        percentReliable: false,
        reliability: sampled.reliability,
      };
    }
    return {
      ...base,
      percentSource: e.percentSource || 'none',
      percentReliable: false,
    };
  });

  await fs.writeJson(EXPERIMENTS_FILE, catalog, { spaces: 2 });
  console.log(
    `🧪 experiments.json: ${catalog.totals.all} total | +${catalog.totals.added} added | ~${catalog.totals.treatments_changed} changed`,
  );
  const withPurpose = catalog.experiments.filter((e) => e.purpose).length;
  console.log(`   with purpose/summary: ${withPurpose}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
