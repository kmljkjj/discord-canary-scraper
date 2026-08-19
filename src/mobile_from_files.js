/**
 * Mobile experiments / strings from REAL client files
 *
 * Source of files (not version APIs):
 *   https://github.com/Wumpus-Central/discord-mobile-datamining
 *   → sparse clone of discord_app + discord_common/js
 *
 * Then scan for experiment IDs (same style as web Canary scraper)
 * and notify webhook on new mobile experiments.
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORK_DIR = path.join(__dirname, '..', '.mobile_datamine');
const STATE_FILE = path.join(DATA_DIR, 'mobile_experiments.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const SOURCE_REPO =
  process.env.MOBILE_DATAMINE_REPO ||
  'https://github.com/Wumpus-Central/discord-mobile-datamining.git';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isExpId(id) {
  if (!/^20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80}$/i.test(id)) return false;
  if (/^20\d{2}-\d{2}$/.test(id)) return false;
  return true;
}

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function syncSourceRepo() {
  await fs.ensureDir(path.dirname(WORK_DIR));
  if (!(await fs.pathExists(path.join(WORK_DIR, '.git')))) {
    await fs.remove(WORK_DIR);
    await fs.ensureDir(WORK_DIR);
    // Partial clone + sparse checkout of JS client paths only
    run(
      `git clone --depth 1 --filter=blob:none --sparse "${SOURCE_REPO}" "${WORK_DIR}"`,
      path.dirname(WORK_DIR),
    );
    run('git sparse-checkout set discord_app discord_common/js _runtime', WORK_DIR);
  } else {
    try {
      run('git fetch --depth 1 origin', WORK_DIR);
      run('git reset --hard origin/HEAD', WORK_DIR);
      run('git sparse-checkout set discord_app discord_common/js _runtime', WORK_DIR);
    } catch (e) {
      console.warn('git update failed, reclone…', e.message);
      await fs.remove(WORK_DIR);
      return syncSourceRepo();
    }
  }

  let head = 'unknown';
  try {
    head = run('git rev-parse --short HEAD', WORK_DIR).trim();
  } catch {}
  return { dir: WORK_DIR, commit: head };
}

async function collectJsFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        await walk(full);
      } else if (/\.(js|ts|tsx|jsx|json)$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function extractExperimentsFromText(content, fileLabel, expMap) {
  const idRe = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9_\-]{3,80})["']/gi;
  let m;
  while ((m = idRe.exec(content)) !== null) {
    const id = m[1].toLowerCase();
    if (!isExpId(id)) continue;
    if (!expMap.has(id)) {
      expMap.set(id, {
        id,
        type: /guild/i.test(id) ? 'guild' : 'user',
        isApex: /apex|_aa_|-aa-/i.test(id),
        sources: [fileLabel],
      });
    } else {
      const e = expMap.get(id);
      if (!e.sources.includes(fileLabel) && e.sources.length < 5) {
        e.sources.push(fileLabel);
      }
    }
  }
}

/** Optional light string extraction (hashed keys only) */
function extractStringsFromText(content, stringMap) {
  const re =
    /["']([A-Za-z0-9]{5,8})["']\s*:\s*["']((?:[^"'\\]|\\.){2,200})["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    const val = m[2];
    if (!/[A-Za-z]/.test(key)) continue;
    if (!/[A-Za-zÀ-ÿ]{2,}/.test(val)) continue;
    if (/discord_web|webpack|function\s*\(/i.test(val)) continue;
    if (/^[a-f0-9]{16,}$/i.test(val)) continue;
    stringMap.set(key, val);
  }
}

async function scanMobileFiles(root) {
  const files = await collectJsFiles(root);
  console.log(`Scanning ${files.length} mobile source files…`);
  const expMap = new Map();
  const stringMap = new Map();
  let scanned = 0;
  for (const file of files) {
    try {
      const st = await fs.stat(file);
      if (st.size > 20_000_000) continue;
      let content = await fs.readFile(file, 'utf8');
      if (st.size > 5_000_000) content = content.slice(0, 5_000_000);
      const label = path.relative(root, file).replace(/\\/g, '/');
      extractExperimentsFromText(content, label, expMap);
      extractStringsFromText(content, stringMap);
      scanned++;
    } catch (e) {
      // skip binary / encoding issues
    }
  }
  console.log(`Scanned ${scanned} files`);
  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings: Object.fromEntries(
      [...stringMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
  };
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.warn('Webhook failed', res.status, await res.text());
  else console.log('Webhook sent');
  await new Promise((r) => setTimeout(r, 550));
}

function experimentEmbed(exp, sourceCommit) {
  const isApex = exp.isApex;
  const type = exp.type || 'user';
  const desc = [
    `+ \`${exp.id}\` (**${type}**)`,
    `* Variant 0`,
    `* Variant 1`,
    `Type: **${type}**`,
    `Source: **mobile files** (\`${sourceCommit}\`)`,
  ].join('\n');
  return {
    title: isApex ? 'New Apex Experiment (Mobile)' : 'New Experiment (Mobile)',
    description: desc,
    color: isApex ? 0xfee75c : 0xeb459e,
    timestamp: new Date().toISOString(),
  };
}

async function notify(newExps, stringDiff, meta) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }
  if (!newExps.length && !Object.keys(stringDiff.added || {}).length) return;

  await postWebhook({
    username: 'Mobile Files',
    embeds: [
      {
        title: 'New Discord Mobile Build',
        description:
          'From **real client files** ([discord-mobile-datamining](https://github.com/Wumpus-Central/discord-mobile-datamining))',
        color: 0xed4245,
        fields: [
          { name: 'Commit', value: meta.commit || '—', inline: true },
          { name: 'New experiments', value: String(newExps.length), inline: true },
          {
            name: 'New strings',
            value: String(Object.keys(stringDiff.added || {}).length),
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });

  const sorted = [...newExps].sort((a, b) => {
    const aa = a.isApex ? 0 : 1;
    const bb = b.isApex ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return b.id.localeCompare(a.id);
  });
  for (const exp of sorted.slice(0, 12)) {
    await postWebhook({
      username: 'Mobile Files',
      embeds: [experimentEmbed(exp, meta.commit)],
    });
  }

  const lines = [];
  for (const [k, v] of Object.entries(stringDiff.added || {}).slice
    ? Object.entries(stringDiff.added || {})
    : []) {
    lines.push(`+ ${k}: ${v}`);
  }
  // Object.entries doesn't have slice — fix
  const strLines = Object.entries(stringDiff.added || {})
    .slice(0, 40)
    .map(([k, v]) => `+ ${k}: ${v}`);
  if (strLines.length) {
    await postWebhook({
      username: 'Mobile Files',
      embeds: [
        {
          title: 'Strings (Mobile)',
          description:
            '_Added_\n```\n' + strLines.join('\n').slice(0, 3500) + '\n```',
          color: 0x57f287,
          footer: { text: `Mobile files · ${meta.commit}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📱 Sync mobile datamining files…');
  const meta = await syncSourceRepo();
  console.log(`Source commit: ${meta.commit}`);

  const findings = await scanMobileFiles(meta.dir);
  console.log(`Experiments found: ${findings.experiments.length}`);
  console.log(`Strings found: ${Object.keys(findings.strings).length}`);

  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }

  const prevIds = new Set((previous?.experiments || []).map((e) => e.id));
  const newExps = findings.experiments.filter((e) => !prevIds.has(e.id));

  const prevStrings = previous?.strings || {};
  const stringDiff = { added: {} };
  for (const [k, v] of Object.entries(findings.strings)) {
    if (!(k in prevStrings)) stringDiff.added[k] = v;
  }

  const state = {
    scrapedAt: new Date().toISOString(),
    sourceRepo: SOURCE_REPO,
    sourceCommit: meta.commit,
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    newExperimentCount: newExps.length,
    experiments: findings.experiments,
    strings: findings.strings,
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });

  console.log(`New mobile experiments: ${newExps.length}`);
  console.log(`New mobile strings: ${Object.keys(stringDiff.added).length}`);

  await notify(newExps, stringDiff, meta);
  console.log('✅ Mobile files scan done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
