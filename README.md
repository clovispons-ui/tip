# 🏆 TIP (Tournoi Inter-Filières) - Application de Gestion & Affichage

Cette application web autonome (HTML5 / CSS3 / Vanilla JavaScript) permet d'organiser, arbitrer, gérer en direct et projeter sur vidéoprojecteur les résultats, le classement général et le planning des matchs du tournoi inter-filières.

---

## 📁 Structure des Fichiers

- **`index.html`** : **Interface d'Affichage Public (Vidéoprojecteur)**
  - Conçue pour être projetée en plein écran (`F11`).
  - **Grand format pour le classement des 8 filières** avec podium médailles (🥇, 🥈, 🥉), détails par sport et totaux géants.
  - **Calendrier ciblé haute visibilité** : affiche exactement les **2 prochains matchs sur chaque terrain et pour chaque sport**.
  - **Code couleur propre à chaque sport** (bordure, heure, badge).
  - N'affiche les matchs de phases finales **que lorsque les 2 équipes qualifiées sont connues**.
  - Gymnases et terrains clairement mis en valeur (notamment **COSEC** et **Sport-Co** pour le football).
  - Intègre le **Mode Show POM-POM & Pause Repas (13h15)** aux couleurs Jaune & Noir.

- **`admin.html`** : **Interface Administrateur (Organisateurs)**
  - Protégée par mot de passe sécurisé (hachage cryptographique **SHA-256**).
  - Bouton **"🔑 Mot de passe"** dans la barre supérieure pour modifier le mot de passe à tout moment.
  - Bouton **"🔒 Déconnexion"** pour verrouiller l'écran d'administration lors des pauses.
  - Bouton **"📣 Mode Pause Repas / Show POM-POM (13h15)"** pour basculer instantanément l'affichage du vidéoprojecteur.
  - Page détaillée par sport réorganisée de façon claire :
    - **Matchs séparés par poule** (Poule 1, Poule 2, Poule 3...) avec leur classement en direct juste à côté.
    - **Section dédiée aux Phases Finales** (Quarts, Demis, Petite Finale, Finale).
    - Bouton dédié : **"⚡ Clôturer les Poules & Remplir les Phases Finales"** pour qualifier automatiquement les premières équipes et remplir l'arbre final une fois les poules terminées.
    - Tableau des points et stades atteints par équipe (la colonne statut inutile a été retirée).
    - Bouton **"📥 Télécharger le planning (.xls)"** pour exporter le fichier Excel.

- **`app.js`** : **Moteur logique, barème et synchronisation**
  - Données officielles des 8 filières et leurs couleurs (Télécom, Info, Matméca, SEE, R&I, Elec, Ekip Bar, Admin).
  - **Nouveau barème des points officiel du tournoi** :
    - **8ème : 1 pt**
    - **Quart : 2 pts**
    - **Demi : 4 pts**
    - **Finale : 5 pts**
    - **Vainqueur : 7 pts**
    - **Poule : 0 pt** (une équipe éliminée en poule ou qui ne passe pas n'obtient pas de point).
  - **Barème des matchs de poules (Foot, Basket, Volley, Dodgeball)** :
    - **Victoire : 3 pts**
    - **Match nul : 2 pts**
    - **Défaite : 1 pt**
  - Gymnases du Football : **Gymnase 1 = COSEC**, **Gymnase 2 = Sport-Co**.
  - Synchronisation instantanée entre onglets via `localStorage`.

- **`style.css`** : **Feuille de styles responsive haute visibilité**
  - Couleurs officielles des filières et des sports.
  - Mode Nuit (sombre optimal pour vidéoprojecteur) et Mode Clair.
  - Carte spéciale pour le show pom-pom (jaune & noir).

---

## 🚀 Comment lancer l'application ?

1. Décompressez l'archive **`tournoi_interfilieres.zip`**.
2. Ouvrez **`admin.html`** dans votre navigateur sur votre ordinateur d'organisation (mot de passe initial : `BDSBDEBAR`).
3. Ouvrez **`index.html`** dans un second onglet ou déplacez-le sur votre second écran relié au vidéoprojecteur, puis appuyez sur **F11** pour passer en plein écran.
4. Dès que vous saisissez un score, assignez un arbitre ou cliquez sur un bouton dans `admin.html`, l'affichage `index.html` se met à jour instantanément sans recharger la page !

---

## 🔒 Sécurité du mot de passe Administrateur

Le mot de passe **n'est plus stocké en clair** dans le code source :
- Il est protégé par une empreinte cryptographique **SHA-256**.
- Même en ouvrant `app.js` ou en inspectant le code du navigateur (`F12`), il est impossible de lire le mot de passe en clair.
- Pour changer le mot de passe :
  - **Méthode 1 (Directe)** : Cliquez sur le bouton **"🔑 Mot de passe"** en haut à droite de `admin.html`.
  - **Méthode 2 (Dans app.js)** : Remplacez la constante `DEFAULT_ADMIN_PASSWORD_HASH` par l'empreinte SHA-256 de votre choix.

---

## 🎯 Fonctionnalités Clés & Adaptations Demandées

1. **Composition Manuelle des Poules & Séries** :
   - Interface intuitive pour composer vos poules librement comme vous le souhaitez avant ou après le tirage :
     - Choix du nombre de poules (1, 2, 3, 4 poules ou ajout personnalisé).
     - Déplacement ou assignation immédiate de chaque équipe dans la poule souhaitée via menu déroulant ou bouton rapide.
     - Zone visuelle dédiée pour les équipes non encore assignées.
     - Bouton **"🪄 Répartir équitablement"** pour pré-remplir les poules de manière équilibrée en 1 clic.
     - Bouton vert proéminent **"⚡ Compléter & Mettre en forme (Matchs & Horaires)"** : prend vos poules personnalisées, génère toutes les rencontres de poules, planifie proprement les horaires et terrains sans chevauchement pour une même équipe, adapte automatiquement l'arbre des phases finales et remet tout en forme sans effacer vos scores existants !

2. **Choix des Qualifiés & Adaptation dynamique des 8èmes et Quarts** :
   - Vous avez le plein contrôle sur le niveau de démarrage des phases finales grâce au sélecteur **"Qualifiés :"** :
     - **Option 8èmes de finale (16 qualifiés)** : génère les 8 matchs de 8èmes, puis les 4 Quarts, 2 Demis et les Finales, avec avancement automatique des vainqueurs à chaque tour !
     - **Option Quarts de finale (8 qualifiés)** : génère directement les 4 Quarts, les 2 Demis et les Finales (les 8èmes sont exclus).
     - **Option Demi-finales (4 qualifiés)** : démarre directement aux Demi-finales (les 8èmes et Quarts sont exclus).
     - **Option Grande Finale directe (2 qualifiés)** : démarre directement à la Finale.
   - Les anciens matchs superflus présents en cache sont nettoyés automatiquement en fonction de votre choix.

3. **Barème des points du tournoi par équipe** :
   - 8ème : 1 pt
   - Quart : 2 pts
   - Demi : 4 pts
   - Finale : 5 pts
   - Vainqueur : 7 pts
   - Poule : 0 pt si éliminée.

4. **Barème des matchs de poules (Foot, Basket, Volley, Dodgeball)** :
   - Victoire : 3 pts
   - Nul : 2 pts
   - Défaite : 1 pt

5. **Affichage Admin réorganisé** :
   - Matchs regroupés distinctement par Poule (avec classement direct à côté affiché en gros) et dans une section dédiée pour les Phases Finales.
   - Bouton **"⚡ Clôturer les Poules & Remplir les Phases Finales"** : calcule les classements des poules et place automatiquement les qualifiés dans l'arbre final.
   - La colonne "Statut" a été retirée du tableau récapitulatif des équipes.

6. **Affichage Vidéoprojecteur grand format (TIP)** :
   - Titre "TIP 🏆" avec horloge centrée en haut.
   - Rang du classement dans des grands carrés bien centrés avec médailles 🥇🥈🥉.
   - Le calendrier affiche les **2 prochains matchs par terrain et par sport** (sans la mention "Prochain match").
   - Chaque sport possède sa propre couleur distinctive pour les bordures, l'heure et les badges :
     - ⚽ Football : Bleu Ciel / Océan (`#0284c7`) avec terrains **COSEC** et **Sport-Co**.
     - 🏀 Basketball : Orange Basket (`#ea580c`).
     - 🏐 Volleyball : Bleu Roi Volley (`#2563eb`).
     - 🏃 Relais 4x100m : Rouge Piste Athlé (`#dc2626`).
     - 🤾 Dodgeball : Violet Intense (`#7c3aed`).
   - Les matchs de phase finale non encore déterminés (sans les 2 équipes) ne sont pas affichés sur le vidéoprojecteur tant que les équipes ne sont pas qualifiées.

7. **Pause Repas & Show POM-POM (13h30)** :
   - Un bouton dans l'accueil administrateur permet d'activer le mode Pause Repas / Show POM-POM : la zone de droite affiche une carte géante Jaune & Noir parfaitement centrée à l'écran, avec horaires et annonce du show, tout en gardant le classement général en gros à gauche.

8. **Décalage Horaire Global en 1 Clic par Sport & Terrain** :
   - Dans l'onglet de chaque sport, une barre d'action rapide permet de décaler tous les matchs à venir de `+5 min`, `+10 min`, `+15 min` (ou `-5 min`, `-10 min` ou durée sur-mesure).
   - Possibilité d'appliquer le décalage à l'ensemble du sport ou uniquement à un terrain particulier (ex. COSEC en cas d'interruption sur ce terrain).
   - Les matchs déjà joués avec score validé sont automatiquement préservés.

9. **Flash Info & Alerte Plein Écran Vidéoprojecteur** :
   - Depuis l'interface d'administration, saisissez un message d'urgence ou une annonce prioritaire et cliquez sur **"🚀 Activer & Projeter le Flash Info"**.
   - Le message prend instantanément possession de 100% de l'écran du vidéoprojecteur (`index.html`) en très grand format centré, avec typographie sportive stadium ultra lisible à 30 mètres.
   - Émission d'un carillon sonore d'alerte haute clarté synthétisé sans aucun fichier audio externe (Web Audio API) et vibration/notification sur les smartphones connectés.

10. **Serveur Local Autonome & QR Code Mobile (Zéro Frais)** :
    - Deux scripts serveurs autonomes zéro-dépendance sont fournis :
      - **En Node.js :** `node server.js` (ou `node tip/server.js`)
      - **En Python 3 :** `python3 server.py` (ou `python3 tip/server.py`)
    - Le serveur démarre sur le port `8080`, détecte automatiquement l'adresse IP locale de la machine (ex: `http://192.168.1.X:8080`), et génère un QR Code vectoriel pur SVG dans le coin inférieur droit du vidéoprojecteur.
    - Les capitaines et supporters connectés au même réseau (Wi-Fi ou hotspot local sans fil du PC de l'orga) flashent le QR Code avec leur appareil photo pour suivre en direct les matchs et recevoir les notifications d'alerte !

11. **Export Excel (.xls) Stylisé & Pratique pour Saisie Manuelle** :
    - Mise en page professionnelle aux couleurs officielles de chaque sport.
    - Séparation claire en deux tableaux distincts : **Phase de Poules** et **Phases Finales**.
    - Colonnes pré-calibrées avec cases de scores larges et contrastées (*Score A*, *Score B*, *Vainqueur*, *Arbitre*, *Émargement*), idéales à imprimer ou à remplir directement sur ordinateur.
