// Mini-relais syndication X : GitHub Actions → Cloudflare Worker → X.
// Déployé sur votre compte Cloudflare gratuit — mode d'emploi : relay/README.md.
// Sort des IP GitHub Actions partagées, dont le budget X (30 req / 15 min / IP)
// est épuisé en permanence par les autres jobs de la plateforme.
//
// Route   : GET /profile/<handle>?key=<RELAY_KEY>
// Variable : RELAY_KEY (Settings → Variables, type Secret). Facultative mais
//            recommandée : évite qu'un tiers consomme votre relais.

const SYNDICATION_BASE =
  'https://syndication.twitter.com/srv/timeline-profile/screen-name/';
const UA = 'x-cli/dev (+https://github.com/tamnd/x-cli)';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.RELAY_KEY && url.searchParams.get('key') !== env.RELAY_KEY) {
      return new Response('unauthorized', { status: 401 });
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'profile' || !/^[A-Za-z0-9_]{1,15}$/.test(parts[1])) {
      return new Response('usage: /profile/<handle>', { status: 404 });
    }
    const upstream = await fetch(SYNDICATION_BASE + parts[1], {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') || 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-upstream-status': String(upstream.status),
      },
    });
  },
};
