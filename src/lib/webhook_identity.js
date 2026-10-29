'use strict';

// Les avatars du dépôt sont des illustrations vectorielles simples, pas des portraits IA.
const MEDIA = 'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@2600f26572392c44397e72766660521332ce56ee/media/';
const EMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/';
// Trophée des quêtes : Noto Emoji 3D (512 px) — le Twemoji 72 px était flou
// dès qu'il servait de photo de profil Discord.
const NOTO_3D = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@99701e07d3d1fe1bdbcdb14964547f0fd592966f/3D/png/512/';

const IDENTITIES = Object.freeze({
  experiments: ['Expériences', MEDIA + 'avatar-experiments.png'],
  strings: ['Textes', MEDIA + 'datamining-avatar.png'],
  routes: ['Routes', MEDIA + 'avatar-dismissible.png'],
  dismissible: ['Contenus', MEDIA + 'avatar-dismissible.png'],
  apex: ['Rollouts serveurs', MEDIA + 'avatar-apex-rollouts.png'],
  userRollouts: ['Rollouts utilisateurs', MEDIA + 'avatar-gist-rollouts.png'],
  gistRollouts: ['Rollouts Gist', MEDIA + 'avatar-gist-rollouts.png'],
  blog: ['Blog & aide', MEDIA + 'avatar-blog.png'],
  alerts: ['Alertes', MEDIA + 'avatar-alerts.png'],
  newsMonde: ['Actus · Monde', NOTO_3D + 'emoji_u1f30d.png'],
  newsSocial: ['Actus · Réseaux sociaux', NOTO_3D + 'emoji_u1f310.png'],
  newsFoot: ['Actus · Foot', NOTO_3D + 'emoji_u26bd.png'],
  newsTech: ['Actus · iPhone & Android', NOTO_3D + 'emoji_u1f4f1.png'],
  newsSpotify: ['Actus · Spotify', NOTO_3D + 'emoji_u1f3a7.png'],
  mobile: ['Mobile', EMOJI + '1f4f1.png'],
  quests: ['Quêtes', NOTO_3D + 'emoji_u1f3c6.png'],
  shop: ['Boutique', EMOJI + '1f6cd.png'],
  x: ['Actualités X', EMOJI + '1f4f0.png'],
});

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES };
