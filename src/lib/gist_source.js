/**
 * Adaptateur de source communautaire — gist « rollouts-tag.json » (agnonotdev).
 *
 * Le gist publie, pour ~1000 expériences USER de Discord, les plages de
 * positions exactes (« 0 - 10000 », échelle [0, 10000)) par variante :
 *   [{ id, variants: [{ variant, role, ranges: ["a - b", ...] }] }]
 *
 * Sémantique retenue (vérifiée sur 850 positions live) :
 *  - plages demi-ouvertes [a, b) : la couverture d'une variante est
 *    l'UNION de ses plages (jamais la somme — des plages peuvent se
 *    chevaucher ou être dupliquées entre variantes / populations) ;
 *  - variant « none » (chaîne) = not_eligible : jamais comptée dans la
 *    couverture d'un traitement ;
 *  - hash = murmur3(id) (même schéma que l'API Discord legacy).
 *
 * Provenance conservée : id du gist, version (commit), published_at
 * (métadonnée de publication, pas une preuve d'observation récente).
 * Le producteur original de rollouts.json n'est pas identifiable →
 * étiquette honnête : « plages publiées par la communauté ».
 *
 * Aucune revendication d'exactitude : les % issus des plages sont la
 * COUVERTURE CONFIGURÉE (parmi la population éligible), pas la part
 * d'utilisateurs réels — les filtres d'éligibilité ne sont pas exportés.
 */
'use strict';

const { murmur3 } = require('./murmur3');

const DEFAULT_GIST_IDS = [
  'e3e99062983e6bd0feaef833f14fd931',
  '192b2ce20539ce1021b5c8cb01b17ff0',
];

const FILE_NAME = 'rollouts-tag.json';

function envGistIds() {
  const raw = process.env.USER_ROLLOUTS_GIST_IDS;
  if (!raw) return DEFAULT_GIST_IDS;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? ids : DEFAULT_GIST_IDS;
}

/**
 * Parse « 400 - 700 » → [400, 700] (demi-ouvert).
 * Retourne null si la plage est invalide (hors [0,10000], a >= b, format).
 */
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 10000 || a >= b) return null;
  return [a, b];
}

/**
 * Largeur de l'UNION d'un ensemble de plages demi-ouvertes.
 * Les chevauchements et doublons ne sont jamais comptés deux fois.
 */
function unionWidth(ranges) {
  const sorted = ranges
    .map(parseRange)
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let total = 0;
  let end = -1;
  let overlaps = false;
  for (const [a, b] of sorted) {
    if (a < end) overlaps = true; // chevauchement / doublon détecté
    if (b > end) {
      total += b - Math.max(a, end);
      end = b;
    }
  }
  return { width: total, overlaps };
}

/**
 * Parse le contenu du gist (rollouts-tag.json).
 * Entrée : tableau [{ id, variants: [...] }] (format brut du gist).
 * Sortie : {
 *   byHash: Map(hash → {
 *     id, hash,
 *     treatment: { pct, ranges: [[a,b]], selfOverlap, crossOverlap } | null,
 *     control:   { pct, ranges } | null,
 *     roles: [ { bucket: number|null, role, pct } ],   // détail, 'none' → bucket null
 *     ambiguous: bool,
 *   }),
 *   count, hashCollisions: number, malformedRanges: number
 * }
 */
function parseRolloutsTag(entries) {
  const byHash = new Map();
  const out = {
    byHash,
    count: 0,
    hashCollisions: 0,
    malformedRanges: 0,
  };
  if (!Array.isArray(entries)) return out;

  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !Array.isArray(e.variants)) continue;
    const hash = murmur3(e.id);
    if (byHash.has(hash)) {
      out.hashCollisions += 1; // deux ids → même hash : jointure non fiable
      continue;
    }

    const roles = [];
    let treatmentRanges = [];
    let controlRanges = [];
    let notEligibleRanges = [];
    let selfOverlap = false;
    let crossOverlap = false;
    let malformed = 0;

    const hits = (rangesA, rangesB) =>
      rangesA.some(([a, b]) => rangesB.some(([c, d]) => a < d && c < b));

    for (const v of e.variants) {
      if (!v || !Array.isArray(v.ranges)) continue;
      const bucket = typeof v.variant === 'number' ? v.variant : null; // 'none' → null
      const role = typeof v.role === 'string' ? v.role : 'unknown';
      const ranges = v.ranges.map(parseRange).filter(Boolean);
      malformed += v.ranges.length - ranges.length;
      if (!ranges.length) continue;

      // Union au sein de la variante (détecte les chevauchements internes).
      const u = unionWidth(v.ranges);
      if (u.overlaps) selfOverlap = true;
      roles.push({ bucket, role, pct: u.width / 100, ranges });

      if (role === 'treatment' && bucket !== null) {
        // Chevauchement avec une autre variante déjà vue (y compris
        // not_eligible : « none 0-10000 » + « treatment 0-10000 » =
        // populations aplaties, couverture non sommable).
        if (hits(ranges, treatmentRanges) || hits(ranges, controlRanges) || hits(ranges, notEligibleRanges)) crossOverlap = true;
        treatmentRanges = treatmentRanges.concat(ranges);
      } else if (role === 'control') {
        if (hits(ranges, treatmentRanges) || hits(ranges, controlRanges) || hits(ranges, notEligibleRanges)) crossOverlap = true;
        controlRanges = controlRanges.concat(ranges);
      } else {
        // not_eligible / autre : jamais compté dans la couverture, mais
        // conservé pour la détection d'ambiguïté ci-dessus.
        notEligibleRanges = notEligibleRanges.concat(ranges);
      }
    }

    out.malformedRanges += malformed;
    const t = treatmentRanges.length ? unionWidth(treatmentRanges.map(([a, b]) => `${a} - ${b}`)) : null;
    const c = controlRanges.length ? unionWidth(controlRanges.map(([a, b]) => `${a} - ${b}`)) : null;

    byHash.set(hash, {
      id: e.id,
      hash,
      treatment: t ? { pct: t.width / 100, ranges: treatmentRanges, selfOverlap: t.overlaps } : null,
      control: c ? { pct: c.width / 100, ranges: controlRanges } : null,
      roles,
      ambiguous: selfOverlap || crossOverlap,
    });
    out.count += 1;
  }
  return out;
}

/**
 * Récupère le gist et retourne un snapshot normalisé :
 * {
 *   ok, stale: false,
 *   parsed: <sortie de parseRolloutsTag>,
 *   provenance: { gistId, version, publishedAt, fetchedAt, source }
 * }
 *
 * Deux chemins, dans l'ordre :
 *  1. API GitHub (api.github.com/gists/{id}) — donne la provenance complète
 *     (updated_at, version). Peut être limitée en anonyme (403) : en CI le
 *     GITHUB_TOKEN automatique l'évite.
 *  2. Repli : gist.githubusercontent.com/{owner}/{id}/raw — pas de limite,
 *     mais pas de métadonnées (version/publishedAt à null, honnête).
 *
 * En cas d'échec total → { ok: false } (l'appelant garde son dernier
 * snapshot valide et le marque stale — jamais de 0 % inventé).
 */
const RAW_GIST_OWNER = 'agnonotdev';

async function fetchGistSnapshot(fetchImpl, gistIds, now = new Date()) {
  const doFetch = fetchImpl || require('node-fetch');
  const ids = gistIds && gistIds.length ? gistIds : envGistIds();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { 'User-Agent': 'discord-canary-scraper', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const parseEntries = (text) => {
    try {
      const entries = JSON.parse(text);
      return Array.isArray(entries) ? entries : null;
    } catch (_) {
      return null;
    }
  };

  // Chemin 1 : API GitHub (provenance complète).
  // Un candidat n'est UTILISABLE que s'il est non vide (un `[]` récent ne
  // doit jamais écraser un snapshot valide plus ancien).
  const fetched = [];
  for (const gistId of ids) {
    try {
      const res = await doFetch(`https://api.github.com/gists/${gistId}`, {
        headers,
        timeout: 20000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const file = data && data.files && data.files[FILE_NAME];
      if (!file || !file.content) continue;
      const entries = parseEntries(file.content);
      if (!entries || !entries.length) continue; // snapshot vide → inutilisable
      fetched.push({
        gistId,
        version: (data.history && data.history[0] && data.history[0].version) || null,
        publishedAt: data.updated_at || null,
        fetchedAt: now.toISOString(),
        entries,
      });
    } catch (_) {
      // réseau / timeout / limite API → repli brut ci-dessous
    }
  }

  // Chemin 2 (repli) : URL brute du gist — évite la limite API, mais sans
  // métadonnées (version/publishedAt à null, affiché honnêtement).
  if (!fetched.length) {
    for (const gistId of ids) {
      try {
        const res = await doFetch(
          `https://gist.githubusercontent.com/${RAW_GIST_OWNER}/${gistId}/raw`,
          { headers: { 'User-Agent': 'discord-canary-scraper' }, timeout: 20000 },
        );
        if (!res.ok) continue;
        const text = await res.text();
        const entries = parseEntries(text);
        if (!entries || !entries.length) continue;
        fetched.push({
          gistId,
          version: null,
          publishedAt: null,
          fetchedAt: now.toISOString(),
          entries,
        });
      } catch (_) {
        // on tente le gist suivant
      }
    }
  }

  if (!fetched.length) return { ok: false, stale: true };

  // Le plus récent par métadonnée de publication (updated_at) quand elle
  // existe ; sinon premier gist valide (les copies peuvent différer de
  // quelques enregistrements — on affiche la provenance retenue).
  fetched.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
  const best = fetched[0];
  const parsed = parseRolloutsTag(best.entries);
  return {
    ok: true,
    stale: false,
    parsed,
    provenance: {
      gistId: best.gistId,
      version: best.version,
      publishedAt: best.publishedAt,
      fetchedAt: best.fetchedAt,
      url: `https://gist.github.com/${RAW_GIST_OWNER}/${best.gistId}`,
      source: 'gist communautaire (agnonotdev)',
    },
  };
}

module.exports = {
  DEFAULT_GIST_IDS,
  FILE_NAME,
  parseRange,
  unionWidth,
  parseRolloutsTag,
  fetchGistSnapshot,
  envGistIds,
};
