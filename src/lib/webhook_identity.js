'use strict';

// Les avatars du dépôt sont des illustrations vectorielles simples, pas des portraits IA.
const MEDIA = 'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@2600f26572392c44397e72766660521332ce56ee/media/';
const EMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/';

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
  mobile: ['Mobile', EMOJI + '1f4f1.png'],
  quests: ['Quêtes', EMOJI + '1f3c6.png'],
  shop: ['Boutique', EMOJI + '1f6cd.png'],
  x: ['Actualités X', EMOJI + '1f4f0.png'],
});

function webhookIdentity(type) {
  const entry = IDENTITIES[type];
  if (!entry) throw new Error(`Unknown webhook identity: ${type}`);
  return { username: `Datamining · ${entry[0]}`, avatar_url: entry[1] };
}

module.exports = { webhookIdentity, IDENTITIES };
