const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {
  publishDataGeneration,
  readCurrentGeneration,
  POINTER_FILE,
} = require('../src/lib/publish_data');

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pubdata-'));
}

test('successful publish writes all files + pointer', async () => {
  const dir = await tmpDir();
  const res = await publishDataGeneration(dir, {
    runId: 'run-1',
    buildNumber: '12345',
    files: {
      'build.json': { runId: 'run-1', buildNumber: '12345' },
      'meta.json': { runId: 'run-1', buildNumber: '12345', ok: true },
      'experiments.json': { runId: 'run-1', buildNumber: '12345', experiments: [] },
    },
  });
  assert.equal(res.runId, 'run-1');
  assert.ok(await fs.pathExists(path.join(dir, 'build.json')));
  assert.ok(await fs.pathExists(path.join(dir, POINTER_FILE)));
  const ptr = await readCurrentGeneration(dir);
  assert.equal(ptr.buildNumber, '12345');
  assert.equal(ptr.files.length, 3);
  await fs.remove(dir);
});

test('validation failure leaves published files untouched', async () => {
  const dir = await tmpDir();
  await fs.writeJson(path.join(dir, 'build.json'), { buildNumber: 'old' });
  await fs.writeJson(path.join(dir, POINTER_FILE), {
    runId: 'old-run',
    buildNumber: 'old',
  });
  let failed = false;
  try {
    await publishDataGeneration(dir, {
      runId: 'run-2',
      buildNumber: '999',
      files: {
        'build.json': { runId: 'WRONG', buildNumber: '999' },
      },
    });
  } catch (e) {
    failed = true;
    assert.match(e.message, /runId mismatch/);
  }
  assert.equal(failed, true);
  const build = await fs.readJson(path.join(dir, 'build.json'));
  assert.equal(build.buildNumber, 'old');
  const ptr = await readCurrentGeneration(dir);
  assert.equal(ptr.runId, 'old-run');
  await fs.remove(dir);
});

test('refuses unknown buildNumber', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () =>
      publishDataGeneration(dir, {
        runId: 'r',
        buildNumber: 'unknown',
        files: { 'a.json': {} },
      }),
    /unknown buildNumber/,
  );
  await fs.remove(dir);
});

test('refuses empty file set', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () =>
      publishDataGeneration(dir, {
        runId: 'r',
        buildNumber: '1',
        files: {},
      }),
    /no files/,
  );
  await fs.remove(dir);
});
