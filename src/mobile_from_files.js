/**
 * Mobile experiments / strings from REAL client files
 * Source: Wumpus-Central/discord-mobile-datamining (sparse clone)
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORK_DIR = path.join(__dirname, '..', '.mobile_datamine');
const STATE_FILE = path.join(DATA_DIR, 'mobile_experiments.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known_mobile_experiment_ids.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

const SOURCE_REPO =
  process.env.MOBILE_DATAMINE_REPO ||
  'https://github.com/Wumpus-Central/discord-mobile-datamining.git';

const BOT_NAME = process.env.ORBIT_BOT_NAME || 'Datamining';
const BOT_AVATAR =
  process.env.ORBIT_BOT_AVATAR ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

const MAX_NOTIFY_EXP = Number(process.env.MAX_WEBHOOKS_PER_RUN || 8);

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
    maxBuffer: 80 * 1024 * 1024,
  });
}

async function syncSourceRepo() {
  await fs.ensureDir(path.dirname(WORK_DIR));
  if (!(await fs.pathExists(path.join(WORK_DIR, '.git')))) {
    await fs.remove(WORK_DIR);
    await fs.ensureDir(WORK_DIR);
    run(
      `git clone --depth 1 --filter=blob:none --sparse "${SOURCE_REPO}" "${WORK_DIR}"`,
      path.dirname(WORK_DIR),
    );
    run(
      'git sparse-checkout set discord_app discord_common/js _runtime discord_assets',
      WORK_DIR,
    );
  } else {
    try {
      run('git fetch --depth 1 origin', WORK_DIR);
      run('git reset --hard origin/HEAD', WORK_DIR);
      run(
        'git sparse-checkout set discord_app discord_common/js _runtime discord_assets',
        WORK_DIR,
      );
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
  let msg = '';
  try {
    msg = run('git log -1 --pretty=%s', WORK_DIR).trim();
  } catch {}
  return { dir: WORK_DIR, commit: head, message: msg };
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
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === '__tests__'
        )
          continue;
        await walk(p);
      } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(ent.name)) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

function inferType(id) {
  const s = String(id).toLowerCase();
  if (/guild|server|role|channel_list|community|moderat|automod|raid/.test(s))
    return 'guild';
  return 'user';
}

function extractFromContent(content, expMap, strings) {
  const reExp = /["'](20[2-3]\d-[0-1]\d[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  let m;
  while ((m = reExp.exec(content)) !== null) {
    const id = m[1];
    if (!isExpId(id) || expMap.has(id)) continue;
    const start = Math.max(0, m.index - 80);
    const ctx = content.slice(start, m.index + id.length + 120);
    let type = inferType(id);
    if (/kind["']?\s*:\s*["']guild["']/i.test(ctx)) type = 'guild';
    else if (/kind["']?\s*:\s*["']user["']/i.test(ctx)) type = 'user';
    expMap.set(id, { id, type, kind: type, source: 'mobile_files' });
  }

  const reStr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  while ((m = reStr.exec(content)) !== null) {
    if (m[1].length !== 6) continue;
    if (/^[0-9a-f]{6}$/i.test(m[1])) continue;
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (typeof val === 'string' && val.length >= 2 && val.length <= 400) {
      strings[m[1]] = val;
    }
  }
}

async function scanMobileFiles(root) {
  const files = await collectJsFiles(root);
  console.log('JS files to scan:', files.length);
  const expMap = new Map();
  const strings = {};
  let n = 0;
  for (const fp of files) {
    try {
      const st = await fs.stat(fp);
      if (st.size > 8_000_000) continue;
      const content = await fs.readFile(fp, 'utf8');
      extractFromContent(content, expMap, strings);
      n++;
    } catch {}
  }
  console.log('Scanned files:', n);
  return {
    experiments: [...expMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
  };
}

async function loadKnown() {
  const set = new Set();
  try {
    if (await fs.pathExists(KNOWN_FILE)) {
      const d = await fs.readJson(KNOWN_FILE);
      for (const id of d.ids || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function saveKnown(set) {
  const ids = [...set].sort();
  await fs.writeJson(
    KNOWN_FILE,
    { updatedAt: new Date().toISOString(), count: ids.length, ids },
    { spaces: 2 },
  );
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  const body = {
    username: BOT_NAME,
    avatar_url: BOT_AVATAR,
    ...payload,
  };
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn('Webhook', res.status, await res.text());
  else console.log('Webhook OK');
  await new Promise((r) => setTimeout(r, 400));
}

function experimentEmbed(exp, meta) {
  const isApex = /apex|20\d{2}-\d{2}-/i.test(exp.id);
  const type = exp.type || 'user';
  const desc = [
    `+ \`${exp.id}\` (**${type}**)`,
    `Type: **${type}**`,
    meta.message ? `Repo: ${meta.message.slice(0, 80)}` : null,
    `Source: **mobile files** (\`${meta.commit}\`)`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    title: isApex ? 'New Apex Experiment (Mobile)' : 'New Experiment (Mobile)',
    description: desc,
    color: isApex ? 0xfee75c : 0xeb459e,
    footer: { text: `Mobile files · ${meta.commit}` },
    timestamp: new Date().toISOString(),
  };
}

async function notify(newExps, stringDiff, meta) {
  if (!WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL — skip notify');
    return;
  }
  if (!newExps.length && !Object.keys(stringDiff.added || {}).length) return;

  if (newExps.length) {
    await postWebhook({
      embeds: [
        {
          title: 'Mobile Experiments',
          description: newExps
            .slice(0, 20)
            .map((e) => `+ \`${e.id}\` (${e.type || 'user'})`)
            .join('\n'),
          color: 0xeb459e,
          footer: { text: `Mobile · ${meta.commit} · +${newExps.length}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  for (const exp of newExps.slice(0, MAX_NOTIFY_EXP)) {
    await postWebhook({ embeds: [experimentEmbed(exp, meta)] });
  }

  const strLines = Object.entries(stringDiff.added || {})
    .slice(0, 35)
    .map(([k, v]) => `+ ${k}: ${String(v).slice(0, 80)}`);
  if (strLines.length) {
    await postWebhook({
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
  console.log('=== Mobile files datamine ===');
  const meta = await syncSourceRepo();
  console.log('Source commit:', meta.commit, meta.message);

  const findings = await scanMobileFiles(meta.dir);
  console.log('Experiments found:', findings.experiments.length);
  console.log('Strings found:', Object.keys(findings.strings).length);

  const known = await loadKnown();
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }
  for (const e of previous?.experiments || []) {
    if (e?.id) known.add(String(e.id));
  }

  const newExps = findings.experiments.filter((e) => !known.has(e.id));
  for (const e of findings.experiments) known.add(e.id);

  const prevStrings = previous?.strings || {};
  const stringDiff = { added: {} };
  // Only report string adds if previous had a meaningful baseline
  const prevCount = Object.keys(prevStrings).length;
  if (prevCount >= 20) {
    for (const [k, v] of Object.entries(findings.strings)) {
      if (!(k in prevStrings)) stringDiff.added[k] = v;
    }
    if (Object.keys(stringDiff.added).length > 80) {
      console.log('String flood — skip notify, reseed');
      stringDiff.added = {};
    }
  }

  const state = {
    scrapedAt: new Date().toISOString(),
    sourceRepo: SOURCE_REPO,
    sourceCommit: meta.commit,
    sourceMessage: meta.message,
    experimentCount: findings.experiments.length,
    stringCount: Object.keys(findings.strings).length,
    newExperimentCount: newExps.length,
    experiments: findings.experiments,
    strings: findings.strings,
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  await saveKnown(known);

  console.log('New mobile experiments:', newExps.length);
  console.log('New mobile strings:', Object.keys(stringDiff.added).length);

  await notify(newExps, stringDiff, meta);
  console.log('=== Mobile files done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
