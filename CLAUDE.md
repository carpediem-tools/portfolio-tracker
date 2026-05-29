# CLAUDE.md — Portefeuille Tracker

## Projet
Tracker d'investissement 100% local. Interface web servie par Python stdlib.
Depuis V2.20, le projet est multi-fichiers : backend Python séparé du frontend.

## Stack
- Python 3.13, Debian Linux
- Stdlib uniquement : `http.server`, `json`, `urllib`, `threading`, `pathlib`
- Dépendance optionnelle : `yfinance` (pip) — prix Yahoo Finance + taux FX
- Prix crypto : CoinGecko API publique, sans clé
- Taux FX historiques : Frankfurter API publique, sans clé (BCE, depuis 1999)
- Frontend : HTML/CSS/JS vanilla, fichiers statiques dans static/

## Fichiers
- `portefeuille.py`              ← backend Python pur
- `static/index.html`            ← structure HTML
- `static/style.css`             ← styles
- `static/app.js`                ← logique frontend
- `portefeuille_data.json`       ← données persistantes, même dossier
- `portefeuille_documentation.md` ← doc utilisateur

## Architecture
Le backend sert les fichiers statiques via do_GET :
- GET  /                      → static/index.html
- GET  /static/*              → fichiers servis depuis static/ (no-cache)
- GET  /api/data              → JSON complet
- GET  /api/sync              → sync tous les prix (Yahoo + CoinGecko + FX)
- GET  /api/sync/cto          → sync prix CTO uniquement
- GET  /api/sync/crypto       → sync prix Crypto uniquement
- GET  /api/syncfx/cto        → sync taux FX historiques Sorties CTO
- GET  /api/syncfx/crypto     → sync taux FX historiques Sorties Crypto
- GET  /api/quit              → arrêt serveur
- POST /api/data              → sauvegarde JSON

Fonctions backend principales :
`load_data()`, `save_data()`, `fetch_yahoo()`, `fetch_coingecko()`,
`fetch_fx_rates()`, `fetch_fx_rate_at()`, `parse_crypto_ticker()`

## Conventions
- Modifier CSS ou JS → rechargement navigateur suffit, pas de redémarrage serveur
- Modifier portefeuille.py → redémarrage serveur obligatoire
- Toute invalidation de taux FX dans app.js DOIT passer par `invalidateFxSource()`
  — ne jamais écrire le pattern inline
- `parseCryptoTicker` existe en deux versions (app.js + portefeuille.py) —
  duplication délibérée : validation locale dans chaque couche, pas d'aller-retour réseau, validation instantanée à chaque frappe. Toute évolution du format ticker crypto ou des devises supportées DOIT être appliquée dans les deux fichiers simultanément.

## Lancer le projet
```bash
cd ~/Documents/Informatique/Portefeuille_V2/work/portefeuille
python3 portefeuille.py
# Ouvre automatiquement http://localhost:8080
```

## Dépendance optionnelle
```bash
pip install yfinance --break-system-packages
```
Sans yfinance : fallback HTTP direct Yahoo (moins fiable).

## Données
- Sauvegarde automatique à chaque modification (pas de bouton "Enregistrer")
- Structure JSON : `settings`, `cto`, `crypto`, `ctoTrades`, `cryptoTrades`,
  `historique`, `ctoDivs`, `fxRates`
- `ctoDivs` : champ prévu dans les données, interface non encore implémentée
- `historique[n].classes` : objet `{"Actions": 1100, "Métaux": 390}` —
  remplace les clés plates `actions`/`metaux`/`immo` depuis V2.18.
  `crypto` reste à la racine de l'entrée historique.
- DEFAULT_DATA : currency: "usd" (et non "eur"), brokers: [], classes: []
  (listes vides — aucune valeur par défaut injectée)

## Conventions de code / internationalisation
- Langue de l'interface : anglais (en-US)
- Locale nombres : 'en-US' dans tous les helpers fmt* (fmt, fmtNative, fmtP, fmtC, fmtQ)
- Format de date affiché : ISO YYYY-MM-DD (isoToday()) et YYYY-MM-DD HH:MM:SS (isoNow())
- PRU en prose doc → "weighted average cost (WAC)" ; colonne UI → "Avg cost" ; clé JSON/code → pru (inchangé)
- Glossaire UI : G/P→P&L, Valorisation→Valuation, Devise→Currency, Classe→Class,
  Sorties→Sales, Cession→sale, Onglet→Tab, Pastille→Status indicator,
  Évol.→Chg., Répart.→Weight, Investi→Invested, PRU→Avg cost, MAJ→Updated

## Contraintes à respecter
- Pas de framework frontend (pas de React, Vue, etc.)
- Pas de dépendance backend obligatoire (tout ce qui n'est pas stdlib doit
  rester optionnel)
- Pas de tests automatisés actuellement
- Tous les tableaux utilisent la classe `.resp-tbl` (style.css) + un <colgroup> généré via makeColgroup() (app.js).
  table-layout:fixed, proportions en %, min-width par tableau.
  Toute nouveau tableau doit suivre ce pattern.
  Ne jamais mettre de width en pixels sur les inputs/cellules.

## Points de vigilance connus
- La devise dans Cryptos est fonctionnelle (influe sur l'appel CoinGecko) —
  ne pas confondre avec la devise CTO (informatif seulement)
- `classe: "Metaux"` (sans accent) est un legacy antérieur à V2.18 —
  migration silencieuse au chargement JS
- `fxRates` peut être absent sur une install fraîche
- Frankfurter : taux disponibles depuis le 04/01/1999 uniquement —
  dates antérieures ou futures retournent une erreur → pastille ⚪

# Environnement
- Les briefs doivent toujours se terminer par :
  "À la fin, liste les modifications effectuées fichier par fichier
  (repère + remplacement confirmé)."
  → Nécessaire car l'IDE n'affiche que des diffs visuels, pas de rapport texte.
