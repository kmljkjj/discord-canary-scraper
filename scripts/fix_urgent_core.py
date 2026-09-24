#!/usr/bin/env python3
"""Patch index.js: safe CORE urgent + residual full diff + full experiments.json."""
from pathlib import Path

src = Path('src/index.js').read_text()
if 'coreOnly: true' in src and 'URGENT residual after CORE' in src and 'legacyExperiments' in src:
    print('already patched')
    raise SystemExit(0)

old_oncore = '''      onCore: async ({ experiments }) => {
        if (needsExtractSeed && !isNewBuild) return;
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        const { expDiff } = computeExpDiff(experiments, lastExp, knownExp, {
          skipKnownFilter: isCatchUp,
        });
        const n =
          expDiff.added.length +
          expDiff.modified.length +
          expDiff.removed.length;
        if (!n) {
          console.log('URGENT: no exp delta', Date.now() - t0 + 'ms');
          return;
        }
        console.log('URGENT experiments', {
          added: expDiff.added.length,
          modified: expDiff.modified.length,
          removed: expDiff.removed.length,
          t: Date.now() - t0 + 'ms',
        });
        const ok = await notifyUrgent({
          build,
          expDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (ok) {
          urgentSent = true;
          for (const e of expDiff.added) knownExp.add(String(e.id || e));
          try {
            await saveKnownIds(KNOWN_EXP, knownExp, 8000);
          } catch (e) {
            console.warn('early knownExp save', e.message);
          }
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }
      },'''

new_oncore = '''      onCore: async ({ experiments }) => {
        if (needsExtractSeed && !isNewBuild) return;
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        const coreCount = (experiments || []).length;
        const lastCount = Object.keys(lastExp || {}).length;
        // CORE is web.* only — never treat incomplete CORE as a full diff.
        // Only pure ADDS (id absent from lastExp) are safe here.
        // Modified/removed wait for the full chunk extract.
        const { expDiff } = computeExpDiff(experiments, lastExp, knownExp, {
          skipKnownFilter: isCatchUp,
        });
        const pureAdded = (expDiff.added || []).filter((e) => {
          const id = String(e && e.id != null ? e.id : e);
          return id && !(id in (lastExp || {}));
        });
        if (lastCount >= 40 && coreCount < lastCount * 0.85) {
          console.log('URGENT: CORE incomplete vs lastExp — adds only', {
            coreCount,
            lastCount,
            ratio: Math.round((coreCount / Math.max(lastCount, 1)) * 1000) / 1000,
            pureAdded: pureAdded.length,
            strippedModified: (expDiff.modified || []).length,
            strippedRemoved: (expDiff.removed || []).length,
          });
        }
        const urgentDiff = {
          added: pureAdded,
          modified: [],
          removed: [],
          categoryChanged: [],
        };
        if (!urgentDiff.added.length) {
          console.log('URGENT: no safe pure-add delta', Date.now() - t0 + 'ms');
          return;
        }
        console.log('URGENT experiments', {
          added: urgentDiff.added.length,
          modified: 0,
          removed: 0,
          coreOnly: true,
          t: Date.now() - t0 + 'ms',
        });
        const ok = await notifyUrgent({
          build,
          expDiff: urgentDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (ok) {
          urgentSent = true;
          for (const e of urgentDiff.added) knownExp.add(String(e.id || e));
          try {
            await saveKnownIds(KNOWN_EXP, knownExp, 8000);
          } catch (e) {
            console.warn('early knownExp save', e.message);
          }
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }
      },'''

if old_oncore not in src:
    raise SystemExit('onCore block not found')
src = src.replace(old_oncore, new_oncore)

old_urgent = '''      if (!urgentSent) {
        const okU = await notifyUrgent({
          build,
          expDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (okU) {
          for (const e of expDiff.added) knownExp.add(String(e.id || e));
        } else {
          console.warn('URGENT retry path failed — NOT marking known exp');
        }
      } else {
        console.log('URGENT already sent');
      }'''

new_urgent = '''      if (!urgentSent) {
        const okU = await notifyUrgent({
          build,
          expDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (okU) {
          for (const e of expDiff.added) knownExp.add(String(e.id || e));
        } else {
          console.warn('URGENT retry path failed — NOT marking known exp');
        }
      } else {
        // CORE already announced pure adds — still send full-extract residual
        // (modified / removed / category) without re-sending added.
        const residual = {
          added: [],
          modified: expDiff.modified || [],
          removed: expDiff.removed || [],
          categoryChanged: expDiff.categoryChanged || [],
        };
        const nRes =
          residual.modified.length +
          residual.removed.length +
          residual.categoryChanged.length;
        if (nRes) {
          console.log('URGENT residual after CORE', {
            modified: residual.modified.length,
            removed: residual.removed.length,
            categoryChanged: residual.categoryChanged.length,
          });
          const okR = await notifyUrgent({
            build,
            expDiff: residual,
            webhookUrl: process.env.DISCORD_WEBHOOK_URL,
            isNewBuild,
            catchUp: isCatchUp,
            prevBuild: prevBuildNum,
          });
          if (!okR) {
            console.warn('URGENT residual webhook failed');
          }
        } else {
          console.log('URGENT already sent — no residual mod/removed');
        }
      }'''

if old_urgent not in src:
    raise SystemExit('urgent residual block not found')
src = src.replace(old_urgent, new_urgent)

old_exp = """    'experiments.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: { all: mergedExps.length },
      experiments: legacyList.length ? legacyList : mergedExps,
    },"""

new_exp = """    'experiments.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: {
        all: mergedExps.length,
        legacy: legacyList.length,
        apex: apexList.length,
      },
      // Always full merge — legacy-only broke baseline load (6 vs 360)
      experiments: mergedExps,
      legacyExperiments: legacyList,
    },"""

if old_exp not in src:
    raise SystemExit('experiments.json block not found')
src = src.replace(old_exp, new_exp)

Path('src/index.js').write_text(src)
print('patched', len(src))
