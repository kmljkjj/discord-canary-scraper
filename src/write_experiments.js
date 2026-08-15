/**
 * Builds data/experiments.json after a scrape.
 * Merges:
 *  - client findings + definitions (variations)
 *  - guild API real %
 *  - user_rollouts.json estimated % (DEH/Wumpus-style sampling)
 */
const fs = require('fs-extra');
const path = require('path');
const { buildExperimentsCatalog } = require('./experiments_catalog');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const EXPERIMENTS_FILE = path.join(DATA_DIR, 'experiments.json');
const USER_ROLLOUTS_FILE = path.join(DATA_DIR, 'user_rollouts.json');

async function main() {
  await fs.ensureDir(DATA_DIR);

  let findings = { experiments: [] };
  let guild = [];
  let build = {};
  let userRollouts = { experiments: [] };

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

  let previousCatalog = null;
  try {
    if (await fs.pathExists(EXPERIMENTS_FILE)) {
      previousCatalog = await fs.readJson(EXPERIMENTS_FILE);
    }
  } catch {}

  const guildEnriched = (Array.isArray(guild) ? guild : []).map((g) => ({
    ...g,
    id: g.id || g.definitionId || (g.hash != null ? `hash:${g.hash}` : null),
    aaMode: g.aaMode,
    rolloutSummary: g.rolloutSummary || [],
  }));

  // Index sampled user % by id and hash
  const userById = new Map();
  const userByHash = new Map();
  for (const u of userRollouts.experiments || []) {
    if (u.id) userById.set(String(u.id).toLowerCase(), u);
    if (u.hash != null) userByHash.set(Number(u.hash), u);
  }

  // Attach estimated % onto client experiments before catalog build
  const clientEnriched = (findings.experiments || []).map((e) => {
    const sampled =
      userById.get(String(e.id).toLowerCase()) ||
      (e.hash != null ? userByHash.get(Number(e.hash)) : null);
    if (!sampled) return e;
    return {
      ...e,
      sampledRollout: {
        reliability: sampled.reliability,
        method: sampled.method,
        totalSamples: sampled.totalSamples,
        treatments: sampled.treatments,
      },
      // If definitions had no treatments, use sampled list
      treatments:
        e.treatments?.length > 0
          ? e.treatments.map((t) => {
              const match = (sampled.treatments || []).find(
                (s) => String(s.id) === String(t.id),
              );
              return match
                ? { ...t, percent: match.percent, ranges: match.ranges }
                : t;
            })
          : sampled.treatments || e.treatments || [],
    };
  });

  // Also add pure sampled experiments not seen in client scan
  const seen = new Set(clientEnriched.map((e) => String(e.id).toLowerCase()));
  for (const u of userRollouts.experiments || []) {
    if (!u.id || seen.has(String(u.id).toLowerCase())) continue;
    clientEnriched.push({
      id: u.id,
      kind: u.kind || 'user',
      label: u.label,
      type: 'user',
      isApex: false,
      treatments: u.treatments || [],
      sampledRollout: {
        reliability: u.reliability,
        method: u.method,
        totalSamples: u.totalSamples,
        treatments: u.treatments,
      },
    });
  }

  const catalog = buildExperimentsCatalog({
    clientEnriched,
    guildEnriched,
    previousCatalog,
    buildNumber: build.buildNumber || null,
    scrapedAt: build.scrapedAt || new Date().toISOString(),
  });

  // Enrich catalog entries with percent fields from sampled / guild data
  catalog.experiments = catalog.experiments.map((e) => {
    if (e.kind === 'guild' && e.treatments?.length) {
      return {
        ...e,
        percentSource: 'api_guild_populations',
        percentReliable: true,
      };
    }
    const sampled =
      userById.get(String(e.id).toLowerCase()) ||
      (e.hash != null ? userByHash.get(Number(e.hash)) : null);
    if (sampled) {
      return {
        ...e,
        percentSource: 'sampled_user_assignments',
        percentReliable: false,
        reliability: sampled.reliability,
        sampleNote: sampled.note,
        treatments: (e.treatments || []).map((t) => {
          const match = (sampled.treatments || []).find(
            (s) => String(s.id) === String(t.id),
          );
          return match
            ? {
                ...t,
                percent: match.percent,
                ranges: match.ranges,
                samples: match.samples,
              }
            : t;
        }),
      };
    }
    return {
      ...e,
      percentSource: 'none',
      percentReliable: false,
      sampleNote:
        'No global user % published by Discord. Run sample_user_rollouts (optional DISCORD_TOKEN) or use guild API %.',
    };
  });

  await fs.writeJson(EXPERIMENTS_FILE, catalog, { spaces: 2 });

  console.log(
    `🧪 experiments.json: ${catalog.totals.all} total | +${catalog.totals.added} added | ~${catalog.totals.treatments_changed} treatments_changed`,
  );
  console.log(
    `   user sampled rollouts merged: ${(userRollouts.experiments || []).length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
