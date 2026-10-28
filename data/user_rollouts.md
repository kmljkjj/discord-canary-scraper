# Rollouts user — mesure propre (v14)

> Mis à jour automatiquement toutes les 20 min · Source : API Discord uniquement · Généré le 2026-10-28 03:23 UTC

**Fenêtre glissante 4 h — n = 7285 échantillons — 7 tokens actifs**

**Méthode** : k/n (binomial, non biaisé) + intervalle de confiance de Wilson. Population mesurée : échantillons anonymes multi-contextes (web, desktop, Android, iOS) — pas un recensement des utilisateurs Discord.

Les plages « reconstruites » sont une seconde mesure INDICATIVE (ordre-statistiques, dépendante du modèle) : un heuristique de séparation peut fragmenter une plage uniforme → à lire comme un ordre de grandeur, pas une certitude.

## Expériences mesurées (5)

| Expérience | % mesuré | IC 95 % | k/n | Confiance | Statut |
|---|---:|---|---:|---|---|
| hash:704914099 | **5,18 %** | [4,68 – 5,72] | 377/7285 | élevée | Mesuré |
| hash:1144304849 | **5,09 %** | [4,6 – 5,63] | 371/7285 | élevée | Mesuré |
| Safety Experience IAR User Reporting | **100 %** | [99,95 – 100] | 7285/7285 | élevée | Mesuré |
| hash:3013881204 | **100 %** | [99,95 – 100] | 7285/7285 | élevée | Mesuré |
| Tida Webform | **94,76 %** | [94,21 – 95,25] | 6903/7285 | élevée | Mesuré |

## Détail par variante

### hash:704914099
- Variant 1 : 5,18 % (IC 95 % [4,68 ; 5,72], 377/7285, confiance élevée)
  - plages reconstruites (indicatif, ordre de grandeur) : [9506.43, 9998.57] → 4,92 %

### hash:1144304849
- Variant 1 : 5,09 % (IC 95 % [4,6 ; 5,63], 371/7285, confiance élevée)
  - plages reconstruites (indicatif, ordre de grandeur) : [0, 502.84] → 5,03 %

### Safety Experience IAR User Reporting
- Variant 1 : 100 % (IC 95 % [99,95 ; 100], 7285/7285, confiance élevée)
  - plages reconstruites (indicatif, ordre de grandeur) : [160.23, 8229.77] + [8553.54, 9910.46] → 94,26 %

### hash:3013881204
- Variant 11 : 100 % (IC 95 % [99,95 ; 100], 7285/7285, confiance élevée)
  - plages reconstruites (indicatif, ordre de grandeur) : [0, 9865.52] → 98,66 %

### Tida Webform
- Variant 1 : 94,76 % (IC 95 % [94,21 ; 95,25], 6903/7285, confiance élevée)
  - plages reconstruites (indicatif, ordre de grandeur) : [0, 9862.19] → 98,62 %

## Guild — % exacts (API Discord, toutes les 20 min) — 5

| Expérience | % | Statut |
|---|---:|---|
| Voice in Threads | 100 % | Rollout complet |
| Disable mass mentions for communities by default | 100 % | Rollout complet |
| hash_1318029053 | 100 % | Rollout complet |
| Guest Voice Invites | 0 % | Pas commencé |
| hash_3633668656 | 100 % | Rollout complet |

## En attente de rollout — 348 expériences user

Discord ne publie pas encore leur pourcentage. Dès qu'un rollout démarre, l'expérience monte dans la section mesurées avec son % réel (2 décimales).

- Display QS scores in results. Not a real experiment
- Runtime Accessibility System
- Inferno Spam Redaction
- Allow logged out users
- Safety Experience Unauthenticated Report Form
- RTC Pacer & Golive Simulcast
- 2025-04-desktop-refresh-fast-follows
- 2025-04-native-markdown
- 2025-05-search-results-feedback
- Native Intents
- 2025-08-browser-hevc
- 2025-08-voice-user-affinity
- Next iteration of the activity feed ranking model.
- 2025-09-image-attachment-mezzanine-v2
- 2025-09-overlay-state-tracking
- 2025-09-sensitive-content-self-harm
- 2025-09-server-nsfw-level
- 2025-09-video-qoe-metrics-tracking
- 2025-10-collectibles-custom-cursors
- 2025-10-desktop-communication-notifications-emoji
- 2025-10-force-sdr-emojis-stickers
- 2025-10-go-live-auto-quality
- 2025-10-low-latency-rate-control
- Calendar
- 2025-11-age-verification-expressive-everywhere
- 2025-11-global-frame-pool-lock
- 2025-11-mana-context-menu
- 2025-11-overlay-chat
- 2025-11-shockbyte-degraded
- 2025-11-video-end-card-v2
- 2025-12-hdr-accessibility-setting
- 2025-12-katsudon
- 2025-12-mana-multistep-community-enabled
- 2025-12-orb-redemption-thru-orders
- 2025-12-proportional-vad-indicator
- 2025-12-quest-cta-refactor-rollout
- 2025-12-windows-audio-effects
- 2025-12-wmf-gpu-encode
- 2026-01-bug-reporter
- 2026-01-friends-in-server
- 2026-01-ios-push-notif-json-fix
- 2026-01-less-personalized-ads
- 2026-01-voice-dares-v0
- 2026-01-wmf-gpu-encode-intel
- 2026-02-announcement-composer
- 2026-02-capture-target-window
- 2026-02-desktop-new-user-onboarding
- 2026-02-expiring-powerup-coachmark
- 2026-02-friends-list
- 2026-02-game-server-tab-always-on
- 2026-02-gift-cards
- 2026-02-gifting-modal-redesign
- 2026-02-go-live-hdr
- 2026-02-gsh-game-detection-upsell
- 2026-02-join-game-community-cta
- 2026-02-lazy-load-all-images
- 2026-02-longer-group-dm-invites
- 2026-02-mana-playground-access
- 2026-02-mobile-volume-output-slider-removal
- 2026-02-non-dm-gifting-modal-redesign
- 2026-02-premium-offer-reminder-xp
- 2026-02-private-channel-hiding
- 2026-02-process-boost-on-voice
- 2026-02-voice-channel-link-click
- 2026-02-wgc-dirty-regions-all
- 2026-03-age-verification-google-wallet
- 2026-03-audio-effects-probe
- 2026-03-block-purchases
- 2026-03-churro
- 2026-03-clips-experiment
- 2026-03-content-inventory-memberlist-and-ranker
- 2026-03-conversation-highlighting-utility
- 2026-03-croissant
- 2026-03-debug-experiment
- 2026-03-denormalized-perks-access-read
- 2026-03-friend-request-message
- 2026-03-icymi-desktop
- 2026-03-icymi-staff-debugging-utility
- 2026-03-image-load-metrics
- 2026-03-ios-audio-interrupt-handling
- 2026-03-krisp-stats-collection
- 2026-03-l-3pp
- 2026-03-media-play-metrics
- 2026-03-mobile-hermes-occupancy-target
- 2026-03-muted-video-quest-new-defaults
- 2026-03-new-server-boost-system-messages
- 2026-03-overlay-default-keybind
- 2026-03-soundmoji-rendering
- 2026-03-soundmoji-sending
- 2026-03-steelseries-3p-recurring
- 2026-03-surface-direct-renderer
- 2026-03-video-capture-device-no-reuse
- 2026-03-wysiwyg-user-profile-editing
- 2026-04-clips-v3-runtime
- 2026-04-composed-quest-player
- 2026-04-desktop-notification-center
- 2026-04-desktop-tti-v8-cache
- 2026-04-ensure-received-messages-added-in-order
- 2026-04-gift-promotion-reminder
- 2026-04-gifting-badge
- 2026-04-hide-view-full-profile-button
- 2026-04-http-request-sample
- 2026-04-icymi-staff-only
- 2026-04-inappropriate-conversations-default-on
- 2026-04-inappropriate-conversations-prescan
- 2026-04-one-day-fractional-nitro
- 2026-04-overlay-streamer-mode
- 2026-04-quests-premium-orb-multiplier-marketing
- 2026-04-safety-flows
- 2026-04-server-boost-copy-1440p
- 2026-04-topical-navigation-staff-control
- 2026-04-upcoming-server-event
- 2026-04-user-profile-performance-analytics
- 2026-04-video-hook-dx12
- 2026-04-voice-gateway-protocol-version
- 2026-05-app-store-overlay-feature-gate
- 2026-05-auto-clips-review
- 2026-05-av1-bitrate-tuning
- 2026-05-bounty-stale-refresh-quest-home
- 2026-05-clips-media-comments
- 2026-05-device-form-factor-indicators
- 2026-05-dice-roll-slash-command
- 2026-05-distributed-clips
- 2026-05-dvp-for-attachments
- 2026-05-electron-multilang-spellcheck
- 2026-05-global-soundboard-wheel-popout
- 2026-05-ios-video-stabilization
- 2026-05-mana-type-consolidation
- 2026-05-quest-home-tile-redesign
- 2026-05-screenshare-picker-wgc
- 2026-05-server-theme-user
- 2026-05-spatial-audio-for-voice
- 2026-06-age-verification-incode
- 2026-06-av1-encode-linux
- 2026-06-chat-bar-customization
- 2026-06-clickstream-analytics
- 2026-06-clips-league-events
- 2026-06-clips-secondary-entrypoints
- 2026-06-content-classification-embedded-activity-filter
- 2026-06-desktop-tti-http-cdt
- 2026-06-game-server-hosting-in-shop
- 2026-06-gifting-badge-desktop
- 2026-06-gummy-bears
- 2026-06-hero-shelf-ad-tile
- 2026-06-improved-shop-loading
- 2026-06-nitro-gdm-cap-increase
- 2026-06-orbs-holdout
- 2026-06-otp-orders-phase-1
- 2026-06-post-call-survey-assets
- 2026-06-quest-fetch-reconnect-jitter
- 2026-06-quest-home-layout-visual-tweaks
- 2026-06-server-ladder
- 2026-06-systemwide-echo-cancellation-for-people-who-refuse-to-wear-headphones
- 2026-06-upscale-small-captured-frames
- 2026-06-use-new-badge-image-source
- 2026-06-user-profile-sidebar-redesign
- 2026-06-web-translate-dom-guard
- 2026-06-web-vitals-monitoring
- 2026-06-wmf-cpu-encode-intel
- 2026-07-attachment-image-ladder
- 2026-07-autoclipping-marketing
- 2026-07-call-of-duty-3pp-expired
- 2026-07-clips-game-events-on-player
- 2026-07-clips-on-profile-setter
- 2026-07-clips-on-profile-viewer
- 2026-07-cobalt
- 2026-07-custom-app-store-overlay
- 2026-07-desktop-channel-tabs
- 2026-07-expressive-modal-v2
- 2026-07-gsimagic
- 2026-07-ios-attribution
- 2026-07-manual-age-assurance-fallback
- 2026-07-nvenc-reconstructed-frames
- 2026-07-onyx
- 2026-07-orbchievements
- 2026-07-parental-consent-warning-fetch
- 2026-07-personal-widget
- 2026-07-premium-group-expansion-announcement
- 2026-07-premium-referral-incentives
- 2026-07-quest-home-default-banner-removal
- 2026-07-reduce-leave-call-gpu
- 2026-07-reject-with-error-kill-switch
- 2026-07-renewable-end-date-sort
- 2026-07-smag-dm-sidebar-nitro-recommendation
- 2026-07-typing-users-css-dots
- 2026-07-unobtrusive-device-suggestions
- 2026-07-vibegrations-user
- 2026-07-wishlist-direct-to-gifting
- 2026-08-ad-topic-opt-out-client
- 2026-08-android-jank-per-screen
- 2026-08-audio-fidelity
- 2026-08-automontage
- 2026-08-badge-management
- 2026-08-bounties-mobile-quest-bar
- 2026-08-dcf-new-user-cooldown
- 2026-08-dont-close-chat
- 2026-08-forward-age-restricted-destinations
- 2026-08-game-mode
- 2026-08-game-profiles-vc
- 2026-08-gsh-subs-activity-bar
- 2026-08-ios-objc-composed-image-cache
- 2026-08-mark-channel-unread
- 2026-08-mute-aware-noise-cancellation
- 2026-08-nitro-tenure-badge-total-progress
- 2026-08-nitro-tenure-badge-withheld-state
- 2026-08-no-fill-logging
- 2026-08-profile-embed-rendering
- 2026-08-profile-embed-share-button
- 2026-08-rive-web-perf
- 2026-08-rocketleague-events
- 2026-08-scheduled-messages
- 2026-08-show-expressive-modal-subtitle-alt
- 2026-08-split-payments
- 2026-08-tiny-bronco
- 2026-08-user-bio-max-length
- 2026-08-video-guard
- 2026-08-virtual-backgrounds-ios
- 2026-08-vq-remaining-time-truncation
- 2026-08-web-filter-tag-group-migration
- 2026-09-a11y-chassis-target-size
- 2026-09-activity-go-live
- 2026-09-agc2-mobile
- 2026-09-build-a-bear
- 2026-09-build-a-bear-cards
- 2026-09-clips-editor-image-track
- 2026-09-connected-thread-sidebar
- 2026-09-default-emojis
- 2026-09-desktop-tti-shader-cache
- 2026-09-desktop-tti-update-check-deadline
- 2026-09-desktop-voice-message-recording
- 2026-09-edit-profile-collectibles-ordering
- 2026-09-friends-sidebar
- 2026-09-game-profiles-v3-commerce-tab
- 2026-09-game-profiles-v3-communities-tab
- 2026-09-game-search-row
- 2026-09-gifting-badge-coachmark-audience
- 2026-09-gsimagic2
- 2026-09-halloween-holiday
- 2026-09-halloween-wishlisting-animation
- 2026-09-hexagon-campaign-client
- 2026-09-invite-accept-age-group-errors
- 2026-09-invite-expiring-soon
- 2026-09-invite-silp-education
- 2026-09-ios-callkit-connected-on-rtc
- 2026-09-linked-game-org-invites-dev
- 2026-09-linux-gpu-decode
- 2026-09-manual-review-inconclusive-copy
- 2026-09-mobile-quest-home-sort-priority
- 2026-09-mobile-quest-reward-button-to-secondary-button
- 2026-09-multi-sku-embed-rendering
- 2026-09-nameplate-video-preload-none
- 2026-09-new-horizontal-scroll-shared
- 2026-09-new-orb-reward-visuals
- 2026-09-nitro-file-upload-rollout
- 2026-09-non-nitro-file-upload-marketing
- 2026-09-orbs-hero-carousel
- 2026-09-profile-link-fetch
- 2026-09-profile-widget-empty-state-suggestions
- 2026-09-quest-home-bounties-feature-gate
- 2026-09-quest-mobile-bar-secondary-cta
- 2026-09-referral-profile-contextual-menu-upsell
- 2026-09-referral-trial-cta
- 2026-09-registration-email-opt-in-copy
- 2026-09-request-to-stream-go-live-modal
- 2026-09-request-to-stream-new-entry-point
- 2026-09-rust-3p
- 2026-09-safety-flows-legacy-required-actions
- 2026-09-server-onboarding-setup-progress
- 2026-09-server-tooltip-notification-context
- 2026-09-silp-app-opened-direct-to-discoverable
- 2026-09-silp-cta-copy-tests
- download_discord_app
- 2026-09-silp-direct-to-discoverable
- 2026-09-single-cpu-copy
- 2026-09-soundboard-quick-action
- 2026-09-stream-zero-vad-leading
- 2026-09-three-month-nitro-gifting
- 2026-09-try-display-name-style
- 2026-09-update-email-settings-copy-subtext
- 2026-09-video-background-profile-fetch
- 2026-09-voice-connect-feedback
- 2026-09-web-sticker-picker-upsell-restyle
- 2026-09-windows-native-premap
- 2026-09-youtube-3p
- 2026-09-youtube-3p-nagbar
- 2026-10-add-server-join-first
- 2026-10-android-chat-preinflation
- 2026-10-android-ui-manager-constants-cache
- 2026-10-avx512-entropy-histogram
- 2026-10-badge-directory-updates
- 2026-10-bounties-desktop-quest-bar
- 2026-10-bulk-nitro-gifting-discounts
- 2026-10-camp-in-dm
- 2026-10-clickable-hero-banner
- 2026-10-cod-relink
- 2026-10-code-blurple
- 2026-10-code-blurple-marketing-holdout
- 2026-10-code-blurple-teaser
- 2026-10-code-blurple-teaser-marketing
- 2026-10-collectibles-interactive-jumble-bar
- 2026-10-collectibles-marketing-client-cache
- 2026-10-conjure-mcp-ui
- 2026-10-contextual-referrals-gdm-member-list
- 2026-10-contextual-referrals-server-channel-member-list
- 2026-10-contextual-referrals-user-dm-sidebar
- 2026-10-desktop-conjure-native-preview-view
- 2026-10-desktop-game-perf
- 2026-10-desktop-general-perf
- 2026-10-desktop-tti-perf
- 2026-10-e2e-latency-measurement
- 2026-10-embedded-app-frame-policy
- 2026-10-embedded-app-shim-v2
- 2026-10-embedded-app-storage-access
- 2026-10-express-checkout
- 2026-10-fix-soundboard-muting-iconography
- 2026-10-game-exit-promo-rust
- 2026-10-gdm-duration-timer
- 2026-10-gift-cards-in-app-marketing
- 2026-10-gifted-subscriptions
- 2026-10-guild-tooltip-lazy-content
- 2026-10-hd-streaming-contextual-referrals
- 2026-10-macaron
- 2026-10-macaron-non-sub-marketing
- 2026-10-mana-badge-refresh
- 2026-10-native-markdown-setting
- 2026-10-nitro-tab-remove-account-age-restriction
- 2026-10-overlay-native-window-rendering
- 2026-10-pinot-member
- 2026-10-profile-default-tab-with-content
- 2026-10-profile-read-state
- 2026-10-purchase-history
- 2026-10-referral-refresh-notification
- 2026-10-remove-quests-from-discovery
- 2026-10-server-tag-upsell-on-guild-profile
- 2026-10-server-tag-upsell-on-profile
- 2026-10-sfp-bloons-orb-split-tender
- 2026-10-shop-marketing-fatigue
- 2026-10-soundboard-mute-indicator
- 2026-10-stage-unified-call-user
- 2026-10-uimanager-experiments
- 2026-10-user-profile-widget-suggestions
- 2026-10-video-player-playback-speed
- 2026-10-wasm-precompressed-brotli
- 2026-10-web-screen-share-audio
- 2026-10-web-streaming-optimizations
- 2026-08-gift-recipient-display-name-search
- 2026-08-profile-read-state-v1
- 2026-09-application-test-mode-quick-access
