/**
 * Builds data/experiments.json after a scrape.
 * One file with every experiment, its variations/treatments,
 * and status: added | treatments_changed | unchanged.
 */
const fs = require('fs-extra');
const path = require('path');
const { buildExperimentsCatalog } = require('./experiments_catalog');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const GUILD_EXP_FILE = path.join(DATA_DIR, 'guild_experiments.json');
const BUILD_FILE = path.join(DATA_DIR, 'build.json');
const EXPERIMENTS_FILE = path.join(DATA_DIR, 'experiments.json');

async function main() {
  await fs.ensureDir(DATA_DIR);

  let findings = { experiments: [] };
  let guild = [];
  let build = {};

  try {
    if (await fs.pathExists(FINDINGS_FILE)) findings = await fs.readJson(FINDINGS_FILE);
  } catch {}
  try {
    if (await fs.pathExists(GUILD_EXP_FILE)) guild = await fs.readJson(GUILD_EXP_FILE);
  } catch {}
  try {
    if (await fs.pathExists(BUILD_FILE)) build = await fs.readJson(BUILD_FILE);
  } catch {}

  let previousCatalog = null;
  try {
    if (await fs.pathExists(EXPERIMENTS_FILE)) {
      previousCatalog = await fs.readJson(EXPERIMENTS_FILE);
    }
  } catch {}

  // guild file stores rolloutSummary already from scrape
  const guildEnriched = (Array.isArray(guild) ? guild : []).map((g) => ({
    ...g,
    id: g.id || g.definitionId || (g.hash != null ? `hash:${g.hash}` : null),
    aaMode: g.aaMode,
    rolloutSummary: g.rolloutSummary || [],
  }));

  const catalog = buildExperimentsCatalog({
    clientEnriched: findings.experiments || [],
    guildEnriched,
    previousCatalog,
    buildNumber: build.buildNumber || null,
    scrapedAt: build.scrapedAt || new Date().toISOString(),
  });

  await fs.writeJson(EXPERIMENTS_FILE, catalog, { spaces: 2 });

  console.log(
    `🧪 experiments.json written: ${catalog.totals.all} total | +${catalog.totals.added} added | ~${catalog.totals.treatments_changed} treatments_changed`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
