# Point du jour

Application web (installable sur l'écran d'accueil de l'iPhone) qui affiche chaque jour :

- **Météo** : maintenant, 24 h, 7 jours, UV, qualité de l'air, pollens, risque de pluie
- **Carburant** : stations les moins chères et les plus proches de votre position (SP95, E10, SP98, gazole, GPL, E85), économie sur un plein, itinéraire Plans
- **Devises** : euro contre dollar, yen, baht (+ livre, franc suisse, lari géorgien), courbes 30 jours, convertisseur
- **Or et argent**, **CAC 40**, **Brent**, **Bitcoin**
- **Économie en France** : inflation, chômage, taux BCE, prochains jours fériés
- **Actualités** : franceinfo et Le Monde, avec une synthèse rédigée par Claude (facultative)

## Confidentialité

Le site est public mais ne contient aucune donnée personnelle. Votre position et vos réglages
restent dans le navigateur de votre téléphone ; ils ne sont envoyés qu'aux services publics
interrogés directement par votre téléphone (Open-Meteo, data.economie.gouv.fr, geo.api.gouv.fr).

## Fonctionnement

- `scripts/build_data.py` (GitHub Actions, 3 fois par jour) récupère les données publiques communes à tous
  (actualités, économie, devises, or) et produit `data/data.json`.
- `index.html` charge ces données et interroge directement, depuis le téléphone, la météo, les prix
  des carburants autour de vous et la qualité de l'air.
- `sw.js` permet d'ouvrir l'application sans réseau (dernières données connues).

## Mise en route

1. **Settings > Pages > Source : GitHub Actions.**
2. (Facultatif) **Settings > Secrets and variables > Actions > New repository secret** : `ANTHROPIC_API_KEY`
   pour la synthèse de l'actualité par Claude.
3. **Actions > Point du jour > Run workflow** une première fois.
4. Ouvrez `https://<votre-compte>.github.io/point-du-jour/` dans Safari, puis **Partager > Sur l'écran d'accueil**.

## Sources

Open-Meteo, data.economie.gouv.fr (prix des carburants), geo.api.gouv.fr, Eurostat, BCE, Frankfurter (taux BCE), Banque nationale de Géorgie (lari),
gold-api.com, Stooq, CoinGecko, calendrier.api.gouv.fr, flux RSS de franceinfo et du Monde.
