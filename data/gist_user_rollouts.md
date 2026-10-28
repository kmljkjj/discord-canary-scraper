# Rollouts user — couverture gist (v1)

> Source : gist communautaire agnonotdev (copie réduite de rollouts.json, tag Assyst) · Généré le 2026-10-28 20:53 UTC

**Sémantique** : couvertures calculées exactement à partir des plages fournies par la source (0-10000), à 0,01 point près. Totaux par rôle = UNION des plages (un bucket appartient à un rôle s'il tombe dans l'union de ses plages). Quand la structure révèle plusieurs populations aplaties (drapeau `multi_population`) ou des rôles conflictuels/inconnus, l'agrégation est indéterminée (poids des populations absents du gist) : totaux principaux indisponibles, l'union est montrée en métrique secondaire étiquetée « projetée » (non pondérée). L'absence du drapeau ne prouve PAS une population unique — le gist n'en garde pas les frontières. Cohérent avec notre décodage wire apex (mêmes plages → mêmes nombres). Ce n'est ni une estimation statistique, ni la proportion de vrais utilisateurs éligibles, ni une mesure d'accès réel. Les expériences `guild` sont exclues (mesurées à part par le décodage wire apex).

**Gist** : [e3e99062983e6bd0feaef833f14fd931](https://gist.github.com/agnonotdev/e3e99062983e6bd0feaef833f14fd931) · révision 565a58e9 · MAJ 2026-10-28T12:04:36Z · 1006 expériences au catalogue (356 user dont 149 avec données, 38 guild, 612 type inconnu, 270 sans données)

⚠️ Miroir divergent (192b2ce20539ce1021b5c8cb01b17ff0) sur : 2026-10-pinot-admin, 2026-10-clickable-hero-banner, 2026-10-collectibles-interactive-jumble-bar, 2026-10-fix-soundboard-muting-iconography, 2026-10-soundboard-mute-indicator, 2026-09-new-orb-reward-visuals, 2026-09-non-nitro-file-upload-marketing, 2026-09-mobile-nitro-preview-direct-checkout, 2026-09-mobile-sticker-picker-upsell-restyle, 2026-09-game-search-row…

## Expériences user avec données (149)

| Expérience | Treatment | Control | Non éligible | Espace non décrit | Particularités |
|---|---:|---:|---:|---:|---|
| 2026-10-web-streaming-optimizations | **16,00 %** | 4,00 % | 0,00 % | 80,00 % | — |
| 2026-10-soundboard-mute-indicator | **1,00 %** | 1,00 % | 0,00 % | 98,00 % | — |
| 2026-10-remove-quests-from-discovery | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-10-purchase-history | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-10-profile-default-tab-with-content | **30,00 %** | 30,00 % | 0,00 % | 40,00 % | — |
| 2026-10-pinot-member | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-10-nitro-tab-remove-account-age-restriction | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-10-macaron-non-sub-marketing | **90,50 %** | 9,50 % | 0,00 % | 0,00 % | — |
| 2026-10-macaron | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-10-guild-tooltip-lazy-content | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-10-gdm-duration-timer | **8,50 %** | 3,50 % | 0,00 % | 88,00 % | — |
| 2026-10-game-exit-promo-rust | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-10-fix-soundboard-muting-iconography | **1,00 %** | 1,00 % | 0,00 % | 98,00 % | — |
| 2026-10-desktop-tti-perf | **5,00 %** | 5,00 % | 0,00 % | 90,00 % | — |
| 2026-10-desktop-general-perf | **5,00 %** | 5,00 % | 0,00 % | 90,00 % | — |
| 2026-10-desktop-game-perf | **5,00 %** | 5,00 % | 0,00 % | 90,00 % | — |
| 2026-10-collectibles-interactive-jumble-bar | **15,00 %** | 15,00 % | 0,00 % | 70,00 % | — |
| 2026-10-code-blurple-marketing-holdout | **95,00 %** | 5,00 % | 0,00 % | 0,00 % | — |
| 2026-10-code-blurple | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-10-cod-relink | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-10-clickable-hero-banner | **5,00 %** | 5,00 % | 0,00 % | 90,00 % | — |
| 2026-10-badge-directory-updates | **85,00 %** | 15,00 % | 0,00 % | 0,00 % | — |
| 2026-10-avx512-entropy-histogram | **15,00 %** | 15,00 % | 0,00 % | 70,00 % | — |
| 2026-09-youtube-3p-nagbar | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-youtube-3p | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-try-display-name-style | **26,66 %** | 13,33 % | 0,00 % | 60,01 % | — |
| 2026-09-three-month-nitro-gifting | **20,00 %** | 20,00 % | 0,00 % | 60,00 % | — |
| 2026-09-stream-zero-vad-leading | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-09-soundboard-quick-action | **95,00 %** | 0,00 % | 0,00 % | 5,00 % | — |
| 2026-09-silp-direct-to-discoverable | **0,00 %** | 3,00 % | 0,00 % | 97,00 % | — |
| 2026-09-silp-cta-copy-tests | **0,00 %** | 4,00 % | 0,00 % | 96,00 % | — |
| 2026-09-request-to-stream-go-live-modal | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-referral-trial-cta | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-quest-mobile-bar-secondary-cta | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-profile-widget-empty-state-suggestions | **10,00 %** | 5,00 % | 0,00 % | 85,00 % | — |
| 2026-09-profile-link-fetch | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-orbs-hero-carousel | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-non-nitro-file-upload-marketing | **76,50 %** | 0,00 % | 0,00 % | 23,50 % | — |
| 2026-09-nitro-file-upload-rollout | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-new-orb-reward-visuals | **49,50 %** | 0,00 % | 0,00 % | 50,50 % | — |
| 2026-09-new-horizontal-scroll-shared | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-nameplate-video-preload-none | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-multi-sku-embed-rendering | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-mobile-sticker-picker-upsell-restyle | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-mobile-quest-home-sort-priority | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-09-manual-review-inconclusive-copy | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-invite-silp-education | **0,00 %** | 2,50 % | 0,00 % | 97,50 % | — |
| 2026-09-invite-accept-age-group-errors | **5,00 %** | 0,00 % | 0,00 % | 95,00 % | — |
| 2026-09-halloween-holiday | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-gifting-badge-coachmark-audience | **25,00 %** | 25,00 % | 0,00 % | 50,00 % | — |
| 2026-09-game-profiles-v3-communities-tab | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-game-profiles-v3-commerce-tab | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-09-friends-sidebar | **10,00 %** | 5,00 % | 0,00 % | 85,00 % | — |
| 2026-09-edit-profile-collectibles-ordering | **2,50 %** | 2,50 % | 0,00 % | 95,00 % | — |
| 2026-09-clips-editor-image-track | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-09-application-test-mode-quick-access | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-vq-remaining-time-truncation | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-user-bio-max-length | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-top-soundboard-sounds-mobile | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-top-soundboard-sounds | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-tiny-bronco | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-timestamp-autocomplete-mobile | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-show-expressive-modal-subtitle-alt | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-scheduled-messages | **20,00 %** | 10,00 % | 0,00 % | 70,00 % | — |
| 2026-08-profile-embed-share-button | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-profile-embed-rendering | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-no-fill-logging | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-nitro-tenure-badge-total-progress | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-mobile-emoji-picker-upsell-restyle | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-guilds-bar-media-state-store | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-08-gift-recipient-display-name-search | **75,00 %** | 0,00 % | 0,00 % | 25,00 % | — |
| 2026-08-game-profiles-vc | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-game-community-add-server-entry | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-dont-close-chat | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-dcf-new-user-cooldown | **75,00 %** | 25,00 % | 0,00 % | 0,00 % | — |
| 2026-08-compress-logs | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-08-badge-management | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-08-ad-topic-opt-out-client | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-you-bar-guild-tag | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-wishlist-direct-to-gifting | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-unobtrusive-device-suggestions | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-typing-users-css-dots | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-smag-mobile-wishlist-suggestions | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-shop-this-look-mobile | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-orbchievements | **30,00 %** | 30,00 % | 0,00 % | 40,00 % | — |
| 2026-07-nvenc-reconstructed-frames | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-mobile-emoji-suggestions | **3,00 %** | 1,00 % | 0,00 % | 96,00 % | — |
| 2026-07-mobile-boosting-optimizations | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-krisp-cpu-disablement | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-expressive-modal-v2 | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-07-custom-typing-indicator | **90,00 %** | 0,00 % | 0,00 % | 10,00 % | — |
| 2026-06-web-translate-dom-guard | **0,00 %** | 1,00 % | 0,00 % | 99,00 % | — |
| 2026-06-upscale-small-captured-frames | **0,50 %** | 0,50 % | 0,00 % | 99,00 % | — |
| 2026-06-nitro-gdm-cap-increase | **1,00 %** | 0,00 % | 0,00 % | 99,00 % | — |
| 2026-06-mobile-server-tag | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-06-mobile-media-viewer-share | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-06-improved-shop-loading | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-06-gummy-bears | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-06-gifting-badge-desktop | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-06-gift-acom-order | **25,00 %** | 25,00 % | 0,00 % | 50,00 % | — |
| 2026-06-dont-badge-muted-vcs | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-05-use-ad-analytics-interface | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-05-mana-type-consolidation | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-05-dvp-for-attachments | **10,00 %** | 0,00 % | 0,00 % | 90,00 % | — |
| 2026-05-disable-camera-simulcast | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-04-safety-flows | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-04-one-day-fractional-nitro | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-04-declarative-notif-settings | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-04-collectibles-profile-frames-purchase | **15,00 %** | 0,00 % | 0,00 % | 85,00 % | — |
| 2026-04-browser-transceiver-padding-removal | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-03-nitro-acom-subscription | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-03-new-server-boost-system-messages | **10,00 %** | 5,00 % | 0,00 % | 85,00 % | — |
| 2026-03-message-bookmarks | **10,00 %** | 5,00 % | 0,00 % | 85,00 % | — |
| 2026-03-media-play-metrics | **10,00 %** | 90,00 % | 0,00 % | 0,00 % | — |
| 2026-03-l-3pp | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-03-image-load-metrics | **10,00 %** | 90,00 % | 0,00 % | 0,00 % | — |
| 2026-03-friend-request-message | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-03-denormalized-perks-access-read | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-02-voice-channel-link-click | **30,00 %** | 0,00 % | 0,00 % | 70,00 % | — |
| 2026-02-silence-warning-aggression | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-02-referral-reminder-dc | **0,40 %** | 0,00 % | 0,00 % | 99,60 % | — |
| 2026-02-process-boost-on-voice | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-02-private-channel-hiding | **2,00 %** | 0,00 % | 0,00 % | 98,00 % | — |
| 2026-02-lazy-load-all-images | **30,00 %** | 30,00 % | 0,00 % | 40,00 % | — |
| 2026-02-join-game-community-cta | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-02-gsh-game-detection-upsell | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2026-02-go-live-video-preset-resolution | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-02-gifting-modal-redesign | **50,00 %** | 50,00 % | 0,00 % | 0,00 % | — |
| 2026-02-gift-cards | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2026-02-game-server-tab-always-on | **20,00 %** | 20,00 % | 0,00 % | 60,00 % | — |
| 2026-02-expiring-powerup-coachmark | **20,00 %** | 20,00 % | 0,00 % | 60,00 % | — |
| 2026-02-capture-target-window | **20,00 %** | 20,00 % | 0,00 % | 60,00 % | — |
| 2026-02-activity-privacy-matching | **0,00 %** | 21,00 % | 0,00 % | 79,00 % | — |
| 2026-01-less-personalized-ads | **10,00 %** | 0,00 % | 0,00 % | 90,00 % | — |
| 2026-01-favorites-server | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2025-12-wmf-gpu-encode | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| 2025-12-quest-cta-refactor-rollout | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2025-12-nitro-s-rewards | **20,00 %** | 10,00 % | 0,00 % | 70,00 % | — |
| 2025-12-mana-multistep-community-enabled | **5,00 %** | 5,00 % | 0,00 % | 90,00 % | — |
| 2025-12-09-ptt-education | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2025-11-overlay-chat | **66,00 %** | 33,00 % | 0,00 % | 1,00 % | — |
| 2025-11-hide-manual-link | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2025-11-global-frame-pool-lock | **10,00 %** | 10,00 % | 0,00 % | 80,00 % | — |
| Tida Webform | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2025-10-friend-request-alerts-v2 | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| 2025-09-video-qoe-metrics-tracking | **1,00 %** | 1,00 % | 0,00 % | 98,00 % | — |
| Safety Experience IAR User Reporting | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| Safety Experience Unauthenticated Report Form | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |
| Inferno Spam Redaction | **100,00 %** | 0,00 % | 0,00 % | 0,00 % | — |

## Type inconnu — suivi séparé, non notifié (556)

> Absents de nos métadonnées locales au moment du calcul : à reclassifier au prochain scrape.
| Expérience | Treatment | Espace non décrit | Particularités |
|---|---:|---:|---|
| hash:1765194502 | 100,00 % | 0,00 % | — |
| hash:1443876045 | 100,00 % | 0,00 % | — |
| 2026-10-media-viewer-improvements | 0,00 % | 50,00 % | — |
| 2026-10-game-profile-mobile-reviews | 100,00 % | 0,00 % | — |
| 2026-10-android-stop-and-pause-video | 50,00 % | 0,00 % | — |
| 2026-10-android-photo-picker | 50,00 % | 0,00 % | — |
| 2026-10-android-media-viewer-full-resolution | 100,00 % | 0,00 % | — |
| 2026-10-android-fastimage-apng | 25,00 % | 50,00 % | — |
| 2026-09-wysiwyg-user-profile-edit-polish | 100,00 % | 0,00 % | — |
| 2026-09-voice-server-update-immediate-mobile | 10,00 % | 80,00 % | — |
| 2026-09-soundboard-favorites | 100,00 % | 0,00 % | — |
| 2026-09-smag-nitro-gifting-lightning-checkout | 0,00 % | 0,00 % | — |
| 2026-09-recent-activity-mobile | 100,00 % | 0,00 % | — |
| 2026-09-profile-frame-layer-preload-mobile | 5,00 % | 90,00 % | — |
| 2026-09-new-hscroll | 100,00 % | 0,00 % | — |
| 2026-09-multisku-embed-builder | 100,00 % | 0,00 % | — |
| 2026-09-mobile-nlp-search-user-flag | 100,00 % | 0,00 % | — |
| 2026-09-mobile-nlp-search-guild-experiment | 0,00 % | 0,00 % | — |
| 2026-09-mobile-nitro-preview-direct-checkout | 50,00 % | 0,00 % | — |
| 2026-09-mobile-nitro-orbs-delivered-modal | 100,00 % | 0,00 % | — |
| 2026-09-markdown-file-preview | 100,00 % | 0,00 % | — |
| 2026-09-jxr-upload-conversion | 100,00 % | 0,00 % | — |
| 2026-09-guild-members-in-mobile-vc-invites | 0,00 % | 0,00 % | — |
| 2026-09-gifting-badge-complex-art | 100,00 % | 0,00 % | — |
| 2026-09-dismissible-content-server-arbitration | 100,00 % | 0,00 % | — |
| 2026-09-design-systems-notification-components | 25,00 % | 75,00 % | — |
| 2026-09-conversation-topic-header | 100,00 % | 0,00 % | — |
| 2026-09-collectibles-navigation-menu | 100,00 % | 0,00 % | — |
| 2026-09-bounties-android-quest-bar-smoke-animation | 100,00 % | 0,00 % | — |
| 2026-08-soundboard-desktop-nux | 100,00 % | 0,00 % | — |
| 2026-07-plan-select-ui-redesign | 100,00 % | 0,00 % | — |
| 2026-07-nitro-home-header-followup | 100,00 % | 0,00 % | — |
| 2026-07-clips-ntp-clock | 10,00 % | 90,00 % | — |
| 2026-06-remove-wishlist-dm-sidebar-side-copy | 25,00 % | 50,00 % | — |
| 2026-06-desktop-tti-splash-asset | 100,00 % | 0,00 % | — |
| 2026-06-bulk-nitro-gifting | 0,00 % | 0,00 % | — |
| 2026-05-slayer-storefront-hide-leaderboard | 100,00 % | 0,00 % | — |
| 2026-05-badge-discovery-milestone-2 | 15,00 % | 85,00 % | — |
| 2026-05_game_invites_channel | 0,00 % | 0,00 % | — |
| 2026-04-wetf-parser | 100,00 % | 0,00 % | — |
| 2026-04-unified-checkout-ui-premium-flows | 1,00 % | 98,00 % | — |
| 2026-04-desktop-tti-dnstcp-warmup | 100,00 % | 0,00 % | — |
| 2026-04-channel-pinning | 1,00 % | 98,00 % | — |
| 2026-04-boosting-pre-checkout-modal-refresh | 5,00 % | 90,00 % | — |
| 2026-04-badge-discovery | 15,00 % | 85,00 % | — |
| 2026-04_voice_invite_suggestion_placement | 50,00 % | 50,00 % | — |
| 2026-04_guild_voice_trigger_point | 50,00 % | 50,00 % | — |
| 2026-04_default_invite_expiration_guild_web | 0,00 % | 0,00 % | — |
| 2026-03-wishlisting-everywhere | 50,00 % | 0,00 % | — |
| 2026-03-slayer-gifting-mini-shelf-removal | 100,00 % | 0,00 % | — |
| 2026-03-shop-fiat-prioritization | 33,00 % | 34,00 % | — |
| 2026-03-runescape-game-servers | 100,00 % | 0,00 % | — |
| 2026-03-requiremodule-caching-redux | 100,00 % | 0,00 % | — |
| 2026-03-quest-share-embed-refactor | 50,00 % | 0,00 % | — |
| 2026-03-nitro-s-rewards-v2-test | 20,00 % | 70,00 % | — |
| 2026-03-new-gifting-entrypoints | 50,00 % | 0,00 % | — |
| 2026-03-link-before-adding-gdop-widget | 66,00 % | 1,00 % | — |
| 2026-03-kaomoji-picker | 20,00 % | 60,00 % | — |
| 2026-03-join-voice-context-menu | 50,00 % | 0,00 % | — |
| 2026-03-icymi-sunset-banner | 100,00 % | 0,00 % | — |
| 2026-03-gorilla | 100,00 % | 0,00 % | — |
| 2026-03-game-update-notification | 30,00 % | 40,00 % | — |
| 2026-03-game-profiles-mobile | 10,00 % | 80,00 % | — |
| 2026-03-game-profile-claim-game-cta | 50,00 % | 50,00 % | — |
| 2026-03-friend-request-wave | 50,00 % | 0,00 % | — |
| 2026-03-friend-is-online-v3 | 2,00 % | 97,00 % | — |
| 2026-03-calculated-annual-discount-percent | 25,00 % | 50,00 % | — |
| 2026-03-boosting-settings-refresh | 50,00 % | 0,00 % | — |
| 2026-03-arborium-highlight | 100,00 % | 0,00 % | — |
| 2026-03_spoiler_channel | 100,00 % | 0,00 % | — |
| 2026-02-video-quest-learn-more-cta | 10,00 % | 80,00 % | — |
| 2026-02-user-settings-redesign-4a | 100,00 % | 0,00 % | — |
| 2026-02-unified-checkout-ui-otp-group-1 | 50,00 % | 0,00 % | — |
| 2026-02-unified-checkout-ui-group-2 | 50,00 % | 0,00 % | — |
| 2026-02-sticker-padding | 100,00 % | 0,00 % | — |
| 2026-02-soundboard-xp-5 | 70,00 % | 0,00 % | — |
| 2026-02-silp-in-app-redesign | 40,50 % | 40,50 % | — |
| 2026-02-signal-unknown-credential | 100,00 % | 0,00 % | — |
| 2026-02-signal-current-user-details | 100,00 % | 0,00 % | — |
| 2026-02-signal-all-accepted-credentials | 100,00 % | 0,00 % | — |
| 2026-02-shop-card-personalization-negative-test | 40,00 % | 40,00 % | — |
| 2026-02-red-dot-navigate-to-mentions-web | 17,00 % | 69,00 % | — |
| 2026-02-reactions-click-to-profile | 100,00 % | 0,00 % | — |
| 2026-02-quest-card-description | 100,00 % | 0,00 % | — |
| 2026-02-past-due-guild-boost-cancellation | 50,00 % | 0,00 % | — |
| 2026-02-nitro-home-perk-cards | 50,00 % | 0,00 % | — |
| 2026-02-new-video-quest-progress-bar-styling | 2,50 % | 95,00 % | — |
| 2026-02-mute-tutorial | 100,00 % | 0,00 % | — |
| 2026-02-mobile-referral-program-xp-2 | 50,00 % | 0,00 % | — |
| 2026-02-gdm-all-reaction-notifications | 1,00 % | 98,00 % | — |
| 2026-02-game-account-linking-entry-point-recurring | 50,00 % | 0,00 % | — |
| 2026-02-first-booster-upsell | 25,00 % | 75,00 % | — |
| 2026-02-dm-error-message | 50,00 % | 0,00 % | — |
| 2026-02-client-heartbeat-skipped | 5,00 % | 90,00 % | — |
| 2026-02-channel-wave-button | 1,00 % | 98,00 % | — |
| 2026-02-boosting-sidebar-video | 50,00 % | 0,00 % | — |
| 2026-02-boosting-refresh-modals | 50,00 % | 0,00 % | — |
| 2026-02-boosting-marketing-page-video | 66,00 % | 1,00 % | — |
| 2026-02-boost-to-unlock-coachmark | 100,00 % | 0,00 % | — |
| 2026-02-boost-tab-expressive-cta | 50,00 % | 0,00 % | — |
| 2026-02-bf-browser | 1,00 % | 99,00 % | — |
| 2026-02-av1-decode-mac | 25,00 % | 50,00 % | — |
| 2026-02-adaptive-message-limit | 100,00 % | 0,00 % | — |
| 2026-02_voice_user_hover_activities | 100,00 % | 0,00 % | — |
| 2026-02_voice_invite_suggestion_activity | 100,00 % | 0,00 % | — |
| 2026-02_voice_channel_history_hover | 60,00 % | 30,00 % | — |
| 2026-02_standard_sidebar_popover_gaps | 0,00 % | 0,00 % | — |
| 2026-02_expand_voice_invite_suggestions | 0,00 % | 0,00 % | — |
| 2026-01-you-bar | 15,00 % | 80,00 % | — |
| 2026-01-wishlist-new-recommendations | 100,00 % | 0,00 % | — |
| 2026-01-video-quest-start-cta | 100,00 % | 0,00 % | — |
| 2026-01-valentines-day-drop | 98,00 % | 0,00 % | — |
| 2026-01-user-profile-settings-nitro-button-experiment | 25,00 % | 50,00 % | — |
| 2026-01-user-offer-notice-timing-xp | 84,00 % | 2,00 % | — |
| 2026-01-social-layer-storefront-xbox-support | 100,00 % | 0,00 % | — |
| 2026-01-social-layer-storefront-sku-purchase-eligibility-user-experiment | 51,00 % | 49,00 % | — |
| 2026-01-rename-ring-context-menu | 66,00 % | 1,00 % | — |
| 2026-01-rename-invite-button-cta | 50,00 % | 0,00 % | — |
| 2026-01-quest-bar-unfurl | 9,50 % | 87,00 % | — |
| 2026-01-profile-updates-notification | 5,00 % | 90,00 % | — |
| 2026-01-nvenc-new-presets | 30,00 % | 60,00 % | — |
| 2026-01-marketing-banner-cta-action | 50,00 % | 0,00 % | — |
| 2026-01-gdm-create-copy-update | 25,00 % | 50,00 % | — |
| 2026-01-game-blocklist | 0,00 % | 0,00 % | — |
| 2026-01-friend-is-online-notif-rate-limits | 8,50 % | 88,50 % | — |
| 2026-01-fast-connect-identify | 100,00 % | 0,00 % | — |
| 2026-01-contextless-frames-mobile | 100,00 % | 0,00 % | — |
| 2026-01-content-inventory-application-widget-preview | 100,00 % | 0,00 % | — |
| 2026-01-business-profile-linking | 100,00 % | 0,00 % | — |
| 2026-01-av-content-update | 100,00 % | 0,00 % | — |
| 2026-01_invite_app_launched_context | 50,00 % | 50,00 % | — |
| 2026-01_guild_tag_badge_packs_wave_2 | 100,00 % | 0,00 % | — |
| 2026-01_boost_progress_bar_default_on | 15,00 % | 15,00 % | — |
| 2025-12-video-stats-for-nerds | 100,00 % | 0,00 % | — |
| 2025-12-user-settings-redesign-3 | 100,00 % | 0,00 % | — |
| 2025-12-unified-checkout | 100,00 % | 0,00 % | — |
| 2025-12-social-layer-storefront-user-experiment | 100,00 % | 0,00 % | — |
| 2025-12-social-layer-storefront-recommendations | 100,00 % | 0,00 % | — |
| 2025-12-social-layer-storefront-activity-card-entrypoints-user-experiment | 100,00 % | 0,00 % | — |
| 2025-12-on-platform-account-linking-new-event | 100,00 % | 0,00 % | — |
| 2025-12-new-year-marketing-note | 100,00 % | 0,00 % | — |
| 2025-12-mobile-golive-tile-resolution | 10,00 % | 80,00 % | — |
| 2025-12-hide-guild-boost-status-tab | 100,00 % | 0,00 % | — |
| 2025-12-game-profiles-v2 | 50,00 % | 0,00 % | — |
| 2025-12-game-invite-account-linking-entry-point | 0,00 % | 0,00 % | — |
| 2025-12-earned-impression-api-call-experiment | 2,00 % | 98,00 % | — |
| 2025-12-desktop-json-gateway-encoding | 40,00 % | 20,00 % | — |
| 2025-12-collectibles-new-button-hover-update | 100,00 % | 0,00 % | — |
| 2025-12-boosting-marketing-page-refresh | 100,00 % | 0,00 % | — |
| 2025-12-active-timestamp-styling | 100,00 % | 0,00 % | — |
| 2025-12_winter_holiday | 100,00 % | 0,00 % | — |
| 2025-12_guild_permission_changes | 100,00 % | 0,00 % | — |
| 2025-12_direct_message_status_indicators | 100,00 % | 0,00 % | — |
| 2025-11-vibing-wumpus-v2 | 100,00 % | 0,00 % | — |
| 2025-11-user-profile-wishlist-orbs-bundles | 10,00 % | 80,00 % | — |
| 2025-11-rtc-panel-entry-point-new-copy | 100,00 % | 0,00 % | — |
| 2025-11-restart-on-excessive-memory-usage | 50,00 % | 0,00 % | — |
| 2025-11-quest-home-takeover-client-rollout | 100,00 % | 0,00 % | — |
| 2025-11-quest-home-suggested-sort-rotation | 100,00 % | 0,00 % | — |
| 2025-11-quest-bar-listen-for-source-error | 100,00 % | 0,00 % | — |
| 2025-11-nitro-resubscribe-modal-experiment | 100,00 % | 0,00 % | — |
| 2025-11-nitro-privacy-perk | 10,00 % | 80,00 % | — |
| 2025-11-nitro-badge-upsell | 10,00 % | 80,00 % | — |
| 2025-11-guild-activity-aggregate-carve-out | 100,00 % | 0,00 % | — |
| 2025-11-earned-impression-user-session-experiment | 25,00 % | 75,00 % | — |
| 2025-11-cache-regression | 50,00 % | 0,00 % | — |
| 2025-11-auto-open-tiv | 37,50 % | 50,00 % | — |
| 2025-11-affine-collectible-gifting | 100,00 % | 0,00 % | — |
| 2025-11_overlay_bug_reporter | 30,00 % | 70,00 % | — |
| 2025-10-windows-mute-detection | 100,00 % | 0,00 % | — |
| 2025-10-user-profile-game-widgets-early-access | 100,00 % | 0,00 % | — |
| 2025-10-timestamp-autocomplete | 100,00 % | 0,00 % | — |
| 2025-10-surface-unwatched-streams | 50,00 % | 0,00 % | — |
| 2025-10-soundboard-xp-3 | 5,00 % | 94,00 % | — |
| 2025-10-shop-collection-asset-migration | 100,00 % | 0,00 % | — |
| 2025-10-quest-home-entrypoint-onboarding | 10,00 % | 87,50 % | — |
| 2025-10-premium-brand-refresh-ga-backtest | 2,00 % | 0,00 % | — |
| 2025-10-orb-rental | 70,00 % | 1,00 % | — |
| 2025-10-list-profile-effects-sunset | 25,00 % | 50,00 % | — |
| 2025-10-layer-system-v2 | 10,00 % | 80,00 % | — |
| 2025-10-go-live-zoom-pan | 100,00 % | 0,00 % | — |
| 2025-10-gif-providers-multi-treatment | 30,00 % | 55,00 % | — |
| 2025-10-full-obscure-media | 100,00 % | 0,00 % | — |
| 2025-10-friendship-anniversary-gifting | 90,00 % | 0,00 % | — |
| 2025-10-fetch-promotions-endpoint | 100,00 % | 0,00 % | — |
| 2025-10-emoji-search-ranking-tweaks | 5,00 % | 90,00 % | — |
| 2025-10-desktop-video-quest-cta-relocation | 2,50 % | 96,50 % | — |
| 2025-10-collectibles-bundle-gifting | 100,00 % | 0,00 % | — |
| 2025-10-call-tile-popout | 50,00 % | 50,00 % | — |
| 2025-10-async-camera-init | 100,00 % | 0,00 % | — |
| 2025-10_word_frequency_store_rollout | 30,00 % | 40,00 % | — |
| 2025-10_voice_invite_suggestions | 94,00 % | 6,00 % | — |
| 2025-10_server_friends_in_vc_invites | 94,00 % | 6,00 % | — |
| 2025-10_recurring_3p_promotion | 10,30 % | 80,00 % | — |
| 2025-10_overlay_negative_widget_testing | 13,00 % | 84,00 % | — |
| 2025-10_overlay_default_keybind | 15,00 % | 80,00 % | — |
| 2025-10_halloween_holiday | 100,00 % | 0,00 % | — |
| 2025-10_friend_is_online_notification | 5,00 % | 95,00 % | — |
| 2025-10_client_meaningfully_online_timer_rollout | 100,00 % | 0,00 % | — |
| 2025-09-wishlist-in-dm-gifting-flow | 100,00 % | 0,00 % | — |
| 2025-01_guild_settings_foundation | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2024-11_member_verification_rollout | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2024-09_league_of_legends_leaderboard | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2024-07_rapidash_m3_guilds | 0,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2024-04_hang_status_v2 | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2024-04_audio_short_circuit_guild | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2024-01_nvencadaptivekeyframe | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-08_guild_alert_mode_friend_server | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-08_deadchat_simple_prompt_guild | 0,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-07_server_guide_trigger | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-07_clyde_ai_proactive_guilds | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-07_allow_welcome_message_replies | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-06_remove_reactions_by_type | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-06_clyde_ai_channel_based_personality | 50,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-05_optional_onboarding_home_admin | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-05_clyde_ai_guild_personality | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-04_server_products | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-04_growing_friend_guild_community_upsell | 0,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-04_fast_new_channels | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-03_server_subscriptions_tier_templates | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-03_onboarding_soft_requirement_for_partnership | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-03_home_deprecation | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-03_guild_media_channel | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-02_onboardingdropdowns | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-02_onboarding_home_admin | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2023-02_onboarding_advanced_mode | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2023-02_burst_reaction_guild_experiment | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2022-11_default_to_server_vanity_v2 | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2022-11_creator_monetization_onboarding_waitlist | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2022-10_text_in_stage | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2022-07_report_raids | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2022-07_invites_disabled | 100,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |
| 2022-01_guild_role_subscription_trials | 100,00 % (projeté) | — | ℹ projeté (multi-populations), overlapping_variants |
| 2021-06_guild_role_subscriptions | 72,00 % (projeté) | — | ℹ projeté (multi-populations), repeated_variant, overlapping_variants |

## Détail par variante (user)

### 2026-10-web-streaming-optimizations
- Variant 0 (control) : 4,00 % · plages 0 – 400
- Variant 1 (treatment) : 4,00 % · plages 400 – 800
- Variant 2 (treatment) : 4,00 % · plages 800 – 1200
- Variant 3 (treatment) : 4,00 % · plages 1200 – 1600
- Variant 4 (treatment) : 4,00 % · plages 1600 – 2000

### 2026-10-soundboard-mute-indicator
- Variant 0 (control) : 1,00 % · plages 0 – 100
- Variant 1 (treatment) : 1,00 % · plages 100 – 200

### 2026-10-remove-quests-from-discovery
- Variant 0 (control) : 50,00 % · plages 0 – 100 , 200 – 1600 , 3000 – 4000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 100 – 200 , 1600 – 3000 , 4000 – 5000 , 7500 – 10000

### 2026-10-purchase-history
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-10-profile-default-tab-with-content
- Variant 0 (control) : 30,00 % · plages 0 – 1500 , 3000 – 4000 , 5000 – 5500
- Variant 1 (treatment) : 30,00 % · plages 1500 – 3000 , 4000 – 5000 , 5500 – 6000

### 2026-10-pinot-member
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-10-nitro-tab-remove-account-age-restriction
- Variant 0 (control) : 50,00 % · plages 0 – 1250 , 2500 – 3750 , 5000 – 6500 , 8000 – 9000
- Variant 1 (treatment) : 50,00 % · plages 1250 – 2500 , 3750 – 5000 , 6500 – 8000 , 9000 – 10000

### 2026-10-macaron-non-sub-marketing
- Variant 0 (control) : 9,50 % · plages 0 – 50 , 500 – 600 , 1500 – 1650 , 3000 – 3200 , 5000 – 5250 , 7500 – 7700
- Variant 1 (treatment) : 90,50 % · plages 50 – 500 , 600 – 1500 , 1650 – 3000 , 3200 – 5000 , 5250 – 7500 , 7700 – 10000

### 2026-10-macaron
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-10-guild-tooltip-lazy-content
- Variant 0 (control) : 50,00 % · plages 0 – 5000
- Variant 1 (treatment) : 50,00 % · plages 5000 – 10000

### 2026-10-gdm-duration-timer
- Variant 0 (control) : 3,50 % · plages 1000 – 1100 , 1450 – 1500 , 2600 – 2650 , 4500 – 4525 , 5550 – 5600 , 6800 – 6825 , 7750 – 7800
- Variant 1 (treatment) : 8,50 % · plages 2850 – 2900 , 4525 – 4550 , 5850 – 6250 , 6825 – 7000 , 8350 – 8400 , 9550 – 9700

### 2026-10-game-exit-promo-rust
- Variant 0 (control) : 50,00 % · plages 0 – 1500 , 3000 – 4000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 1500 – 3000 , 4000 – 5000 , 7500 – 10000

### 2026-10-fix-soundboard-muting-iconography
- Variant 0 (control) : 1,00 % · plages 0 – 100
- Variant 1 (treatment) : 1,00 % · plages 100 – 200

### 2026-10-desktop-tti-perf
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000

### 2026-10-desktop-general-perf
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000

### 2026-10-desktop-game-perf
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000

### 2026-10-collectibles-interactive-jumble-bar
- Variant 0 (control) : 15,00 % · plages 0 – 1500
- Variant 1 (treatment) : 15,00 % · plages 1500 – 3000

### 2026-10-code-blurple-marketing-holdout
- Variant 0 (control) : 5,00 % · plages 0 – 150 , 3000 – 3100 , 5000 – 5125 , 7500 – 7625
- Variant 1 (treatment) : 95,00 % · plages 150 – 3000 , 3100 – 5000 , 5125 – 7500 , 7625 – 10000

### 2026-10-code-blurple
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-10-cod-relink
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-10-clickable-hero-banner
- Variant 0 (control) : 5,00 % · plages 0 – 250 , 500 – 750
- Variant 1 (treatment) : 5,00 % · plages 250 – 500 , 750 – 1000

### 2026-10-badge-directory-updates
- Variant 0 (control) : 15,00 % · plages 0 – 450 , 3000 – 3300 , 5000 – 5750
- Variant 1 (treatment) : 85,00 % · plages 450 – 3000 , 3300 – 5000 , 5750 – 10000

### 2026-10-avx512-entropy-histogram
- Variant 0 (control) : 15,00 % · plages 0 – 500 , 1000 – 2000
- Variant 1 (treatment) : 15,00 % · plages 500 – 1000 , 2000 – 3000

### 2026-09-youtube-3p-nagbar
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-youtube-3p
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-try-display-name-style
- Variant 0 (control) : 13,33 % · plages 0 – 100 , 300 – 1200 , 3000 – 3333
- Variant 1 (treatment) : 13,33 % · plages 100 – 200 , 1200 – 2100 , 3333 – 3666
- Variant 2 (treatment) : 13,33 % · plages 200 – 300 , 2100 – 3000 , 3666 – 3999

### 2026-09-three-month-nitro-gifting
- Variant 0 (control) : 20,00 % · plages 0 – 2000
- Variant 1 (treatment) : 20,00 % · plages 5000 – 7000

### 2026-09-stream-zero-vad-leading
- Variant 0 (control) : 10,00 % · plages 0 – 200 , 400 – 1200
- Variant 1 (treatment) : 10,00 % · plages 200 – 400 , 1200 – 2000

### 2026-09-soundboard-quick-action
- Variant 1 (treatment) : 95,00 % · plages 0 – 9500

### 2026-09-silp-direct-to-discoverable
- Variant 0 (control) : 3,00 % · plages 0 – 300

### 2026-09-silp-cta-copy-tests
- Variant 0 (control) : 4,00 % · plages 0 – 400

### 2026-09-request-to-stream-go-live-modal
- Variant 0 (control) : 50,00 % · plages 0 – 100 , 200 – 1100 , 2000 – 3500 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 100 – 200 , 1100 – 2000 , 3500 – 5000 , 7500 – 10000

### 2026-09-referral-trial-cta
- Variant 0 (control) : 50,00 % · plages 0 – 500 , 1000 – 3000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 500 – 1000 , 3000 – 5000 , 7500 – 10000

### 2026-09-quest-mobile-bar-secondary-cta
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-profile-widget-empty-state-suggestions
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000
- Variant 2 (treatment) : 5,00 % · plages 1000 – 1500

### 2026-09-profile-link-fetch
- Variant 0 (control) : 50,00 % · plages 0 – 5000
- Variant 1 (treatment) : 50,00 % · plages 5000 – 10000

### 2026-09-orbs-hero-carousel
- Variant 0 (control) : 50,00 % · plages 0 – 500 , 1000 – 1750 , 2500 – 3750 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 500 – 1000 , 1750 – 2500 , 3750 – 5000 , 7500 – 10000

### 2026-09-non-nitro-file-upload-marketing
- Variant 1 (treatment) : 76,50 % · plages 100 – 500 , 1250 – 2000 , 3500 – 10000

### 2026-09-nitro-file-upload-rollout
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-new-orb-reward-visuals
- Variant 1 (treatment) : 49,50 % · plages 550 – 1000 , 2500 – 7000

### 2026-09-new-horizontal-scroll-shared
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-nameplate-video-preload-none
- Variant 0 (control) : 50,00 % · plages 0 – 50 , 100 – 550 , 1000 – 1500 , 2000 – 3500 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 50 – 100 , 550 – 1000 , 1500 – 2000 , 3500 – 5000 , 7500 – 10000

### 2026-09-multi-sku-embed-rendering
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-mobile-sticker-picker-upsell-restyle
- Variant 0 (control) : 50,00 % · plages 0 – 500 , 1000 – 3000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 500 – 1000 , 3000 – 5000 , 7500 – 10000

### 2026-09-mobile-quest-home-sort-priority
- Variant 0 (control) : 10,00 % · plages 0 – 250 , 500 – 1250
- Variant 1 (treatment) : 10,00 % · plages 250 – 500 , 1250 – 2000

### 2026-09-manual-review-inconclusive-copy
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-invite-silp-education
- Variant 0 (control) : 2,50 % · plages 0 – 250

### 2026-09-invite-accept-age-group-errors
- Variant 1 (treatment) : 5,00 % · plages 0 – 500

### 2026-09-halloween-holiday
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-gifting-badge-coachmark-audience
- Variant 0 (control) : 25,00 % · plages 0 – 100 , 200 – 600 , 1000 – 2000 , 3000 – 4000
- Variant 1 (treatment) : 25,00 % · plages 100 – 200 , 600 – 1000 , 2000 – 3000 , 4000 – 5000

### 2026-09-game-profiles-v3-communities-tab
- Variant 0 (control) : 50,00 % · plages 0 – 100 , 200 – 1100 , 2000 – 3500 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 100 – 200 , 1100 – 2000 , 3500 – 5000 , 7500 – 10000

### 2026-09-game-profiles-v3-commerce-tab
- Variant 0 (control) : 50,00 % · plages 0 – 100 , 200 – 1600 , 3000 – 4000 , 5000 – 6250 , 7500 – 8750
- Variant 1 (treatment) : 50,00 % · plages 100 – 200 , 1600 – 3000 , 4000 – 5000 , 6250 – 7500 , 8750 – 10000

### 2026-09-friends-sidebar
- Variant 0 (control) : 5,00 % · plages 0 – 33 , 99 – 566
- Variant 1 (treatment) : 5,00 % · plages 33 – 66 , 566 – 1033
- Variant 2 (treatment) : 5,00 % · plages 66 – 99 , 1033 – 1500

### 2026-09-edit-profile-collectibles-ordering
- Variant 0 (control) : 2,50 % · plages 0 – 250
- Variant 1 (treatment) : 2,50 % · plages 250 – 500

### 2026-09-clips-editor-image-track
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-09-application-test-mode-quick-access
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-vq-remaining-time-truncation
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-user-bio-max-length
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-top-soundboard-sounds-mobile
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-top-soundboard-sounds
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-tiny-bronco
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-timestamp-autocomplete-mobile
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-show-expressive-modal-subtitle-alt
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-scheduled-messages
- Variant 0 (control) : 10,00 % · plages 0 – 1000
- Variant 1 (treatment) : 10,00 % · plages 1000 – 2000
- Variant 2 (treatment) : 10,00 % · plages 2000 – 3000

### 2026-08-profile-embed-share-button
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-profile-embed-rendering
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-no-fill-logging
- Variant 1 (treatment) : 25,00 % · plages 5000 – 7500
- Variant 2 (treatment) : 75,00 % · plages 0 – 5000 , 7500 – 10000

### 2026-08-nitro-tenure-badge-total-progress
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-mobile-emoji-picker-upsell-restyle
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-guilds-bar-media-state-store
- Variant 0 (control) : 10,00 % · plages 0 – 1000
- Variant 1 (treatment) : 10,00 % · plages 1000 – 2000

### 2026-08-gift-recipient-display-name-search
- Variant 1 (treatment) : 25,00 % · plages 250 – 500 , 3250 – 5500
- Variant 2 (treatment) : 25,00 % · plages 500 – 750 , 5500 – 7750
- Variant 3 (treatment) : 25,00 % · plages 750 – 1000 , 7750 – 10000

### 2026-08-game-profiles-vc
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-game-community-add-server-entry
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-dont-close-chat
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-08-dcf-new-user-cooldown
- Variant 0 (control) : 25,00 % · plages 0 – 500 , 2000 – 3000 , 6000 – 7000
- Variant 1 (treatment) : 25,00 % · plages 500 – 1000 , 3000 – 4000 , 7000 – 8000
- Variant 2 (treatment) : 25,00 % · plages 1000 – 1500 , 4000 – 5000 , 8000 – 9000
- Variant 3 (treatment) : 25,00 % · plages 1500 – 2000 , 5000 – 6000 , 9000 – 10000

### 2026-08-compress-logs
- Variant 0 (control) : 50,00 % · plages 0 – 5000
- Variant 1 (treatment) : 50,00 % · plages 5000 – 10000

### 2026-08-badge-management
- Variant 1 (treatment) : 7,50 % · plages 7500 – 8000 , 9200 – 9400 , 9850 – 9900
- Variant 2 (treatment) : 92,50 % · plages 0 – 7500 , 8000 – 9200 , 9400 – 9850 , 9900 – 10000

### 2026-08-ad-topic-opt-out-client
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-you-bar-guild-tag
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-wishlist-direct-to-gifting
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-unobtrusive-device-suggestions
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-typing-users-css-dots
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-smag-mobile-wishlist-suggestions
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-shop-this-look-mobile
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-orbchievements
- Variant 0 (control) : 30,00 % · plages 0 – 100 , 200 – 300 , 400 – 500 , 600 – 700 , 800 – 900 , 1000 – 1100 , 1200 – 1300 , 1400 – 1500 , 1600 – 1700 , 1800 – 1900 , 2000 – 2500 , 3000 – 3500 , 4000 – 4500 , 5000 – 5500
- Variant 1 (treatment) : 30,00 % · plages 100 – 200 , 300 – 400 , 500 – 600 , 700 – 800 , 900 – 1000 , 1100 – 1200 , 1300 – 1400 , 1500 – 1600 , 1700 – 1800 , 1900 – 2000 , 2500 – 3000 , 3500 – 4000 , 4500 – 5000 , 5500 – 6000

### 2026-07-nvenc-reconstructed-frames
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-mobile-emoji-suggestions
- Variant 0 (control) : 1,00 % · plages 0 – 100
- Variant 1 (treatment) : 1,00 % · plages 100 – 200
- Variant 2 (treatment) : 1,00 % · plages 200 – 300
- Variant 3 (treatment) : 1,00 % · plages 300 – 400

### 2026-07-mobile-boosting-optimizations
- Variant 4 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-krisp-cpu-disablement
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-expressive-modal-v2
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-07-custom-typing-indicator
- Variant 1 (treatment) : 10,00 % · plages 100 – 200 , 400 – 500 , 900 – 1200 , 2000 – 2500
- Variant 2 (treatment) : 10,00 % · plages 200 – 300 , 500 – 600 , 1200 – 1500 , 2500 – 3000
- Variant 3 (treatment) : 70,00 % · plages 3000 – 10000

### 2026-06-web-translate-dom-guard
- Variant 0 (control) : 1,00 % · plages 0 – 100

### 2026-06-upscale-small-captured-frames
- Variant 0 (control) : 0,50 % · plages 0 – 50
- Variant 1 (treatment) : 0,50 % · plages 100 – 150

### 2026-06-nitro-gdm-cap-increase
- Variant 1 (treatment) : 1,00 % · plages 0 – 100

### 2026-06-mobile-server-tag
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-06-mobile-media-viewer-share
- Variant 0 (control) : 10,00 % · plages 0 – 500 , 1000 – 1500
- Variant 1 (treatment) : 10,00 % · plages 500 – 1000 , 1500 – 2000

### 2026-06-improved-shop-loading
- Variant 0 (control) : 10,00 % · plages 0 – 50 , 100 – 300 , 500 – 750 , 1000 – 1500
- Variant 1 (treatment) : 10,00 % · plages 50 – 100 , 300 – 500 , 750 – 1000 , 1500 – 2000

### 2026-06-gummy-bears
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-06-gifting-badge-desktop
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-06-gift-acom-order
- Variant 0 (control) : 25,00 % · plages 0 – 100 , 200 – 1100 , 2000 – 3500
- Variant 1 (treatment) : 25,00 % · plages 100 – 200 , 1100 – 2000 , 3500 – 5000

### 2026-06-dont-badge-muted-vcs
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-05-use-ad-analytics-interface
- Variant 5 (treatment) : 100,00 % · plages 0 – 10000

### 2026-05-mana-type-consolidation
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-05-dvp-for-attachments
- Variant 1 (treatment) : 10,00 % · plages 100 – 200 , 350 – 500 , 750 – 1000 , 1500 – 2000

### 2026-05-disable-camera-simulcast
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-04-safety-flows
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-04-one-day-fractional-nitro
- Variant 0 (control) : 50,00 % · plages 0 – 50 , 100 – 300 , 500 – 750 , 1000 – 2000 , 3000 – 4000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 50 – 100 , 300 – 500 , 750 – 1000 , 2000 – 3000 , 4000 – 5000 , 7500 – 10000

### 2026-04-declarative-notif-settings
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-04-collectibles-profile-frames-purchase
- Variant 1 (treatment) : 15,00 % · plages 100 – 1000 , 1700 – 1800 , 2500 – 3000

### 2026-04-browser-transceiver-padding-removal
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-03-nitro-acom-subscription
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-03-new-server-boost-system-messages
- Variant 0 (control) : 5,00 % · plages 0 – 100 , 300 – 700
- Variant 1 (treatment) : 5,00 % · plages 100 – 200 , 700 – 1100
- Variant 2 (treatment) : 5,00 % · plages 200 – 300 , 1100 – 1500

### 2026-03-message-bookmarks
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000
- Variant 2 (treatment) : 5,00 % · plages 1000 – 1500

### 2026-03-media-play-metrics
- Variant 0 (control) : 90,00 % · plages 0 – 9000
- Variant 1 (treatment) : 10,00 % · plages 9000 – 10000

### 2026-03-l-3pp
- Variant 0 (control) : 10,00 % · plages 0 – 100 , 200 – 400 , 600 – 1300
- Variant 1 (treatment) : 10,00 % · plages 100 – 200 , 400 – 600 , 1300 – 2000

### 2026-03-image-load-metrics
- Variant 0 (control) : 90,00 % · plages 0 – 9000
- Variant 2 (treatment) : 10,00 % · plages 9000 – 10000

### 2026-03-friend-request-message
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-03-denormalized-perks-access-read
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2026-02-voice-channel-link-click
- Variant 1 (treatment) : 30,00 % · plages 0 – 3000

### 2026-02-silence-warning-aggression
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-02-referral-reminder-dc
- Variant 1 (treatment) : 0,40 % · plages 3600 – 3640

### 2026-02-process-boost-on-voice
- Variant 0 (control) : 10,00 % · plages 0 – 200 , 400 – 700 , 1000 – 1500
- Variant 1 (treatment) : 10,00 % · plages 200 – 400 , 700 – 1000 , 1500 – 2000

### 2026-02-private-channel-hiding
- Variant 3 (treatment) : 2,00 % · plages 0 – 200

### 2026-02-lazy-load-all-images
- Variant 0 (control) : 30,00 % · plages 0 – 100 , 200 – 600 , 1000 – 1500 , 2000 – 3000 , 4000 – 5000
- Variant 1 (treatment) : 30,00 % · plages 100 – 200 , 600 – 1000 , 1500 – 2000 , 3000 – 4000 , 5000 – 6000

### 2026-02-join-game-community-cta
- Variant 0 (control) : 10,00 % · plages 0 – 1000
- Variant 1 (treatment) : 10,00 % · plages 1000 – 2000

### 2026-02-gsh-game-detection-upsell
- Variant 0 (control) : 10,00 % · plages 0 – 250 , 500 – 750 , 1000 – 1500
- Variant 1 (treatment) : 10,00 % · plages 250 – 500 , 750 – 1000 , 1500 – 2000

### 2026-02-go-live-video-preset-resolution
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-02-gifting-modal-redesign
- Variant 0 (control) : 50,00 % · plages 0 – 100 , 200 – 600 , 1000 – 3000 , 5000 – 7500
- Variant 1 (treatment) : 50,00 % · plages 100 – 200 , 600 – 1000 , 3000 – 5000 , 7500 – 10000

### 2026-02-gift-cards
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2026-02-game-server-tab-always-on
- Variant 0 (control) : 20,00 % · plages 0 – 100 , 200 – 300 , 400 – 600 , 800 – 1400 , 2000 – 3000
- Variant 1 (treatment) : 20,00 % · plages 100 – 200 , 300 – 400 , 600 – 800 , 1400 – 2000 , 3000 – 4000

### 2026-02-expiring-powerup-coachmark
- Variant 0 (control) : 20,00 % · plages 0 – 100 , 200 – 300 , 400 – 600 , 800 – 1200 , 1600 – 2800
- Variant 1 (treatment) : 20,00 % · plages 100 – 200 , 300 – 400 , 600 – 800 , 1200 – 1600 , 2800 – 4000

### 2026-02-capture-target-window
- Variant 0 (control) : 20,00 % · plages 0 – 100 , 200 – 350 , 500 – 750 , 1000 – 1500 , 2000 – 3000
- Variant 1 (treatment) : 20,00 % · plages 100 – 200 , 350 – 500 , 750 – 1000 , 1500 – 2000 , 3000 – 4000

### 2026-02-activity-privacy-matching
- Variant 0 (control) : 21,00 % · plages 0 – 700 , 1000 – 1700 , 2000 – 2700

### 2026-01-less-personalized-ads
- Variant 1 (treatment) : 10,00 % · plages 0 – 1000

### 2026-01-favorites-server
- Variant 0 (control) : 10,00 % · plages 0 – 100 , 200 – 400 , 600 – 800 , 1000 – 1500
- Variant 2 (treatment) : 10,00 % · plages 100 – 200 , 400 – 600 , 800 – 1000 , 1500 – 2000

### 2025-12-wmf-gpu-encode
- Variant 0 (control) : 10,00 % · plages 0 – 500 , 1000 – 1500
- Variant 1 (treatment) : 10,00 % · plages 500 – 1000 , 1500 – 2000

### 2025-12-quest-cta-refactor-rollout
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2025-12-nitro-s-rewards
- Variant 0 (control) : 10,00 % · plages 0 – 33 , 99 – 132 , 198 – 232 , 300 – 500 , 900 – 1095 , 1485 – 1690 , 2100 – 2400
- Variant 1 (treatment) : 10,00 % · plages 33 – 66 , 132 – 165 , 232 – 266 , 500 – 700 , 1095 – 1290 , 1690 – 1895 , 2400 – 2700
- Variant 2 (treatment) : 10,00 % · plages 66 – 99 , 165 – 198 , 266 – 300 , 700 – 900 , 1290 – 1485 , 1895 – 2100 , 2700 – 3000

### 2025-12-mana-multistep-community-enabled
- Variant 0 (control) : 5,00 % · plages 0 – 500
- Variant 1 (treatment) : 5,00 % · plages 500 – 1000

### 2025-12-09-ptt-education
- Variant 2 (treatment) : 100,00 % · plages 0 – 10000

### 2025-11-overlay-chat
- Variant 0 (control) : 33,00 % · plages 0 – 3300
- Variant 1 (treatment) : 33,00 % · plages 3300 – 6600
- Variant 2 (treatment) : 33,00 % · plages 6600 – 9900

### 2025-11-hide-manual-link
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2025-11-global-frame-pool-lock
- Variant 0 (control) : 10,00 % · plages 0 – 1000
- Variant 1 (treatment) : 10,00 % · plages 1000 – 2000

### Tida Webform
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2025-10-friend-request-alerts-v2
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### 2025-09-video-qoe-metrics-tracking
- Variant 0 (control) : 1,00 % · plages 0 – 50 , 100 – 150
- Variant 1 (treatment) : 1,00 % · plages 50 – 100 , 150 – 200

### Safety Experience IAR User Reporting
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### Safety Experience Unauthenticated Report Form
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000

### Inferno Spam Redaction
- Variant 1 (treatment) : 100,00 % · plages 0 – 10000
