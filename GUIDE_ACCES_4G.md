# 📱 GUIDE OFFICIEL : ACCÈS 4G SMARTPHONE & SUIVI EN DIRECT DU TIP

Ce guide opérationnel pas-à-pas explique comment lancer, configurer et administrer l'application web du **Tournoi Inter-Promo (TIP)** avec un accès public direct par QR Code en 4G mobile, sans dépendre d'un Wi-Fi commun et en préservant toutes les fonctionnalités temps réel (scores en direct, Flash Info, tableau des matchs).

---

## 1. 🌟 Présentation de la Solution RetenP (TIP)*P (TIP)*P (TIP)*P (TIP)*ue

### 1.1 Le Défi
Dans les gymnases et complexes sportifs universitaires :
- Le réseau Wi-Fi public est souvent saturé, bridé par un portail captif, ou inaccessible aux étudiants.
- Les spectateurs et capitaines utilisent leurs forfaits cellulaires personnels (**4G / 5G**).
- Une adresse locale privée (`192.168.x.x` ou `localhost`) ne peut **pas** être ouverte depuis un smartphone connecté en 4G.

### 1.2 La Solution : Cloudflare Quick Tunnel (100% Gratuit)
Nous avons intégré la technologie **Cloudflare Quick Tunnel (`trycloudflare.com`)** :
- **100% Gratuite et Illimitée** : Aucun compte à créer, aucun abonnement, **aucune carte bancaire requise**.
- **Zéro Friction Spectateur** : Contrairement à d'autres solutions (Localtunnel qui exige un mot de passe IP, Ngrok ou Pinggy qui affichent des pages d'avertissement interstitielles), Cloudflare redirige **immédiatement** le visiteur sur le tableau de bord du TIP.
- **Certificat SSL/HTTPS universel** : Reconnu nativement par Safari iOS et Google Chrome Android sans message de sécurité.
- **Temps Réel Préservé (SSE)** : Les mises à jour de scores et les alertes sonores et visuelles **Flash Info** sont transmises instantanément.

---

## 2. 🏗️ Architecture & Fonctionnalités Clés

```
┌─────────────────────────────────────────────────────────────────┐
│                      VIDÉOPROJECTEUR (SALLE)                    │
│                                                                 │
│  [ MATCHS EN COURS ]   [ CLASSEMENT ]   [ QR CODE OFFICIEL 4G ] │
│                                         (https://*.trycloudflare)
└─────────────────────────────────▲───────────────────────────────┘
                                  │ SSE (TUNNEL_UPDATE)
┌─────────────────────────────────┴───────────────────────────────┐
│                       PC ORGANISATEUR (BDS)                     │
│                                                                 │
│  Serveur TIP (Node.js ou Python 3) sur port 8080                │
│    ├── API Réseau & Synchronisation (/api/events, /api/info)     │
│    ├── Moteur SVG QR Code renforcé (QR v6, jusqu'à 105 car.)    │
│    └── Protection spectateur (zéro écrasement d'état)           │
│                                                                 │
│  Tunnel Cloudflare en arrière-plan                              │
│    └── Expose http://localhost:8080 vers Internet en HTTPS      │
└─────────────────────────────────▲───────────────────────────────┘
                                  │ Flux 4G / 5G Mobile
                    ┌─────────────┴─────────────┐
                    │                           │
            📱 Smartphone 4G            📱 Smartphone 4G
            (Capitaine Génie Civil)     (Spectateur Informatique)
```

### Améliorations Majeures Intégrées :
1. **QR Code Étendu (Version 6)** : Le composant `tip/qrcode.js` prend désormais en charge les URLs jusqu'à **105 caractères** sans exception et corrige les effets de seuil aux limites.
2. **Morphing Temps Réel du QR Code** : Dès que le tunnel public est actif, le serveur émet un événement SSE `TUNNEL_UPDATE` ; le QR code sur l'écran projeté se met à jour **automatiquement sans rafraîchir la page**.
3. **Protection Anti-Écrasement d'État** : Quand un nouvel étudiant ouvre la page sur son mobile avec un cache vide, son navigateur ne renvoie jamais d'état vierge au serveur. Les scores des organisateurs sont sanctuarisés.
4. **Maintien de Connexion Anti-Coupure (Keepalive)** : Un signal cardiaque SSE est émis toutes les 20 secondes avec les en-têtes anti-mise en mémoire tampon (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`), garantissant que Cloudflare et les navigateurs mobiles ne coupent jamais le flux.

---

## 3. 🚀 Procédure Pas-à-Pas pour le Jour du Tournoi

### Étape 1 : Préparation de la machine organisateur
1. Allumez l'ordinateur portable de la table de marque.
2. Connectez le PC à Internet (partage de connexion 4G d'un smartphone organisateur ou connexion filaire/Wi-Fi du gymnase).
3. Branchez le câble HDMI du vidéoprojecteur.

### Étape 2 : Lancement en un clic
Ouvrez un terminal dans le dossier du TIP et lancez :
```bash
./start.sh
```
*(ou alternativement avec npm : `npm start`)*

Le script effectue automatiquement :
- La détection de l'environnement (Node.js ou Python 3).
- La détection ou le téléchargement transparent du binaire officiel Cloudflare Tunnel.
- Le démarrage du serveur local et du tunnel 4G.
- L'affichage de la bannière de confirmation :
```
===============================================================
🚀 ACCÈS 4G PUBLIC ACTIVÉ SANS WI-FI !
📱 URL Smartphone 4G : https://tip-tournoi-live.trycloudflare.com
✨ Le QR code sur le vidéoprojecteur est désormais public !
===============================================================
```

### Étape 3 : Lancer le diagnostic de bon fonctionnement
Dans un autre terminal ou onglet, exécutez le diagnostic officiel du matin :
```bash
npm run check:readiness
```
*(ou `node tests/verify_readiness.js`)*

Le rapport affiche des voyants verts pour certifier :
- `[OK] Serveur local actif`
- `[OK] Tunnel 4G actif et joignable`
- `[OK] En-têtes Cloudflare & Proxy SSE configurés`
- `[OK] QR Code SVG vectoriel généré et validé`

### Étape 4 : Affichage sur le Vidéoprojecteur
1. Ouvrez votre navigateur sur : **`http://localhost:8080/index.html`**
2. Déplacez la fenêtre sur l'écran du vidéoprojecteur.
3. Appuyez sur **F11** pour passer en plein écran.
4. Le QR Code officiel apparaît en haut à droite avec un bouton d'agrandissement en plein écran.

### Étape 5 : Administration du Tournoi
1. Sur l'écran du PC organisateur, ouvrez : **`http://localhost:8080/admin.html`**
2. Entrez le mot de passe administrateur (par défaut : `admin123`).
3. Observez l'indicateur **`4G : En ligne`** dans la barre supérieure.
4. Vous pouvez gérer les poules, saisir les scores des matchs et déclencher des alertes **Flash Info** sonores et visuelles qui retentiront instantanément sur les smartphones des capitaines.

---

## 4. 🛟 Procédures de Secours (Fallbacks)

Si un imprévu survient le jour de l'événement, trois niveaux de secours sont disponibles :

### Secours Niveau 1 : Tunnel de repli via SSH natif (Pinggy)
Si pour une raison de pare-feu le tunnel Cloudflare ne peut s'établir, utilisez le tunnel SSH intégré à Ubuntu sans rien installer :
```bash
ssh -p 443 -o StrictHostKeyChecking=no -R0:localhost:8080 free@a.pinggy.io
```
1. Récupérez l'URL affichée par SSH (`https://xxxxx.a.pinggy.link`).
2. Ouvrez l'interface Admin TIP (`http://localhost:8080/admin.html`).
3. Dans la section **Accès 4G Public**, collez l'URL dans le champ *« Forcer une URL publique »* et cliquez sur **Appliquer**.
4. Le QR code du vidéoprojecteur bascule immédiatement sur cette nouvelle URL.

### Secours Niveau 2 : Forcer une URL manuelle (CLI ou Variable d'environnement)
Si vous disposez d'un nom de domaine personnalisé ou d'un tunnel déjà ouvert :
```bash
PUBLIC_URL=https://mon-domaine-tip.fr ./start.sh
# ou
node tip/server.js --public-url https://mon-domaine-tip.fr
```

### Secours Niveau 3 : Repli Réseau Local / Hotspot Wi-Fi du PC (0 Internet)
Si le complexe sportif est une zone blanche totale sans aucune couverture 4G :
1. Activez le **Point d'accès mobile Wi-Fi** (Hotspot) sur l'ordinateur portable organisateur.
2. Lancez le serveur en mode local :
   ```bash
   ./start.sh --no-tunnel
   ```
3. Le serveur détecte automatiquement l'adresse IP locale du PC (`http://192.168.x.x:8080/index.html`).
4. Le QR code encodera cette adresse locale : invitez les capitaines à se connecter au Wi-Fi du PC pour suivre le tournoi.

---

## 5. 🛠️ Foire Aux Questions & Dépannage Rapide

### Q1 : Le port 8080 est déjà occupé par un autre logiciel.
**Solution :** Choisissez un autre port lors du lancement :
```bash
PORT=8090 ./start.sh
```

### Q2 : Comment relancer la suite complète de vérification technique ?
**Solution :** Lancez la suite de tests automatisée à tout moment :
```bash
npm test
```
Elle valide en moins de 3 secondes le serveur Node, le serveur Python, les 6 endpoints d'API, le flux SSE et les limites du QR code.

### Q3 : Pourquoi le signal sonore de Flash Info ne retentit pas immédiatement sur certains smartphones ?
**Solution :** Les navigateurs mobiles (iOS Safari et Android Chrome) bloquent la lecture audio automatique tant que l'utilisateur n'a pas touché l'écran au moins une fois. Dès que l'étudiant clique sur un filtre de sport ou fait défiler la page, l'audio est débloqué pour tout le reste du tournoi.

---

## 6. 📋 Récapitulatif des Commandes Utiles

| Action | Commande |
| :--- | :--- |
| **Lancement officiel (Serveur + Tunnel 4G)** | `./start.sh` ou `npm start` |
| **Lancement local pur (sans tunnel)** | `npm run start:local` |
| **Lancement avec backend Python 3** | `npm run start:python` |
| **Diagnostic du matin du tournoi** | `npm run check:readiness` |
| **Suite de tests automatisée complète** | `npm test` |

*Bon tournoi à toutes les filières !* 🏆
