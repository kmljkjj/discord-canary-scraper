# Relais syndication X — Cloudflare Worker

Les IP des runners GitHub Actions sont partagées par tous les dépôts : le
budget X de la page syndication (30 requêtes / ~15 min / IP) y est épuisé en
moins d'une minute. Ce mini relais, déployé sur votre compte Cloudflare
gratuit, donne aux crons une IP de sortie à vous : plus de loterie.

## Déployer (2 minutes, sans ligne de commande)

1. Créer un compte gratuit : https://dash.cloudflare.com
2. Workers & Pages → Create → Worker → nommer, par exemple
   x-syndication-relay → Deploy (code par défaut, on le remplace juste après).
3. Edit code → tout remplacer par le contenu de relay/worker.js → Deploy.
4. Settings (du worker) → Variables and Bindings → Add :
     Name  : RELAY_KEY
     Value : une chaîne aléatoire de 32+ caractères
     Type  : Secret
5. Récupérer l'URL du worker (Settings → Domains & Routes, lien workers.dev) :
     https://x-syndication-relay.<votre-sous-domaine>.workers.dev

## Côté dépôt GitHub

Settings → Secrets and variables → Actions → New repository secret :

    X_SYNDICATION_RELAY_URL = https://x-syndication-relay.<votre-sous-domaine>.workers.dev/profile/DiscordNEW8r?key=<RELAY_KEY>

C'est tout. Les workflows X News et X Watch utilisent le relais
automatiquement : route « relay » en tête, tentative directe en secours.

## Vérifier

Ouvrir dans un navigateur :

    https://x-syndication-relay.<votre-sous-domaine>.workers.dev/profile/DiscordNEW8r?key=<RELAY_KEY>

La réponse doit être le HTML de la syndication (chercher __NEXT_DATA__ dans
la source). En cas de 401 : mauvaise valeur de key. Le lancement manuel du
workflow X Watch affiche aussi une ligne « relay: HTTP ... » dans le step
Debug qui donne statut + taille + nombre de tweets servis par le relais.

## Coûts

Plan gratuit : 100 000 requêtes/jour. Les crons consomment ~2 requêtes par
10 minutes (x_news + x_watch), soit ~300/jour — marge énorme.

## Alternative CLI (facultative)

    npm install -g wrangler
    wrangler login
    cd relay
    wrangler secret put RELAY_KEY
    wrangler deploy
