function buildQuestComponentsV2(quest) {
  const start = formatDateFr(quest.startsAt);
  const end = formatDateFr(quest.expiresAt);
  let duree = '—';
  if (start && end) duree = start + ' → ' + end;
  else if (start) duree = 'À partir du ' + start;
  else if (end) duree = 'Jusqu’au ' + end;

  const header = [
    '## Nouvelle quête',
    '### ' + String(quest.name).slice(0, 200),
  ];
  if (quest.preview) header.push('⚠️ _Aperçu (preview)_');

  const logo =
    (quest.logotype && isImageUrl(quest.logotype) && quest.logotype) ||
    (quest.gameTile && isImageUrl(quest.gameTile) && quest.gameTile) ||
    null;
  const gameLabel =
    quest.gameTitle || quest.applicationName || quest.name || 'Jeu';
  const appLabel = quest.applicationName || null;

  const blocks = [];

  if (quest.heroImage && isImageUrl(quest.heroImage)) {
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.heroImage },
          description: String(quest.name).slice(0, 100),
        },
      ],
    });
  }

  blocks.push({ type: 10, content: header.join('\n').slice(0, 4000) });
  blocks.push({ type: 14, divider: true, spacing: 1 });

  const info = [
    '**Durée**',
    duree,
    '',
    '**Plateformes** · ' + (quest.platforms || 'Multiplateforme'),
    '**Pays** · ' + (quest.regionFlags || '🌍'),
  ];
  if (quest.publisher) info.push('**Éditeur** · ' + String(quest.publisher).slice(0, 120));
  if (quest.features) info.push('**Flags** · ' + quest.features);
  blocks.push({ type: 10, content: info.join('\n').slice(0, 4000) });

  if (logo) {
    let line = '**Jeu** · ' + String(gameLabel).slice(0, 180);
    if (appLabel && appLabel !== gameLabel) {
      line += '\n**Application** · ' + String(appLabel).slice(0, 120);
    } else if (quest.applicationId) {
      line += '\n`' + quest.applicationId + '`';
    }
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push(sectionWithThumb(line, logo, String(gameLabel).slice(0, 100)));
  } else if (quest.gameTitle || quest.applicationName) {
    const bits = [];
    if (quest.gameTitle) bits.push('**Jeu** · ' + String(quest.gameTitle).slice(0, 180));
    if (quest.applicationName || quest.applicationId) {
      bits.push(
        '**Application** · ' +
          (quest.applicationName || 'App') +
          (quest.applicationId ? ' · `' + quest.applicationId + '`' : ''),
      );
    }
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({ type: 10, content: bits.join('\n').slice(0, 4000) });
  }

  if (quest.tasksText) {
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: ('**Tâches**\n' + quest.tasksText).slice(0, 4000),
    });
  }

  const rewards = quest.rewards || [];
  if (rewards.length) {
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({ type: 10, content: '**Récompenses**' });

    for (const r of rewards.slice(0, 8)) {
      const isOrbs =
        r.orbQuantity != null ||
        r.type === 4 ||
        /orbe/i.test(String(r.typeLabel || ''));

      if (isOrbs && r.orbQuantity != null) {
        const line =
          '• **' +
          (r.typeLabel || 'Orbes') +
          '** · **' +
          r.orbQuantity +
          ' orbes**' +
          (r.skuId ? '\n　SKU `' + r.skuId + '`' : '');
        blocks.push(
          sectionWithThumb(
            line,
            orbImageUrl(r.orbQuantity),
            String(r.orbQuantity) + ' orbes',
          ),
        );
        continue;
      }

      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';
      if (r.skuId) line += '\n　SKU `' + r.skuId + '`';

      if (r.asset && isImageUrl(r.asset)) {
        blocks.push(
          sectionWithThumb(line, r.asset, r.name || r.typeLabel || 'Récompense'),
        );
      } else {
        blocks.push({ type: 10, content: line.slice(0, 4000) });
      }
    }
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });

  if (quest.videoUrl && isVideoUrl(quest.videoUrl)) {
    const vLabel = quest.videoLabel || 'Vidéo';
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({ type: 10, content: '**' + vLabel + '**' });
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.videoUrl },
          description: vLabel.slice(0, 100),
        },
      ],
    });
  }

  const buttons = [];
  if (quest.videoUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: (quest.videoLabel || 'Vidéo').slice(0, 80),
      url: quest.videoUrl.slice(0, 512),
    });
  }
  if (quest.applicationLink) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'Lien application',
      url: quest.applicationLink.slice(0, 512),
    });
  }
  for (const r of rewards) {
    if (r.redemptionLink && buttons.length < 5) {
      buttons.push({
        type: 2,
        style: 5,
        label: 'Récupérer récompense',
        url: String(r.redemptionLink).slice(0, 512),
      });
      break;
    }
  }
  if (buttons.length) {
    blocks.push({ type: 1, components: buttons.slice(0, 5) });
  }

  return {
    flags: IS_COMPONENTS_V2,
    components: [
      {
        type: 17,
        accent_color: 0,
        components: blocks,
      },
    ],
  };
}
