#!/usr/bin/env python3
"""Apply chunk coverage metrics to extract.js + index.js guards."""
from pathlib import Path

def patch_extract():
    p = Path('src/lib/extract.js')
    src = p.read_text()
    old_fb = """  let webAssets = htmlAssets.filter((u) => /\\/web\\./i.test(u));
  if (!webAssets.length) {
    console.warn('No web.* in HTML — using prioritized HTML assets');
    webAssets = htmlAssets.slice(0, 5);
  }"""
    new_fb = """  let webAssets = htmlAssets.filter((u) => /\\/web\\./i.test(u));
  if (!webAssets.length) {
    // Guessing random HTML assets produces partial extracts and false \"removed\".
    throw new Error(
      'WEB_BUNDLE_NOT_FOUND: no web.* in HTML assets — refuse extract (was: silent first-5 fallback)',
    );
  }"""
    if old_fb not in src:
        if 'WEB_BUNDLE_NOT_FOUND' in src:
            print('extract: fallback already patched')
        else:
            raise SystemExit('extract: fallback block not found')
    else:
        src = src.replace(old_fb, new_fb)
        print('extract: WEB_BUNDLE_NOT_FOUND ok')

    old_scan = """  const jsFiles = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', jsFiles.length, 'JS files for routes/experiments');
  let scanned = 0;
  for (const f of jsFiles) {
    if (/^web\\./i.test(f)) continue;
    const fp = path.join(assetsDir, f);
    try {
      const st = await fs.stat(fp);
      if (st.size === 0 || st.size > MAX_CHUNK_SCAN_BYTES) continue;
      const content = await fs.readFile(fp, 'utf8');
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
      if (st.size < 500_000) extractStrings(content, strings);
      scanned++;
    } catch {}
  }
  console.log('Scanned extra chunks:', scanned);

  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
  });

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS:', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  console.log('Download integrity summary', getDownloadStats());
  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
    downloadStats: getDownloadStats(),
  };
}"""
    new_scan = r"""  const jsFiles = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', jsFiles.length, 'JS files for routes/experiments');

  // Coverage: distinguish downloaded vs actually parsed (false "removed" risk).
  const coverage = {
    jsOnDisk: jsFiles.length,
    webFiles: 0,
    scanned: 0,
    skippedEmpty: 0,
    skippedOversize: 0,
    skippedWeb: 0,
    readErrors: 0,
    bytesScanned: 0,
    bytesSkippedOversize: 0,
    maxScanBytes: MAX_CHUNK_SCAN_BYTES,
    chunkUrlsMapped: chunkUrls.length,
    localeUrlsMapped: localeUrls.length,
    fullChunks: !!FULL_CHUNKS,
  };

  for (const f of jsFiles) {
    if (/^web\./i.test(f)) {
      coverage.webFiles++;
      coverage.skippedWeb++;
      continue; // already extracted in core path
    }
    const fp = path.join(assetsDir, f);
    try {
      const st = await fs.stat(fp);
      if (st.size === 0) {
        coverage.skippedEmpty++;
        continue;
      }
      if (st.size > MAX_CHUNK_SCAN_BYTES) {
        coverage.skippedOversize++;
        coverage.bytesSkippedOversize += st.size;
        continue;
      }
      const content = await fs.readFile(fp, 'utf8');
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
      if (st.size < 500_000) extractStrings(content, strings);
      coverage.scanned++;
      coverage.bytesScanned += st.size;
    } catch (e) {
      coverage.readErrors++;
      if (coverage.readErrors <= 8) {
        console.warn('chunk read error', f, e && e.message ? e.message : e);
      }
    }
  }

  const secondaryCandidates =
    coverage.jsOnDisk - coverage.webFiles - coverage.skippedEmpty;
  const scannedDenom = Math.max(secondaryCandidates, 1);
  coverage.scanRatio =
    Math.round((coverage.scanned / scannedDenom) * 1000) / 1000;
  coverage.oversizeRatio =
    Math.round(
      (coverage.skippedOversize / Math.max(coverage.jsOnDisk - coverage.webFiles, 1)) *
        1000,
    ) / 1000;

  coverage.degraded = false;
  coverage.degradedReasons = [];
  if (FULL_CHUNKS && coverage.chunkUrlsMapped >= 40) {
    if (coverage.jsOnDisk < coverage.chunkUrlsMapped * 0.5) {
      coverage.degraded = true;
      coverage.degradedReasons.push('JS_ON_DISK_LT_HALF_MAPPED_CHUNKS');
    }
  }
  if (coverage.oversizeRatio > 0.15 && coverage.skippedOversize >= 3) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_OVERSIZE_SKIPPED');
  }
  if (coverage.readErrors >= 10) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_READ_ERRORS');
  }
  if (
    secondaryCandidates >= 20 &&
    coverage.scanRatio < 0.7 &&
    coverage.skippedOversize + coverage.readErrors > 0
  ) {
    coverage.degraded = true;
    coverage.degradedReasons.push('LOW_SCAN_RATIO');
  }

  console.log('Scanned extra chunks:', coverage.scanned, '| coverage', coverage);

  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
    coverage,
  });

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS:', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  console.log('Download integrity summary', getDownloadStats());
  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
    downloadStats: getDownloadStats(),
    coverage,
  };
}"""
    if old_scan not in src:
        if 'coverage.degraded' in src and 'skippedOversize' in src:
            print('extract: scan already patched')
        else:
            raise SystemExit('extract: scan block not found')
    else:
        src = src.replace(old_scan, new_scan)
        print('extract: coverage metrics ok')
    p.write_text(src)

def patch_index():
    p = Path('src/index.js')
    src = p.read_text()
    if 'EXTRACTION_COVERAGE_DEGRADED' in src:
        print('index: coverage guard already present')
        return
    needle = """        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',
          { ratioExp, ratioStr, ratioRt, expN, strN, baseExp, baseStr },
        );
        process.exit(1);
      }
    }
  }
"""
    insert = """        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',
          { ratioExp, ratioStr, ratioRt, expN, strN, baseExp, baseStr },
        );
        process.exit(1);
      }
    }

    // Chunk coverage from extract.js — incomplete scan must not look like a valid diff.
    const cov = findings.coverage || null;
    if (cov && cov.degraded) {
      try {
        await fs.writeJson(LAST_RUN_META, {
          schemaVersion: 1,
          buildNumber: String(build.buildNumber),
          ts: Date.now(),
          status: 'failed',
          ok: false,
          reason: 'EXTRACTION_COVERAGE_DEGRADED',
          coverage: cov,
          downloadStats: ds,
          counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
        });
      } catch {}
      console.error(
        'EXTRACTION_ERROR: chunk coverage degraded — refuse state update',
        cov.degradedReasons || [],
        {
          scanRatio: cov.scanRatio,
          oversize: cov.skippedOversize,
          readErrors: cov.readErrors,
          jsOnDisk: cov.jsOnDisk,
          mapped: cov.chunkUrlsMapped,
        },
      );
      process.exit(1);
    }
  }
"""
    if needle not in src:
        raise SystemExit('index: degraded exit block not found')
    src = src.replace(
        """            counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
            downloadStats: ds,
          });
        } catch {}
        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',""",
        """            counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
            downloadStats: ds,
            coverage: findings.coverage || null,
          });
        } catch {}
        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',""",
        1,
    )
    src = src.replace(needle, insert, 1)
    p.write_text(src)
    print('index: EXTRACTION_COVERAGE_DEGRADED ok')

if __name__ == '__main__':
    patch_extract()
    patch_index()
    print('DONE')
