/**
 * Rollouts user depuis le gist communautaire d'agnonotdev — v1.
 *
 * POURQUOI CE MODULE : la mesure propre par échantillonnage (user_rollouts.js
 * v14) ne voit que quelques expériences via /experiments. Le gist
 * « rollouts-tag.json » (copie réduite de rollouts.json, tag Assyst) publie
 * les bornes de buckets de ~1000 expériences sur l'espace de hash 0-10000.
 *
 * CE QUE C'EST (honnêteté méthodologique, cf. lib/gist_rollouts.js) :
 *   - Pourcentages = COUVERTURE DE L'ESPACE DE BUCKETS selon la source
 *     communautaire, à 0,01 point près, calculée depuis des longueurs
 *     entières. Mêmes plages et même définition que n'importe quel lecteur
 *     de cette source → mêmes chiffres de base ; l'amélioration est
 *     l'interprétation, le détail par variante, la classification
 *     user/guild, la fiabilité des notifications et le suivi historique.
 *   - Cas ambigus (variantes répétées, chevauchements intra/inter-variantes,
 *     multi-populations, plages illisibles) signalés, jamais lissés ; les
 *     totaux globaux deviennent alors INDISPONIBLES.
 *   - Les expériences de type « guild » sont exclues (le décodage wire
 *     apex_rollouts.js les mesure à part) ; les types INCONNUS sont suivis
 *     dans l'état et le rapport mais PAS notifiés (leur type n'est pas établi).
 *
 * NOTIFICATIONS : deltas contre le dernier état NOTIFIÉ (« acknowledged ») ;
 * UN embed PAR envoi (livraison partielle identifiable précisément) ;
 * acknowledged n'avance que pour les changements réellement livrés — un échec
 * de webhook ne perd rien, c'est retenté au run suivant. Premier run =
 * baseline silencieuse (pas de flood de rattrapage).
 *
 * Miroirs : deux copies du gist existent. La PREMIÈRE de la liste est
 * CANONIQUE ; l'autre sert à la comparaison, et de repli EXPLICITE
 * (enregistré dans l'état) si la canonique est injoignable. Jamais de
 * bascule automatique sur divergence.
 *
 * Env :
 *   GIST_ROLLOUT_GIST_IDS   défaut : canonique puis miroir, séparés par ,
 *   GIST_ROLLOUT_MIN_PCT_DELTA  défaut 0.05 (points, delta total OU par variante)
 *   GIST_ROLLOUT_STALE_H    défaut 72 (h ; avertissement si le gist n'a pas
 *                            changé depuis ce délai — un gist inchangé
 *                            n'est PAS forcément périmé, simple signal)
 *   GITHUB_TOKEN            optionnel — ATTENTION : le GITHUB_TOKEN des
 *                           Actions est un jeton d'installation SANS accès
 *                           aux gists (403 « Resource not accessible by
 *                           integration ») ; un gist public se lit
 *                           anonymement, le module retente sans jeton puis
 *                           replie sur le CDN brut si besoin
 *   UR_WEBHOOK | USER_ROLLOUT_WEBHOOK_URL | APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   ORBIT_BOT_NAME / ORBIT_AVATAR_URL (identité du webhook)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./lib/webhook');
const { writeJsonAtomic } = require('./lib/atomic');
const {
  computeExperiment,
  diffExperiments,
  mirrorStatus,
  validateGistData,
  round2,
} = require('./lib/gist_rollouts');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'gist_user_rollouts.json');
const REPORT = path.join(DATA, 'gist_user_rollouts.md');

const DEFAULT_GIST_IDS = [
  'e3e99062983e6bd0feaef833f14fd931', // canonique
  '192b2ce20539ce1021b5c8cb01b17ff0', // miroir (comparaison + repli explicite)
];
// Propriétaires connus des gists par défaut — servent UNIQUEMENT au repli
// CDN brut (dernier recours) : https://gist.githubusercontent.com/<owner>/<id>/raw
const RAW_FALLBACK_OWNERS = {
  e3e99062983e6bd0feaef833f14fd931: 'agnonotdev',
  '192b2ce20539ce1021b5c8cb01b17ff0': 'agnonotdev',
};
const GIST_IDS = String(process.env.GIST_ROLLOUT_GIST_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GISTS = GIST_IDS.length ? GIST_IDS : DEFAULT_GIST_IDS;
const MIN_DELTA_PCT = Math.max(0, Number(process.env.GIST_ROLLOUT_MIN_PCT_DELTA ?? 0.05));
const STALE_H = Math.max(1, Number(process.env.GIST_ROLLOUT_STALE_H ?? 72));

const WEBHOOK_CANDIDATES = [
  ['UR_WEBHOOK', process.env.UR_WEBHOOK],
  ['USER_ROLLOUT_WEBHOOK_URL', process.env.USER_ROLLOUT_WEBHOOK_URL],
  ['APEX_WEBHOOK_URL', process.env.APEX_WEBHOOK_URL],
  ['ROLLOUT_WEBHOOK_URL', process.env.ROLLOUT_WEBHOOK_URL],
  ['DISCORD_WEBHOOK_URL', process.env.DISCORD_WEBHOOK_URL],
];
const firstWebhook = WEBHOOK_CANDIDATES.find(([, v]) => v && String(v).trim());
const WEBHOOK = firstWebhook ? String(firstWebhook[1]).trim() : null;
const WEBHOOK_SOURCE = firstWebhook ? firstWebhook[0] : null;

const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@media/datamining-avatar.png';

// ─── Chargement des métadonnées locales (noms + types) ──────────────────────

/** Map id → { type, title } depuis nos propres scrapes. Aucune source externe. */
async function loadLocalDefs() {
  const defs = new Map();
  const put = (id, type, title) => {
    const clean = String(id || '').trim();
    if (!clean) return;
    const t = String(type || '').toLowerCase();
    if (!defs.has(clean) || (t && !defs.get(clean).type)) {
      const prev = defs.get(clean) || {};
      defs.set(clean, {
        type: t === 'guild' || t === 'server' ? 'guild' : t === 'user' ? 'user' : prev.type || '',
        title: title || prev.title || clean,
      });
    }
  };

  const sources = [
    [path.join(DATA, 'experiments.json'), (j) => j.experiments || []],
    [path.join(DATA, 'mobile_experiments.json'), (j) => j.experiments || []],
    [path.join(DATA, 'apex_experiments.json'), (j) => (Array.isArray(j) ? j : [])],
    [path.join(DATA, 'baseline_experiments.json'), (j) => (Array.isArray(j) ? j : j.experiments || [])],
  ];
  for (const [file, pick] of sources) {
    if (!(await fs.pathExists(file))) continue;
    try {
      const j = await fs.readJson(file);
      for (const e of pick(j) || []) {
        if (!e || typeof e !== 'object') continue;
        put(e.id || e.name, e.type || e.kind, e.label || e.title);
      }
    } catch (_) {}
  }
  const log = process.env.GIST_ROLLOUT_TEST_QUIET === '1' ? () => {} : console.log;
  log('Local experiment defs:', defs.size, 'ids');
  return defs;
}

// ─── Lecture des gists ──────────────────────────────────────────────────────

/**
 * GET https://api.github.com/gists/<id> → meta. Utilise le raw_url renvoyé
 * par l'API (jamais une URL reconstruite).
 */
async function fetchGistMeta(id, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'discord-canary-scraper',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res = await fetch('https://api.github.com/gists/' + encodeURIComponent(id), {
    headers,
    timeout: 20000,
  });
  // Le GITHUB_TOKEN des Actions est un jeton d'INSTALLATION sans accès aux
  // gists (« Resource not accessible by integration », 403) : un gist PUBLIC
  // se lit anonymement — on retente SANS Authorization avant d'abandonner.
  if (res.status === 403 && token) {
    delete headers.Authorization;
    res = await fetch('https://api.github.com/gists/' + encodeURIComponent(id), {
      headers,
      timeout: 20000,
    });
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = String((await res.text()) || '').replace(/\s+/g, ' ').slice(0, 160);
    } catch (_) {}
    throw new Error('gist ' + id + ' HTTP ' + res.status + (detail ? ' — ' + detail : ''));
  }
  const j = await res.json();
  const file = j.files && Object.values(j.files)[0];
  if (!file || !file.raw_url) throw new Error('gist ' + id + ' sans raw_url');
  return {
    gistId: id,
    rawUrl: file.raw_url,
    htmlUrl: j.html_url,
    updatedAt: j.updated_at || null,
    revision: (j.history && j.history[0] && j.history[0].version) || null,
  };
}

async function fetchJsonUrl(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'discord-canary-scraper' },
    timeout: timeoutMs,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 60));
  return res.json();
}

/**
 * Lit le gist CANONIQUE (GISTS[0]) ; le miroir sert à la comparaison et de
 * repli EXPLICITE (fallback enregistré). Échec canonique + miroir OK → on
 * utilise le miroir avec source.fallback = true. Échec total → null
 * (l'appelant garde le dernier état valide).
 * Retourne { source, data, mirror } | null.
 */
/**
 * Lit UN gist : API (meta + raw_url officiel), et si l'API est injoignable,
 * repli CDN brut pour les gists dont le propriétaire est connu — sans
 * métadonnées de révision (updatedAt/revision null), repli ENREGISTRÉ
 * (meta.rawFallback = true), jamais silencieux.
 */
async function fetchGistInto(id, token) {
  try {
    const meta = await fetchGistMeta(id, token);
    const data = await fetchJsonUrl(meta.rawUrl);
    return { meta, data };
  } catch (e) {
    const owner = RAW_FALLBACK_OWNERS[id];
    if (!owner) throw e;
    const rawUrl = 'https://gist.githubusercontent.com/' + owner + '/' + id + '/raw';
    const data = await fetchJsonUrl(rawUrl);
    return {
      meta: {
        gistId: id,
        rawUrl,
        htmlUrl: 'https://gist.github.com/' + owner + '/' + id,
        updatedAt: null,
        revision: null,
        rawFallback: true,
      },
      data,
    };
  }
}

async function fetchGists(token) {
  const canonicalId = GISTS[0];
  let canonical = null;
  let canonicalErr = null;
  try {
    canonical = await fetchGistInto(canonicalId, token);
  } catch (e) {
    canonicalErr = e;
  }

  let mirrorFetched = null;
  if (GISTS[1] && GISTS[1] !== canonicalId) {
    try {
      mirrorFetched = await fetchGistInto(GISTS[1], token);
    } catch (_) {} // le miroir est optionnel
  }

  if (canonical && mirrorFetched) {
    const status = mirrorStatus(canonical.data, mirrorFetched.data);
    return {
      source: { ...canonical.meta, fallback: false },
      data: canonical.data,
      mirror: { gistId: mirrorFetched.meta.gistId, ...status },
    };
  }
  if (canonical) {
    return { source: { ...canonical.meta, fallback: false }, data: canonical.data, mirror: null };
  }
  if (mirrorFetched) {
    // Repli EXPLICITE (canonique injoignable) : enregistré, jamais silencieux.
    return {
      source: { ...mirrorFetched.meta, fallback: true, canonicalId },
      data: mirrorFetched.data,
      mirror: null,
    };
  }
  const err = canonicalErr instanceof Error ? canonicalErr.message : String(canonicalErr);
  return { error: err };
}

// ─── Calcul + classification ───────────────────────────────────────────────

/**
 * Calcule toutes les expériences + classe user / guild / unclassified.
 * Retourne { byId, typeCounts, list }.
 */
function computeAll(gistData, defs) {
  const byId = {};
  const typeCounts = { user: 0, guild: 0, unclassified: 0 };
  const list = [];
  for (const raw of gistData) {
    if (!raw || typeof raw !== 'object') continue;
    const c = computeExperiment(raw);
    if (!c.id) continue;
    const def = defs.get(c.id) || {};
    const type = def.type === 'user' || def.type === 'guild' ? def.type : 'unclassified';
    typeCounts[type] += 1;
    const entry = { ...c, type, title: def.title || c.id };
    byId[c.id] = entry;
    list.push(entry);
  }
  list.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return { byId, typeCounts, list };
}

/**
 * Entrée MINIMALE pour acknowledged (état persistant léger, commité à chaque
 * run) : clé structurelle (hash court), signature de variantes, % par
 * variante — tout ce dont diffExperiments/buildEmbed ont besoin sur l'état
 * précédent. Le détail complet (plages par variante) est recomputé à chaque
 * lecture du gist et archivé dans le rapport Markdown.
 */
function ackEntry(e) {
  if (!e || !e.hasData) {
    return { key: 'no_data', hasData: false, sig: '', treatment: { pct: null } };
  }
  const byVariant = {};
  for (const [k, v] of Object.entries(e.byVariant || {})) {
    byVariant[k] = { pct: v.pct, role: v.role };
  }
  return {
    key: e.key,
    hasData: true,
    sig: e.sig,
    byVariant,
    treatment: { pct: e.treatment.pct },
    control: { pct: e.control.pct },
    notEligible: { pct: e.notEligible.pct },
    variantsCount: (e.variants || []).length,
  };
}

// ─── Embeds de notification ─────────────────────────────────────────────────

function fmtPct(p) {
  return String(round2(p)).replace('.', ',') + ' %';
}

function fmtDelta(d) {
  const v = round2(d);
  return (v > 0 ? '+' : '') + String(v).replace('.', ',') + ' pts';
}

const EMBED_COLORS = {
  new: 0x3498db, // bleu
  changed: 0x2ecc71, // vert (montée) — remplacé ci-dessous si baisse
  down: 0xe67e22, // orange
  structured: 0x9b59b6, // violet
  removed: 0xe74c3c, // rouge
};

function buildEmbed(change, sourceMeta) {
  const { kind, id, before, after, deltaPct } = change;
  const title = (after || before || {}).title || id;
  const typeLabel =
    (after || before || {}).type === 'user'
      ? ''
      : (after || before || {}).type === 'guild'
        ? ' [guild — hors % user]'
        : ' [type inconnu]';
  const headers = {
    new: 'Nouvelle expérience suivie',
    // Titre neutre si le delta treatment n'est pas mesurable (totaux
    // indisponibles) ou nul (redistribution entre variantes à total constant).
    changed:
      deltaPct == null
        ? 'Changement de couverture'
        : deltaPct < 0
          ? 'Baisse de rollout'
          : deltaPct > 0
            ? 'Montée de rollout'
            : 'Répartition des variantes modifiée',
    structured: 'Reconfiguration des buckets',
    removed: 'Expérience retirée du gist',
  };

  const fields = [];
  if (after && after.hasData) {
    for (const v of after.variants) {
      // Avant → après quand l'état précédent est connu (même variante).
      let prevTxt = '';
      if (before && before.hasData && before.byVariant) {
        const key = v.variant == null ? 'null' : String(v.variant);
        const prev = before.byVariant[key];
        if (prev && Number.isFinite(prev.pct)) prevTxt = ` (avant ${fmtPct(prev.pct)})`;
      }
      fields.push({
        name: `${v.variant == null ? '?' : 'Variant ' + v.variant} · ${v.role}`,
        value: `couverture **${fmtPct(v.pct)}**${prevTxt}\nplages : ${v.ranges.map(([a, b]) => a + ' – ' + b).join(' , ')}`,
        inline: true,
      });
    }
    if (after.totalsAvailable) {
      fields.push({
        name: 'Totaux',
        value:
          `treatment **${fmtPct(after.treatment.pct)}** · control ${fmtPct(after.control.pct)} · ` +
          `non éligible ${fmtPct(after.notEligible.pct)} · espace non décrit ${fmtPct(after.unassigned.pct)}`,
        inline: false,
      });
    } else {
      fields.push({
        name: 'Totaux',
        value: 'indisponibles (populations incompatibles / données ambiguës ou dégradées) — couvertures par variante uniquement',
        inline: false,
      });
    }
  } else if (kind === 'removed' && before && before.hasData) {
    fields.push({
      name: 'Dernier état connu',
      value: `treatment ${before.treatment.pct != null ? fmtPct(before.treatment.pct) : 'indisponible'} · ${before.variantsCount || (before.variants || []).length} variante(s)`,
      inline: false,
    });
  }
  if (kind !== 'new' && deltaPct != null) {
    fields.push({
      name: 'Δ treatment',
      value:
        deltaPct === 0
          ? '±0,00 pt — total treatment inchangé (redistribution entre variantes)'
          : fmtDelta(deltaPct),
      inline: true,
    });
  }
  if (after && after.ambiguous) {
    fields.push({
      name: '⚠ Données ambiguës',
      value:
        (after.flags || []).join(', ') +
        ' — couverture par population, totaux globaux indisponibles.',
      inline: false,
    });
  }

  const stamp = sourceMeta.updatedAt
    ? new Date(sourceMeta.updatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    : '?';
  return {
    title: `${headers[kind] || kind} — ${title}${typeLabel}`,
    color:
      kind === 'changed' && deltaPct != null && deltaPct < 0 ? EMBED_COLORS.down : EMBED_COLORS[kind] || 0x95a5a6,
    fields,
    footer: {
      text: `gist agnonotdev · révision ${String(sourceMeta.revision || '?').slice(0, 8)} · MAJ ${stamp}`,
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Rapport Markdown ───────────────────────────────────────────────────────

function writeReport(state, reportFile) {
  try {
    const gen = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const src = state.source || {};
    const out = [];
    out.push('# Rollouts user — couverture gist (v1)', '');
    out.push(
      '> Source : gist communautaire agnonotdev (copie réduite de rollouts.json, tag Assyst) · ' +
        'Généré le ' + gen + ' UTC',
      '',
    );
    out.push(
      '**Sémantique** : couverture de l\'espace de buckets (0-10000) selon la source communautaire, à 0,01 point près. ' +
        'Ce n\'est ni une estimation statistique, ni la proportion de vrais utilisateurs éligibles — ceci n\'est pas non plus ' +
        'une mesure d\'accès réel. Les expériences `guild` sont exclues (mesurées à part par le décodage wire apex).',
      '',
    );
    const s = state.stats || {};
    out.push(
      `**Gist** : [${src.gistId || '?'}](${src.htmlUrl || ''}) · révision ${String(src.revision || '?').slice(0, 8)} · MAJ ${src.updatedAt || '?'} · ` +
        `${s.total || 0} expériences au catalogue (${s.user || 0} user dont ${s.userData || 0} avec données, ${s.guild || 0} guild, ` +
        `${s.unclassified || 0} type inconnu, ${s.noData || 0} sans données)` +
        (src.fallback ? ` · ⚠️ **repli miroir** (canonique ${src.canonicalId} injoignable)` : ''),
      '',
    );
    if (state.mirror && state.mirror.diverged) {
      out.push(
        `⚠️ Miroir divergent (${state.mirror.gistId}) sur : ${(state.mirror.divergingIds || []).slice(0, 10).join(', ')}${(state.mirror.divergingIds || []).length > 10 ? '…' : ''}`,
        '',
      );
    }

    const users = (state.experiments || []).filter((e) => e.type === 'user' && e.hasData);
    out.push(`## Expériences user avec données (${users.length})`, '');
    out.push('| Expérience | Treatment | Control | Non éligible | Espace non décrit | Ambigu |');
    out.push('|---|---:|---:|---:|---:|---|');
    for (const e of users) {
      const cell = (t) => (t && t.pct != null ? fmtPct(t.pct) : '—');
      out.push(
        `| ${e.title} | ${e.totalsAvailable ? '**' + fmtPct(e.treatment.pct) + '**' : '—'} | ${cell(e.control)} | ${cell(e.notEligible)} | ${cell(e.unassigned)} | ${e.ambiguous ? '⚠ ' + e.flags.join(',') : '—'} |`,
      );
    }

    const untyped = (state.experiments || []).filter((e) => e.type === 'unclassified' && e.hasData);
    out.push('', `## Type inconnu — suivi séparé, non notifié (${untyped.length})`, '');
    out.push('> Absents de nos métadonnées locales au moment du calcul : à reclassifier au prochain scrape.');
    out.push('| Expérience | Treatment | Espace non décrit |');
    out.push('|---|---:|---:|');
    for (const e of untyped.slice(0, 200)) {
      out.push(`| ${e.id} | ${e.totalsAvailable ? fmtPct(e.treatment.pct) : '—'} | ${e.unassigned && e.unassigned.pct != null ? fmtPct(e.unassigned.pct) : '—'} |`);
    }

    out.push('', '## Détail par variante (user)');
    for (const e of users) {
      out.push('', '### ' + e.title + (e.ambiguous ? ' ⚠ ' + e.flags.join(',') : ''));
      for (const v of e.variants) {
        const name = v.variant == null ? '?' : 'Variant ' + v.variant;
        const role = v.role === 'not_eligible' ? 'non éligible' : v.role;
        const ranges = v.ranges.map(([a, b]) => a + ' – ' + b).join(' , ');
        out.push(`- ${name} (${role}) : ${fmtPct(v.pct)} · plages ${ranges}`);
      }
    }
    fs.writeFileSync(reportFile || REPORT, out.join('\n') + '\n');
  } catch (e) {
    const warn = process.env.GIST_ROLLOUT_TEST_QUIET === '1' ? () => {} : console.warn;
    warn('report skip:', String((e && e.message) || e).slice(0, 80));
  }
}

/**
 * Export display JSON pour la page docs/rollouts.html : entrées USER
 * uniquement (guild = décodage wire apex, déjà affiché à part), format
 * direct pour les cartes. Sémantique rappelée dans le fichier.
 */
function writeDocsExport(list, sourceMeta, stats, file) {
  try {
    const experiments = list
      .filter((e) => e.type === 'user')
      .map((e) => ({
        id: e.id,
        title: e.title || e.id,
        type: 'user',
        hasData: e.hasData,
        totalsAvailable: e.totalsAvailable,
        ambiguous: e.ambiguous,
        flags: e.flags || [],
        treatmentPct: e.hasData && e.treatment ? e.treatment.pct : null,
        controlPct: e.hasData && e.control ? e.control.pct : null,
        notEligiblePct: e.hasData && e.notEligible ? e.notEligible.pct : null,
        unassignedPct: e.hasData && e.unassigned ? e.unassigned.pct : null,
        byVariant: Object.fromEntries(
          Object.entries(e.byVariant || {}).map(([k, v]) => [k, { pct: v.pct, role: v.role }]),
        ),
      }));
    const out = {
      generatedAt: new Date().toISOString(),
      semantics:
        "couverture de l'espace de buckets (gist agnonotdev) — ni une proportion d'utilisateurs, ni une mesure d'accès réel",
      source: {
        gistId: sourceMeta.gistId,
        htmlUrl: sourceMeta.htmlUrl,
        updatedAt: sourceMeta.updatedAt,
        revision: sourceMeta.revision,
      },
      stats,
      experiments,
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  } catch (e) {
    const warn = process.env.GIST_ROLLOUT_TEST_QUIET === '1' ? () => {} : console.warn;
    warn('docs export skip:', String((e && e.message) || e).slice(0, 80));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(deps = {}) {
  // Injection (tests) : stateFile/reportFile pour un état temporaire,
  // fetchGists/postWebhook pour des doubles purs.
  const stateFile = deps.stateFile || STATE;
  const reportFile = deps.reportFile || REPORT;
  const fetchGistsFn = deps.fetchGists || fetchGists;
  const postWebhookFn = deps.postWebhook || postWebhook;

  // Logs neutralisables (tests : quiet → pas de flood de diagnostics).
  const log = deps.quiet ? () => {} : (...a) => console.log(...a);
  const warn = deps.quiet ? () => {} : (...a) => console.warn(...a);
  const err = deps.quiet ? () => {} : (...a) => console.error(...a);

  await fs.ensureDir(path.dirname(stateFile));
  log('📊 Gist user rollouts v1 (couverture buckets · gist agnonotdev)');
  log('Webhook:', WEBHOOK ? 'set (' + WEBHOOK_SOURCE + ')' : 'MISSING');
  log('Seuil de notification:', MIN_DELTA_PCT, 'pts');

  // 1) État précédent (toujours conservé si la lecture échoue).
  let prev = null;
  if (await fs.pathExists(stateFile)) {
    try {
      prev = await fs.readJson(stateFile);
    } catch (_) {}
  }
  // acknowledged : { id: ackEntry } — dernier état NOTIFIÉ avec succès.
  const acknowledged =
    prev && prev.acknowledged && typeof prev.acknowledged === 'object' ? prev.acknowledged : null;
  const isFirst = !acknowledged || !Object.keys(acknowledged).length;

  // 2) Lecture du gist canonique (+ miroir).
  const fetched = await fetchGistsFn(process.env.GITHUB_TOKEN || null);
  if (!fetched || fetched.error || !fetched.source || !Array.isArray(fetched.data)) {
    const why =
      (fetched && (fetched.error || (!fetched.source && 'réponse sans source'))) ||
      (!Array.isArray(fetched && fetched.data) && 'data non tableau') ||
      'réponse inattendue';
    err('Lecture des gists impossible (' + String(why).slice(0, 120) + ') — dernier état valide conservé.');
    return { ok: false, reason: 'fetch_failed', error: fetched && fetched.error };
  }
  const { source, data, mirror } = fetched;
  log(
    'Gist', source.gistId, '· révision', String(source.revision || '?').slice(0, 8),
    '· MAJ', source.updatedAt || '?', '·', data.length, 'expériences',
    source.fallback ? '· REPLI MIROIR (canonique injoignable)' : '',
  );
  if (mirror) {
    log(
      'Miroir', mirror.gistId, mirror.diverged ? 'DIVERGENT (' + mirror.divergingIds.length + ')' : 'identique',
    );
  }

  // 3) VALIDATION avant tout calcul/diff : un fichier invalide ne doit jamais
  //    ressembler à une suppression massive.
  const validation = validateGistData(data, { minEntries: deps.minEntries });
  if (!validation.ok) {
    err('Gist invalide (' + validation.error + ') — dernier état valide conservé.');
    return { ok: false, reason: 'invalid_data', error: validation.error };
  }
  log('Validation gist :', JSON.stringify(validation.stats));

  // Signal (pas une erreur) : gist inchangé depuis longtemps.
  if (source.updatedAt) {
    const ageH = (Date.now() - new Date(source.updatedAt).getTime()) / 3600000;
    if (ageH > STALE_H) {
      warn('Gist inchangé depuis', Math.round(ageH), 'h — simple signal, pas une panne.');
    }
  }

  // 4) Calcul + classification (defs injectables pour les tests).
  const defs = deps.defs || (await loadLocalDefs());
  const { typeCounts, list } = computeAll(data, defs);
  const noData = list.filter((e) => !e.hasData).length;
  const stats = {
    total: list.length,
    user: typeCounts.user,
    userData: list.filter((e) => e.type === 'user' && e.hasData).length,
    guild: typeCounts.guild,
    unclassified: typeCounts.unclassified,
    noData,
  };
  log('Stats:', JSON.stringify(stats));

  // 5) Diff contre acknowledged — SEULS les type 'user' sont notifiés
  //    (guild = apex wire à part ; type inconnu = suivi, pas de notification).
  const notifiable = {};
  const allCurIds = new Set(list.map((e) => e.id));
  for (const e of list) {
    if (e.type === 'user') notifiable[e.id] = e;
  }
  // curAllIds = catalogue complet : une expérience toujours au gist mais
  // reclassée hors user n'est PAS un retrait du gist.
  const changes = isFirst
    ? []
    : diffExperiments(acknowledged || {}, notifiable, MIN_DELTA_PCT, allCurIds);

  // 6) Notifications : UN embed PAR envoi — la livraison partielle est
  //    identifiable précisément (1 changement = 1 envoi = 1 acquittement).
  let delivered = 0;
  if (changes.length) {
    log('Changements vs acknowledged:', changes.length);
    for (const c of changes) {
      const embed = buildEmbed(c, source);
      const ok = await postWebhookFn([embed]);
      if (!ok) break; // acknowledged n'avance QUE sur les envois livrés.
      delivered += 1;
    }
  } else {
    log(isFirst ? 'Premier run : baseline silencieuse (pas de notification).' : 'Aucun changement.');
  }

  // 7) État + acknowledged : n'avance QUE sur les changements livrés.
  let newAcknowledged;
  if (isFirst) {
    // baseline silencieuse (entrées compactes, type user uniquement)
    newAcknowledged = {};
    for (const [id, e] of Object.entries(notifiable)) newAcknowledged[id] = ackEntry(e);
  } else {
    newAcknowledged = { ...(acknowledged || {}) };
    for (let i = 0; i < delivered && i < changes.length; i++) {
      const c = changes[i];
      if (c.kind === 'removed') delete newAcknowledged[c.id];
      else newAcknowledged[c.id] = ackEntry(c.after);
    }
    // Sortie du périmètre user (toujours au gist, ex. reclassée guild) :
    // silencieux — plus notifiable, plus surveillée, mais pas un retrait.
    for (const id of Object.keys(newAcknowledged)) {
      if (allCurIds.has(id) && !notifiable[id]) delete newAcknowledged[id];
    }
  }
  const stateObj = {
    version: 1,
    schemaVersion: 1,
    runId: new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + '_gist',
    scrapedAt: new Date().toISOString(),
    source: {
      gistId: source.gistId,
      htmlUrl: source.htmlUrl,
      rawUrl: source.rawUrl,
      updatedAt: source.updatedAt,
      revision: source.revision,
      fetchedAt: new Date().toISOString(),
      fallback: Boolean(source.fallback),
      rawFallback: Boolean(source.rawFallback),
      canonicalId: source.canonicalId || null,
    },
    mirror: mirror
      ? { gistId: mirror.gistId, diverged: mirror.diverged, divergingIds: mirror.divergingIds }
      : null,
    stats,
    acknowledged: newAcknowledged,
    lastRun: {
      changes: changes.length,
      delivered,
      firstRun: isFirst,
    },
    history: capHistory([
      ...(prev && Array.isArray(prev.history) ? prev.history : []),
      {
        at: new Date().toISOString(),
        revision: source.revision,
        changes: changes.length,
        delivered,
      },
    ]),
  };
  await writeJsonAtomic(stateFile, stateObj, 1);
  // Rapport depuis la liste complète (variantes + titres), pas l'état compact.
  writeReport({ ...stateObj, experiments: list }, reportFile);
  // Export display pour la page docs/rollouts.html (source user de référence).
  writeDocsExport(
    list,
    source,
    stats,
    /\.md$/.test(String(reportFile)) ? String(reportFile).replace(/\.md$/, '_docs.json') : reportFile + '_docs.json',
  );
  log('État écrit:', stateFile, '· livrés:', delivered, '/', changes.length);

  return { ok: true, changes: changes.length, delivered };
}

function capHistory(arr, cap = 50) {
  return arr.slice(-cap);
}

/**
 * Envoie UN embed. Retourne true seulement si l'envoi a réussi (au moins un
 * message livré). Un échec réseau/429 après une livraison partielle du même
 * embed peut dupliquer un fragment — risque accepté et documenté, bien
 * moindre qu'un lot de 10 embeds indécoupable.
 */
async function postWebhook(embeds) {
  if (!WEBHOOK) {
    console.warn('Webhook manquant — notifications perdues (acknowledged n\'avance pas).');
    return false;
  }
  try {
    const res = await sendEmbeds(WEBHOOK, { username: BOT, avatar_url: AVATAR }, embeds);
    return Boolean(res && res.ok && res.sent > 0);
  } catch (e) {
    console.warn('webhook fail:', String(e.message).slice(0, 120));
    return false;
  }
}

if (require.main === module) {
  main()
    .then((r) => {
      if (!r || !r.ok) process.exit(1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { main, computeAll, buildEmbed, writeReport, writeDocsExport, loadLocalDefs, ackEntry };
