/**
 * Robust asset downloads for Canary scraper.
 * - atomic .part → final
 * - retries + Retry-After on 429
 * - timeouts, integrity summary
 * - hard max body size (memory safety)
 */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 24);
const DOWNLOAD_RETRIES = Number(process.env.DOWNLOAD_RETRIES || 4);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 90000);
const MIN_WEB_BYTES = Number(process.env.MIN_WEB_BYTES || 500_000);
const MIN_DOWNLOAD_SUCCESS_RATIO = Number(
  process.env.MIN_DOWNLOAD_SUCCESS_RATIO || 0.85,
);

let stats = emptyStats();

function emptyStats() {
  return {
    jobs: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    http429: 0,
    http5xx: 0,
  };
}

function getDownloadStats() {
  return { ...stats };
}

function resetDownloadStats() {
  stats = emptyStats();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBodyWithLimit(res, maxBytes) {
  const cl = Number(res.headers.get('content-length') || 0);
  if (cl > 0 && cl > maxBytes) {
    throw new Error('content-length too large: ' + cl);
  }
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new Error('response too large: ' + total + ' > ' + maxBytes);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
  const buf = await res.buffer();
  if (buf && buf.length > maxBytes) {
    throw new Error('response too large: ' + buf.length + ' > ' + maxBytes);
  }
  return buf;
}

async function clearAssetsDir(assetsDir) {
  await fs.ensureDir(assetsDir);
  await fs.emptyDir(assetsDir);
  console.log('assetsDir cleared');
}

async function assertWebBundle(assetsDir) {
  const files = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  if (!files.length) {
    throw new Error('INVALID_ASSET: No web.*.js after download — abort scrape');
  }
  let best = 0;
  for (const f of files) {
    const st = await fs.stat(path.join(assetsDir, f));
    best = Math.max(best, st.size);
    console.log(
      'web bundle:',
      f,
      Math.round(st.size / 1024) + 'KB',
      st.size < MIN_WEB_BYTES ? 'TOO_SMALL' : 'OK',
    );
  }
  if (best < MIN_WEB_BYTES) {
    throw new Error(
      'INVALID_ASSET: web.*.js too small (' +
        best +
        ' < ' +
        MIN_WEB_BYTES +
        ') — abort scrape',
    );
  }
}

async function downloadList(urls, assetsDir, force) {
  const jobs = [];
  for (const url of urls) {
    if (!url || !String(url).includes('/assets/')) continue;
    const name = path.basename(String(url).split('?')[0]);
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    jobs.push({ url: String(url), name });
  }

  let n = 0;
  let skip = 0;
  let fail = 0;
  let retried = 0;
  let http429 = 0;
  let http5xx = 0;
  let i = 0;

  async function downloadOne(job) {
    const fp = path.join(assetsDir, job.name);
    const part = fp + '.part';

    if (!force && (await fs.pathExists(fp))) {
      const st = await fs.stat(fp);
      if (st.size > 64) {
        if (job.name.endsWith('.js')) {
          try {
            const fd = await fs.open(fp, 'r');
            const headBuf = Buffer.alloc(80);
            await fd.read(headBuf, 0, 80, 0);
            await fd.close();
            if (/^\s*<(!DOCTYPE|html|HTML)/.test(headBuf.toString('utf8'))) {
              // corrupt HTML cache — re-download
            } else {
              skip++;
              return true;
            }
          } catch {
            skip++;
            return true;
          }
        } else {
          skip++;
          return true;
        }
      }
    }

    let lastErr = null;
    for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt++) {
      try {
        if (attempt > 0) retried++;
        const res = await fetch(job.url, {
          headers: { 'User-Agent': UA, Accept: '*/*' },
          timeout: DOWNLOAD_TIMEOUT_MS,
        });
        if (res.status === 429) {
          http429++;
          const ra = Number(res.headers.get('retry-after') || 0);
          const wait = ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt);
          console.warn('DL 429', job.name, 'wait', wait + 'ms');
          await sleep(wait);
          lastErr = 'HTTP 429';
          continue;
        }
        if (res.status >= 500) {
          http5xx++;
          const wait = Math.min(20_000, 400 * 2 ** attempt);
          console.warn('DL 5xx', job.name, res.status, 'wait', wait + 'ms');
          await sleep(wait);
          lastErr = 'HTTP ' + res.status;
          continue;
        }
        if (!res.ok) {
          lastErr = 'HTTP ' + res.status;
          if (res.status === 404 || res.status === 403) break;
          await sleep(300 * 2 ** attempt);
          continue;
        }
        const maxBytes = /\bweb\./i.test(job.name)
          ? Number(process.env.MAX_WEB_BYTES || 30 * 1024 * 1024)
          : Number(process.env.MAX_ASSET_BYTES || 12 * 1024 * 1024);
        const buf = await readBodyWithLimit(res, maxBytes);
        if (!buf || buf.length < 16) {
          lastErr = 'empty body';
          await sleep(200 * 2 ** attempt);
          continue;
        }
        if (job.name.endsWith('.js')) {
          if (buf.length < 64) {
            lastErr = 'js too small (' + buf.length + 'B)';
            await sleep(200 * 2 ** attempt);
            continue;
          }
          const head = buf.slice(0, 80).toString('utf8');
          if (/^\s*<(!DOCTYPE|html|HTML)/.test(head)) {
            lastErr = 'HTML instead of JS';
            break;
          }
        }
        await fs.writeFile(part, buf);
        await fs.move(part, fp, { overwrite: true });
        n++;
        if (n <= 8 || n % 500 === 0) {
          console.log(
            'DL',
            n + '/' + jobs.length,
            job.name,
            Math.round(buf.length / 1024) + 'KB',
          );
        }
        return true;
      } catch (e) {
        lastErr = e.message;
        await sleep(Math.min(15_000, 400 * 2 ** attempt));
      }
    }
    fail++;
    try {
      if (await fs.pathExists(part)) await fs.remove(part);
    } catch {}
    if (fail <= 12) console.warn('DL fail', job.name, lastErr);
    return false;
  }

  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      await downloadOne(job);
    }
  }

  const workers = [];
  const conc = Math.max(1, Math.min(DOWNLOAD_CONCURRENCY, jobs.length || 1));
  for (let w = 0; w < conc; w++) workers.push(worker());
  await Promise.all(workers);

  stats.jobs += jobs.length;
  stats.downloaded += n;
  stats.skipped += skip;
  stats.failed += fail;
  stats.retried += retried;
  stats.http429 += http429;
  stats.http5xx += http5xx;

  console.log(
    'Downloaded',
    n,
    'skipped',
    skip,
    'failed',
    fail,
    'retried',
    retried,
    '429',
    http429,
    '5xx',
    http5xx,
    'jobs',
    jobs.length,
  );

  if (jobs.length >= 5) {
    const okRatio = (n + skip) / jobs.length;
    if (okRatio < MIN_DOWNLOAD_SUCCESS_RATIO) {
      throw new Error(
        'EXTRACTION_ERROR: download success ratio ' +
          okRatio.toFixed(2) +
          ' < ' +
          MIN_DOWNLOAD_SUCCESS_RATIO +
          ' (failed ' +
          fail +
          '/' +
          jobs.length +
          ')',
      );
    }
  }
}

module.exports = {
  downloadList,
  assertWebBundle,
  clearAssetsDir,
  getDownloadStats,
  resetDownloadStats,
  DOWNLOAD_CONCURRENCY,
};
