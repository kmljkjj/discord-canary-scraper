# discord-canary-scraper (dépôt de test)

Datamining du client Discord Canary : builds, expériences, strings, routes, rollouts Apex / utilisateurs, quêtes, boutique, blog, versions mobiles, veille X. Les nouveautés sont postées sur Discord via webhooks.

## Sources

- **% user** : couverture de l'espace de buckets depuis le gist communautaire
  d'[agnonotdev](https://gist.github.com/agnonotdev) (`src/gist_user_rollouts.js`
  v1, toutes les 30 min) — ~1000 expériences, pourcentages à 0,01 point près,
  classification user/guild depuis nos propres scrapes, détection de
  ramp-ups/reconfigurations/retraits contre le dernier état notifié, cas
  ambigus (multi-populations, chevauchements) signalés jamais lissés. Le
  sampling propre (`src/user_rollouts.js` v14, fenêtre glissante 4 h + IC de
  Wilson) reste disponible à part comme diagnostic ;
- **% guild** : exact, décodé du wire Discord (`src/apex_rollouts.js` v7) ;
- **noms d'expériences** : extraits de nos propres scrapes du client Canary ;
- **versions mobiles** : manifestes OTA de Discord + stores publics.

Les pourcentages du système % user sont la **couverture de l'espace de
buckets** décrite par la source communautaire (bornes 0-10000) : ce ne sont
ni des estimations statistiques, ni la proportion de vrais utilisateurs
ayant accès à une fonctionnalité (l'assignation réelle dépend de filtres et
d'conditions d'éligibilité absents de ce fichier réduit).

Sources externes lues : le gist d'agnonotdev uniquement (attribué ci-dessus,
 avec révision et date de mise à jour tracées dans chaque état). Tout le
reste est mesuré ou extrait par nous-mêmes, directement depuis les
serveurs de Discord.

## Structure

| Dossier | Rôle |
|---|---|
| `src/` | Scripts principaux (`index.js` = scrape Canary, `quests.js`, `apex_rollouts.js`, `user_rollouts.js`, `shop.js`, `blog_tracker.js`, `mobile_*.js`, `x_*.js`) |
| `src/lib/` | Bibliothèque partagée (téléchargement, extraction, notify, dédup webhooks, état atomique…) |
| `test/` | Tests unitaires (`node --test`) |
| `data/` | État persistant commité par les workflows |
| `builds/` | Archive des derniers builds (manifest + bundle web), limitée par `ARCHIVE_KEEP_BUILDS` |
| `docs/` | Site GitHub Pages (expériences, boutique, statut) |
| `media/` | Avatar du bot (`datamining-avatar.png`, utilisé par les webhooks) |
| `scripts/` | `check.js` (syntaxe), `commit-state.sh` (commit/push d'état sûr), `summary.js` (résumé Actions), `trigger_host.py` / `canary_trigger.py` (déclencheurs externes) |
| `.github/actions/setup` | Action composite : Node 22 + cache npm + `npm ci` |
| `cogs/` | Cog discord.py équivalent au déclencheur |

## Commandes

```bash
npm ci
npm run verify     # check + lint + tests
npm run check      # syntaxe de tous les .js
npm run lint       # ESLint
npm test           # tests unitaires (n'écrivent jamais dans data/)
npm run coverage   # tests + couverture
npm start          # scrape Canary
```

## Workflows GitHub Actions

| Workflow | Fréquence | Script |
|---|---|---|
| `ci.yml` | push / PR | check + lint + tests (Node 20 & 22), actionlint, Python |
| `scrape.yml` | */5 min + dispatch `trigger-scraping` | `src/index.js` |
| `quests.yml` | */5 min | `src/quests.js` |
| `apex-rollouts.yml` | */20 min | `src/apex_rollouts.js` |
| `rollouts-watch.yml` | */20 min | `src/rollouts_watch.js` + `src/user_rollouts.js` |
| `gist-user-rollouts.yml` | */30 min + dispatch `trigger-gist-user-rollouts` | `src/gist_user_rollouts.js` |
| `user-rollouts.yml` | dispatch manuel (diagnostic sampling) | `src/user_rollouts.js` |
| `mobile-versions.yml`, `shop.yml`, `blog-tracker.yml`, `x-news.yml`, `x-watch.yml` | planifiés | scripts correspondants |
| `pages.yml` | push sur `docs/` ou données | déploiement Pages |
| `alerts.yml` | après chaque échec | alerte Discord (si `ALERT_WEBHOOK_URL`), une seule tant que ça reste rouge |

## Secrets / variables

Secrets : `DISCORD_WEBHOOK_URL` (obligatoire), `APEX_WEBHOOK_URL`, `ROLLOUT_WEBHOOK_URL`, `QUEST_WEBHOOK_URL`, `DISCORD_TOKEN`, `DISCORD_USER_TOKEN(S)`, `DISCORD_USER_TOKEN_1..10`, `ORBIT_BOT_NAME`, `EMOJI_*`, `MOBILE_DATAMINE_REPO`.

Secret optionnel : `ALERT_WEBHOOK_URL` (salon d'alertes quand un workflow échoue).

Variables d'environnement utiles : `WEBHOOK_MAX_ATTEMPTS` (5), `WEBHOOK_TIMEOUT_MS` (20000), `ARCHIVE_KEEP_BUILDS` (8), `COMMIT_MAX_ATTEMPTS` (8), `MAX_CHUNK_SCAN_BYTES` (16 Mo), `USER_ROLLOUT_NOISE_Z` (2, seuil de bruit statistique ; 0 = désactivé), `USER_ROLLOUT_WINDOW_H` (4, fenêtre glissante des % user en heures).

### v14 — % user : fiabilité + double mesure

- **Notifications perdues corrigées** : les deltas sont comparés au dernier
  état NOTIFIÉ (`acknowledged`), plus au dernier état mesuré. Un échec de
  webhook ne fait plus disparaître le changement ; il est retenté au run
  suivant. TOUS les changements partent (lots de 10 embeds) et `acknowledged`
  n'avance que pour les lots réellement livrés.
- **Fenêtre unifiée** : le dénominateur n'est plus incohérent entre deux runs
  (un hash absent du batch courant voyait son n changer au run suivant).
- **Revisions** : un changement de revision d'une expérience remet son
  historique à zéro dans la fenêtre (rollout reconfiguré ≠ bruit).
- **Wire validé** : une réponse sans `assignments` est un échec (avant : un
  succès vide qui gonflait n), doublons d'une même réponse ignorés,
  bucket/position contrôlés.
- **Double mesure** : % = k/n + IC de Wilson (référence, non biaisé), PLUS une
  reconstruction indicative des bornes depuis les positions hash_result
  (ordre-statistiques + correction « German tank »), affichée comme ordre de
  grandeur à côté du k/n — jamais présentée comme exacte. Sur les deux
  rollouts partiels observés en production, les positions étaient groupées
  sur ~5 % de l'espace [0, 10000) ; la reconstruction n'est pas une preuve de
  la valeur exacte (la couverture réelle d'un rollout n'est pas vérifiable
  depuis l'API), mais elle met en évidence des clusters cohérents et complète
  utilement le k/n quand l'échantillon est petit.
- **Marge de bruit exacte** : Var(Δp̂) calculée au niveau batch — les
  échantillons partagés entre deux fenêtres glissantes ne sont plus comptés
  deux fois (l'ancienne formule z·√(2p(1−p)/n) sur-estimait l'indépendance).
- **Bug des plages corrigé** : la fusion de plages demi-ouvertes ne remplit
  plus les trous (avant, `[0,1)+[2,3)` devenait `[0,3)` → % surestimés) ;
  les plages qui se chevauchent ne comptent plus double (`guild_decode`).
- **Watcher** : ses replis d'environnement s'appliquent désormais (ils
  étaient posés après le chargement du module) ; workflows watcher +
  dispatch manuel sérialisés (même groupe de concurrence, mêmes fichiers
  d'état) ; le rapport markdown est commité avec le JSON.
- **Nettoyage** : suppression des workflows ponctuels `p0-*` qui modifiaient
  et poussaient le code source, des payloads base64, des chunks de patch
  et du bytecode tracké (~50 fichiers morts).

Variable optionnelle : `ORBIT_AVATAR_URL`. Par défaut, l'avatar est `media/datamining-avatar.png` servi par jsDelivr, ce qui ne fonctionne que si le dépôt est public. Sur un dépôt privé, définir `ORBIT_AVATAR_URL` vers une image PNG/JPG publique (Discord n'accepte pas le SVG).

## Déclencheur rapide (optionnel)

Le cron GitHub a souvent du retard. `scripts/trigger_host.py` vérifie le `BUILD_NUMBER` Canary et ne déclenche Actions que si le build change :

```bash
export GITHUB_TOKEN=...            # PAT classic : repo + workflow (jamais dans le code)
export GITHUB_REPO=kmljkjj/discord-canary-scraper-test
export INTERVAL=50
python3 scripts/trigger_host.py
```

## Changements par rapport au dépôt d'origine

- Suppression d'environ 70 workflows ponctuels (`patch-*`, `heal-*`, `restore-*`, `fix-*`…). Ils modifiaient et poussaient directement le code source (`src/index.js`, `src/quests.js`…), ce qui a déjà corrompu des fichiers.
- Suppression des morceaux base64 et fichiers temporaires (`tmp/`, `patches/`, `scripts/*_parts`, `.github/payloads`, `data/.payload`, chunks en cache dans `assets/`).
- `apex-rollouts.yml` réparé : YAML invalide depuis le 19/09, donc le workflow ne tournait plus.
- `user-rollouts.yml` reconstruit : le fichier ne contenait que `PLACEHOLDER` depuis le 21/09. Il est décalé de 10 min par rapport à Apex pour limiter les 429.
- `scrape.yml` : les archives étaient ajoutées depuis `data/builds/`, alors que le code écrit dans `builds/`. Elles n'étaient donc plus commitées depuis le 15/09. Les anciens builds sont maintenant élagués (8 gardés).
- Tests : `webhook_dedupe` et `notify_partial_batch` supprimaient le vrai `data/notify_dedupe.json`, ce qui provoquait des doubles notifications. Ils utilisent maintenant un dossier temporaire.
- Avatar : l'URL par défaut pointait vers un `.jpg` inexistant (404) ou un `.svg` que Discord refuse. Ajout de `media/datamining-avatar.png`.
- `index.js` : limite `MAX_NOTIFY_RT` réellement appliquée aux routes ajoutées, et suppression du code mort.
- `pages.yml` : le déploiement ne plante plus si Pages n'est pas activé, et il ne tourne que quand `docs/` ou les données publiées changent.
- `mobile-versions.yml` : l'étape « client files » tourne même si l'étape versions échoue.
- Ajout de la CI, d'ESLint, de `scripts/check.js` (tous les fichiers au lieu d'une liste manuelle incomplète), de `npm test` (tous les tests au lieu de 3 sur 7) et de nouveaux tests (`archive_chunks`, `atomic`).

### v2.4

- **Webhooks** : nouveau module partagé `src/lib/webhook.js`, utilisé par les 10 scripts qui avaient chacun leur propre copie. Il gère les 429 (`retry_after` JSON + en-têtes), les 5xx, les erreurs réseau et le timeout avec backoff. Il découpe les embeds selon les limites Discord (10 embeds et 6000 caractères par message) et masque le token dans les logs. Avant, 6 scripts sur 10 ne réessayaient jamais après un 429.
- **Extraction des expériences** (`extract.js`) :
  - le label, les variations et le `defaultConfig` ne débordent plus sur l'expérience voisine (5 labels et 4 jeux de variations étaient mal attribués sur le build 621556) ;
  - la forme minifiée `!0` / `!1` est reconnue : 238 `defaultConfig` extraits au lieu de 28 ;
  - le premier bloc `variations` / `treatments` trouvé gagne.
- **Commits d'état** : `scripts/commit-state.sh` remplace les 10 blocs copiés-collés. En cas de conflit, il repart de `origin/main` et ne réapplique que ses propres fichiers. L'ancien `reset --soft` de shop et blog pouvait annuler les commits des autres workflows.
- **Workflows** :
  - action composite `setup` avec cache npm et `npm ci` partout (x-news et x-watch supprimaient `package-lock.json`) ;
  - x-news et x-watch sont dans le même groupe de concurrence, car ils écrivent le même fichier ;
  - résumé du run dans l'onglet Summary ;
  - workflow d'alertes ;
  - Dependabot.
- **CI** : couverture de code sous Node 22 et 72 tests (51 → 72), dont un test d'intégration git de `commit-state.sh` et des tests d'extraction sur un extrait réel du bundle Discord.

### v2.4.1 (corrections issues des premiers runs réels)

- **User rollouts** : les pourcentages estimés sur 150 tirages oscillaient (10 % → 12 % → 10 %), et chaque oscillation partait sur Discord. Un changement n'est plus annoncé que s'il dépasse la marge de bruit statistique (≈ 7 points pour 10 % sur 150 tirages).
- **User rollouts** : le snapshot du token réessaie après un 429. Avant, il était perdu à chaque fois après l'échantillonnage.
- **Shop** : `/shop/search` renvoie 400 (`ENUM_TYPE_COERCE`, types refusés par Discord). Le script s'arrête au premier 400 et logge la raison. Le catalogue (1688 items) reste complet.
- **Scrape** : la limite de scan passe de 6 à 16 Mo, car un chunk de 6,15 Mo n'était jamais analysé. Les IDs Discord numériques ne sont plus pris pour des chunks (404 en moins).

### v2.5 — Indépendance totale des données (mesure propre)

- **User rollouts v13** (`src/user_rollouts.js`) : les % user sont maintenant une **mesure propre** — échantillonnage anonyme de l'API Discord avec fenêtre glissante de 4 h (~15 passes/heure), % binomial k/n à 2 décimales, marge de bruit par expérience pour éviter les faux changements, et n (nombre d'échantillons) affiché. Chiffres naturellement différents et plus fins que toute publication tierce.
- **Purge des sources externes** : toutes les sources de données tierces sont retirées. `apex_rollouts.js` v7 ne lit plus que le wire Discord ; `experiment_rollouts.js` n'appelle plus que l'API Discord ; `mobile_versions.js` s'appuie sur l'OTA Discord.
- **Watcher v2** (`rollouts-watch.yml`, */20 min) : passes de mesure régulières, plus aucun poll de source externe.
- **Supprimés** : les modules et workflows dédiés aux sources tierces, ainsi que les caches liés.
- **Footer honnête** sur chaque annonce : « Source: mesure propre · API Discord ».

### v2.6 — % user par couverture de buckets (gist communautaire)

- **Nouveau module** `src/gist_user_rollouts.js` + bibliothèque pure
  `src/lib/gist_rollouts.js` : le système % user principal lit le gist
  communautaire d'agnonotdev (copie réduite de rollouts.json, tag Assyst) —
  1005 expériences au catalogue (734 avec données) au lieu des quelques-unes
  visibles par sampling, avec les bornes de buckets exactes sur l'espace
  0-10000. Instantané du 28/10/2026 : 356 user (148 avec données
  exploitables), 37 guild, 612 type inconnu.
- **Sémantique honnête** : % = couverture de l'espace de buckets selon la
  source, à 0,01 point près (longueurs entières, arrondi à l'affichage
  uniquement) — jamais présentée comme la proportion de vrais utilisateurs
  éligibles. Mêmes données et même définition donnent les mêmes valeurs —
  l'amélioration est l'interprétation, le détail et la fiabilité, pas des
  pourcentages « différents ». Les cas ambigus (variantes répétées =
  populations aplaties, chevauchements, somme > 100 %) sont signalés
  (39 expériences à l'instantané du 28/10/2026), jamais lissés ; les
  plages illisibles rendent l'expérience « dégradée » : couvertures par
  entrée conservées, mais TOTAUX indisponibles (le complément « espace
  non décrit » n'est pas connu) ; `variants: []` = « aucune donnée », pas
  0 %.
- **Mieux qu'un relais** : classification user/guild/type inconnu depuis nos
  propres scrapes (les guild sont exclus, mesurés à part par le décodage
  wire apex) ; détail par variante et par rôle ; rapport Markdown
  (`data/gist_user_rollouts.md`) ; miroirs comparés (jamais fusionnés, les
  divergences sont journalisées) ; révision et date de MAJ tracées. Les
  expériences de type inconnu sont suivies dans le rapport (compteurs dans
  l'état) mais ne sont PAS notifiées (leur type n'est pas établi).
- **Notifications fiables** : diff contre le dernier état NOTIFIÉ
  (`acknowledged`) — un échec de webhook ne perd plus un changement, il est
  retenté au run suivant ; UN embed PAR envoi (la livraison partielle est
  identifiable précisément) ; seuil cumulatif 0,05 point (total ou par
  variante — une redistribution à total constant est notifiée) ; premier
  run = baseline silencieuse. Workflow `gist-user-rollouts.yml` (*/30 min).
  L'ancien watcher par sampling (`rollouts-watch.yml`) garde son cron
  désactivé et devient un diagnostic manuel.
- **Tests** : 43 nouveaux tests (plages disjointes/doublons/chevauchements,
  variantes répétées, données vides, seuil cumulatif 25,00 → 25,01 → 25,05,
  redistribution à total constant (titre neutre, pas de faux Δ treatment),
  rejet strict des doublons/entrées/variantes invalides, reclassification
  user → guild sans faux « retiré du gist », miroirs, validation avant diff,
  livraison partielle, échec de lecture → dernier état conservé) —
  256 au total.
- **Limite connue** : la page docs `rollouts.html` (user %) lit encore
  `data/user_rollouts.json` produit par l'ancienne mesure par sampling,
  désormais diagnostic manuel — ces chiffres deviendront figés ; la source
  de référence pour le % user est `data/gist_user_rollouts.md`.
