/**
 * SERVEUR LOCAL AUTONOME - TOURNOI INTER-FILIÈRES (TIP)
 * Zéro dépendance npm requise (fonctionne avec Node.js standard)
 *
 * Lancement :
 *   node server.js
 * ou depuis la racine :
 *   node tip/server.js
 *
 * Options CLI :
 *   --port <port>          Port d'écoute (défaut : 8080 ou $PORT)
 *   --public-url <url>     URL publique 4G forcée (défaut : $PUBLIC_URL)
 *   --no-tunnel            Désactiver la tentative de tunnel Cloudflare
 *
 * Variables d'environnement :
 *   ADMIN_PASSWORD         Mot de passe admin requis pour les écritures API
 *                          (défaut : mot de passe de DÉMONSTRATION, à remplacer
 *                           impérativement via cette variable)
 *   REFEREE_PASSWORD       Mot de passe arbitre (distinct de l'admin), autorise
 *                          uniquement l'écriture des matchs en direct
 *                          (/api/live-matches), jamais des poules/classements
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Analyse des arguments en ligne de commande
let argPort = null;
let argPublicUrl = null;
const noTunnel = process.argv.includes('--no-tunnel') || process.env.TUNNEL === '0';

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    argPort = parseInt(process.argv[i + 1], 10);
  }
  if (process.argv[i] === '--public-url' && process.argv[i + 1]) {
    argPublicUrl = process.argv[i + 1];
  }
}

const PORT = argPort || parseInt(process.env.PORT, 10) || 8080;
let PUBLIC_URL = argPublicUrl || process.env.PUBLIC_URL || null;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'tournament_state.json');

// ============================================================================
// 🔒 SÉCURITÉ : deux jetons distincts, deux périmètres distincts.
//  - Jeton ADMIN       : requis pour POST /api/state, /api/flash, /api/public-url
//  - Jeton ARBITRE     : requis pour POST /api/live-matches (matchs en direct)
// Les deux jetons sont dérivés de sha256(motDePasse + sel) ; le mot de passe
// en clair n'est jamais stocké côté client ni dans le code.
// ============================================================================
// ⚠️ Mots de passe de DÉMONSTRATION uniquement si les variables ne sont pas définies.
// Toujours lancer en production avec : ADMIN_PASSWORD=... REFEREE_PASSWORD=... node server.js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE_ME_DEMO_PASSWORD';
const EXPECTED_ADMIN_TOKEN = crypto.createHash('sha256')
  .update(ADMIN_PASSWORD + '_TIP_AUTH_OK')
  .digest('hex');
const REFEREE_PASSWORD = process.env.REFEREE_PASSWORD || 'CHANGE_ME_DEMO_REFEREE';
const EXPECTED_REFEREE_TOKEN = crypto.createHash('sha256')
  .update(REFEREE_PASSWORD + '_TIP_REFEREE_OK')
  .digest('hex');
const ADMIN_SALT = '_TIP_AUTH_OK';
const REFEREE_SALT = '_TIP_REFEREE_OK';
const ROLE_ADMIN = 'admin';
const ROLE_REFEREE = 'referee';
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2 Mo max par requête POST
const MAX_SSE_CLIENTS = 200;
const MAX_LIVE_MATCHES = 50;
const MATCH_ID_RE = /^match_[A-Za-z0-9_-]{1,64}$/;
const FILIERE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FLASH_LEVELS = new Set(['urgent', 'info', 'call']);
// Rate limiting très léger sur /api/login (anti brute force basique)
// Un compteur PAR RÔLE : une rafale ratée côté arbitre ne bloque pas l'admin.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const loginAttemptsByRole = {
  [ROLE_ADMIN]: [],
  [ROLE_REFEREE]: []
};

function loginRateLimited(role) {
  const attempts = loginAttemptsByRole[role];
  if (!attempts) return true; // rôle inconnu : refus sans comptabiliser
  const now = Date.now();
  while (attempts.length && now - attempts[0] > LOGIN_WINDOW_MS) attempts.shift();
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) return true;
  attempts.push(now);
  return false;
}

// Rôle demandé à la connexion : absent = admin (rétrocompatibilité),
// seuls "admin" et "referee" sont acceptés.
function resolveLoginRole(value) {
  if (value === undefined || value === null) return ROLE_ADMIN;
  if (value === ROLE_ADMIN || value === ROLE_REFEREE) return value;
  return null;
}

// Fichiers statiques autorisés (liste blanche : .git, .bin, data/, etc. ne sont JAMAIS servis)
const STATIC_ALLOWLIST = new Set([
  '/', '/index.html', '/admin.html', '/arbitre.html',
  '/app.js', '/qrcode.js', '/style.css'
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function tokenMatches(candidate, expected) {
  if (!candidate || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAdminRequest(req) {
  return tokenMatches(req.headers['x-admin-token'], EXPECTED_ADMIN_TOKEN);
}

function isRefereeRequest(req) {
  return tokenMatches(req.headers['x-referee-token'], EXPECTED_REFEREE_TOKEN);
}

// Jetons attendus par rôle (servis par POST /api/login)
function tokenForRole(role) {
  if (role === ROLE_REFEREE) return { token: EXPECTED_REFEREE_TOKEN, salt: REFEREE_SALT };
  if (role === ROLE_ADMIN) return { token: EXPECTED_ADMIN_TOKEN, salt: ADMIN_SALT };
  return null;
}

function sendJson(res, status, obj) {
  // Garde : ne jamais écrire des en-têtes sur une réponse déjà envoyée/détruite
  // (évite ERR_HTTP_HEADERS_SENT qui faisait crasher tout le processus).
  if (res.headersSent || res.writableEnded || res.destroyed) {
    try { if (!res.writableEnded) res.end(); } catch (e) {}
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Lecture du corps avec limite de taille + parse JSON sécurisé
function readJsonBody(req, res, onSuccess) {
  let body = '';
  let aborted = false;
  let responded = false;
  function respond(status, obj) {
    if (responded) return;
    responded = true;
    sendJson(res, status, obj);
  }
  req.on('data', chunk => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      aborted = true;
      // Arrêter de consommer et répondre une seule fois, sans détruire le socket
      // (req.destroy() détruisait aussi la réponse et provoquait des writes tardifs).
      req.removeAllListeners('data');
      req.resume(); // drainer silencieusement le reste
      respond(413, { error: 'Payload trop volumineux (max 2 Mo)' });
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      onSuccess(JSON.parse(body));
    } catch (e) {
      respond(400, { error: 'Format JSON invalide' });
    }
  });
  req.on('error', (e) => {
    if (aborted) return;
    if (e && e.code === 'ERR_STREAM_PREMATURE_CLOSE') return; // client parti : ne rien faire
    respond(400, { error: 'Lecture du corps interrompue' });
  });
}

// Écriture atomique de l'état (tmp + rename) pour éviter un fichier tronqué en cas de crash
function writeStateFile(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);
}

// Validation minimale de la forme de l'état (empêche qu'un POST vide n'efface tout)
function isValidTournamentState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const sports = state.sports;
  if (!sports || typeof sports !== 'object' || Array.isArray(sports)) return false;
  const ids = Object.keys(sports);
  if (ids.length === 0) return false;
  return ids.every(id => sports[id] && Array.isArray(sports[id].teams));
}

function sanitizeFlashInfo(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  return {
    active: Boolean(f.active),
    message: String(f.message || '').slice(0, 500),
    level: FLASH_LEVELS.has(f.level) ? f.level : 'urgent',
    timestamp: typeof f.timestamp === 'string' ? f.timestamp : new Date().toISOString()
  };
}

// Validation stricte de l'URL publique (scheme http/https uniquement)
function sanitizePublicUrl(val) {
  if (!val) return null;
  try {
    const u = new URL(String(val).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) {
    return null;
  }
}

// ============================================================================
// SANITISATION DES MATCHS EN DIRECT (périmètre du jeton arbitre)
// Un arbitre ne peut écrire QUE ces champs : tout le reste est reconstruit ici
// à partir d'une liste blanche, les champs inconnus sont jetés.
// ============================================================================
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sanitizeLiveMatch(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = (typeof raw.id === 'string' && MATCH_ID_RE.test(raw.id)) ? raw.id
    : (typeof fallbackId === 'string' && MATCH_ID_RE.test(fallbackId) ? fallbackId : null);
  if (!id) return null;

  const endsAt = Number(raw.timerEndsAt);
  const hasEndsAt = Number.isFinite(endsAt) && endsAt > 0;

  return {
    id,
    active: raw.active === true,
    title: String(raw.title == null ? '' : raw.title).slice(0, 80) || 'MATCH',
    teamAName: String(raw.teamAName == null ? '' : raw.teamAName).slice(0, 80) || 'Équipe A',
    teamAColor: HEX_COLOR_RE.test(String(raw.teamAColor || '')) ? String(raw.teamAColor) : '#ef4444',
    teamAFiliereId: FILIERE_ID_RE.test(String(raw.teamAFiliereId || '')) ? String(raw.teamAFiliereId) : '',
    scoreA: clampInt(raw.scoreA, 0, 9999, 0),
    teamBName: String(raw.teamBName == null ? '' : raw.teamBName).slice(0, 80) || 'Équipe B',
    teamBColor: HEX_COLOR_RE.test(String(raw.teamBColor || '')) ? String(raw.teamBColor) : '#2563eb',
    teamBFiliereId: FILIERE_ID_RE.test(String(raw.teamBFiliereId || '')) ? String(raw.teamBFiliereId) : '',
    scoreB: clampInt(raw.scoreB, 0, 9999, 0),
    timerMinutes: clampInt(raw.timerMinutes, 0, 180, 10),
    timerSeconds: clampInt(raw.timerSeconds, 0, 59, 0),
    // Un chrono "en marche" sans échéance serait impossible à afficher : on l'ignore
    timerRunning: raw.timerRunning === true && hasEndsAt,
    timerEndsAt: hasEndsAt ? Math.trunc(endsAt) : null,
    timerRemainingOnPause: clampInt(raw.timerRemainingOnPause, 0, 86400, 600),
    updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

function sanitizeLiveMatches(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_LIVE_MATCHES) return null;
  const result = {};
  for (const [key, value] of entries) {
    const clean = sanitizeLiveMatch(value, key);
    if (!clean) return null;
    result[clean.id] = clean;
  }
  return result;
}

// liveScore est un miroir du match projeté (rétrocompatibilité de l'affichage)
function deriveLiveScore(liveMatches, previousLiveScore) {
  const projected = Object.values(liveMatches).find(m => m.active);
  if (projected) return { ...projected };
  if (previousLiveScore && typeof previousLiveScore === 'object' && !Array.isArray(previousLiveScore)) {
    return { ...previousLiveScore, active: false };
  }
  return { active: false };
}

// S'assurer que le dossier data existe
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
    log('❌ Impossible de créer le dossier data/ :', e.message);
  }
}

// Dernier lastUpdated connu (chargé au boot, mis à jour à chaque écriture)
let lastSavedStateUpdated = null;
try {
  if (fs.existsSync(STATE_FILE)) {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (existing && typeof existing.lastUpdated === 'string') {
      lastSavedStateUpdated = existing.lastUpdated;
    }
  }
} catch (e) {
  log('⚠️  Fichier d\'état illisible au démarrage (ignoré) :', e.message);
}

// Refuse les écritures périmées (dernier arrivé, dernier servi)
function stateIsNewer(state) {
  const incoming = state && typeof state.lastUpdated === 'string' ? state.lastUpdated : null;
  if (lastSavedStateUpdated && incoming && incoming < lastSavedStateUpdated) return false;
  if (incoming) lastSavedStateUpdated = incoming;
  return true;
}

// Détection de l'adresse IP locale non interne (pour accès smartphone)
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  // Préférer les interfaces physiques (eth/wlan/en) aux VPN/tunnels (tun/tap/docker/vmnet)
  const preferred = /^(eth|en|wlan|wl|wifi)/i;
  const fallback = /^(tun|tap|docker|vmnet|utun|wg)/i;
  let fallbackAddr = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (preferred.test(name)) return iface.address;
        if (!fallback.test(name) && !fallbackAddr) fallbackAddr = iface.address;
      }
    }
  }
  return fallbackAddr || 'localhost';
}

const LOCAL_IP = getLocalIpAddress();

function getEffectiveMobileUrl() {
  if (PUBLIC_URL) {
    return PUBLIC_URL.replace(/\/+$/, '');
  }
  return `http://${LOCAL_IP}:${PORT}/index.html`;
}

// Clients connectés au flux temps réel (SSE)
const sseClients = new Set();

function broadcastEvent(type, payload) {
  const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Heartbeat SSE toutes les 20 secondes pour empêcher la coupure proxy/Cloudflare (timeout 100s)
const keepaliveTimer = setInterval(() => {
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(': keepalive\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 20000);
if (keepaliveTimer.unref) keepaliveTimer.unref();

// Types MIME pour les fichiers statiques
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Ne jamais laisser une erreur d'écriture (client déconnecté) crasher le processus
  res.on('error', () => {});
  // En-têtes de sécurité (pas de CORS wildcard : toutes les requêtes sont same-origin)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    // 'unsafe-inline' requis : l'appli repose sur des gestionnaires inline (onclick/onsubmit).
    // La protection XSS repose sur l'échappement systématique des données (escapeHtml/escapeJsString).
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'");

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Ne JAMAIS construire l'URL de base à partir de l'en-tête Host (contrôlé par le client) :
  // un Host malformé faisait planter tout le processus (TypeError non intercepté).
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Requête invalide');
    return;
  }

  // ==========================================================================
  // 1. ENDPOINTS D'API
  // ==========================================================================

  // Info réseau du serveur (lecture seule, publique)
  if (url.pathname === '/api/info' && req.method === 'GET') {
    sendJson(res, 200, {
      localIp: LOCAL_IP,
      port: PORT,
      publicUrl: PUBLIC_URL,
      mobileUrl: getEffectiveMobileUrl(),
      adminUrl: `http://${LOCAL_IP}:${PORT}/admin.html`,
      tunnelActive: Boolean(PUBLIC_URL)
    });
    return;
  }

  // Mise à jour dynamique de l'URL publique (admin authentifié uniquement)
  if (url.pathname === '/api/public-url' && req.method === 'POST') {
    if (!isAdminRequest(req)) {
      sendJson(res, 401, { error: 'Non autorisé' });
      return;
    }
    readJsonBody(req, res, (payload) => {
      if (payload.publicUrl === undefined) {
        sendJson(res, 400, { error: 'Champ publicUrl requis' });
        return;
      }
      const clean = sanitizePublicUrl(payload.publicUrl);
      if (payload.publicUrl && !clean) {
        sendJson(res, 400, { error: 'URL invalide (http/https uniquement)' });
        return;
      }
      PUBLIC_URL = clean;
      log('🔗 URL publique mise à jour :', PUBLIC_URL || '(désactivée)');
      broadcastEvent('TUNNEL_UPDATE', {
        publicUrl: PUBLIC_URL,
        mobileUrl: getEffectiveMobileUrl(),
        tunnelActive: Boolean(PUBLIC_URL)
      });
      sendJson(res, 200, {
        status: 'ok',
        publicUrl: PUBLIC_URL,
        mobileUrl: getEffectiveMobileUrl(),
        tunnelActive: Boolean(PUBLIC_URL)
      });
    });
    return;
  }

  // Lecture de l'état partagé (lecture seule, publique) — servi en JSON compact (~34 % plus léger)
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (fs.existsSync(STATE_FILE)) {
      try {
        res.end(JSON.stringify(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))));
        return;
      } catch (e) {
        log('❌ Erreur lecture état :', e.message);
      }
    }
    sendJson(res, 200, { error: "Aucun état enregistré" });
    return;
  }

  // Connexion (admin ou arbitre) : le serveur vérifie le mot de passe et renvoie
  // le jeton correspondant au rôle demandé. C'est la SEULE source de vérité.
  if (url.pathname === '/api/login' && req.method === 'POST') {
    readJsonBody(req, res, (payload) => {
      const role = resolveLoginRole(payload ? payload.role : undefined);
      if (!role) {
        sendJson(res, 400, { ok: false, error: 'Rôle invalide (admin ou referee)' });
        return;
      }
      if (loginRateLimited(role)) {
        sendJson(res, 429, { error: 'Trop de tentatives, réessayez dans une minute' });
        return;
      }
      const password = payload && typeof payload.password === 'string' ? payload.password : '';
      const expected = tokenForRole(role);
      const candidate = crypto.createHash('sha256').update(password + expected.salt).digest('hex');
      if (password && tokenMatches(candidate, expected.token)) {
        log(role === ROLE_REFEREE ? '🔓 Connexion arbitre réussie' : '🔓 Connexion admin réussie');
        sendJson(res, 200, { ok: true, token: expected.token, role });
      } else {
        sendJson(res, 401, { ok: false, error: 'Mot de passe incorrect' });
      }
    });
    return;
  }

  // Enregistrement de l'état partagé (admin authentifié uniquement)
  if (url.pathname === '/api/state' && req.method === 'POST') {
    if (!isAdminRequest(req)) {
      sendJson(res, 401, { error: 'Non autorisé' });
      return;
    }
    readJsonBody(req, res, (state) => {
      if (!isValidTournamentState(state)) {
        sendJson(res, 400, { error: 'État invalide (sports/teams manquants)' });
        return;
      }
      if (!stateIsNewer(state)) {
        sendJson(res, 409, { error: 'État périmé refusé (lastUpdated antérieur)' });
        return;
      }
      try {
        writeStateFile(state);
      } catch (e) {
        log('❌ Échec écriture état :', e.message);
        sendJson(res, 500, { error: "Échec d'enregistrement sur le disque" });
        return;
      }
      broadcastEvent('STATE_UPDATE', { state });
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // Mise à jour des matchs en direct (arbitre OU admin) : SEUL périmètre autorisé
  // au jeton arbitre. Le serveur relit son propre état et ne remplace que
  // liveMatches/liveScore : poules, phases finales et classements restent intacts.
  if (url.pathname === '/api/live-matches' && req.method === 'POST') {
    if (!isRefereeRequest(req) && !isAdminRequest(req)) {
      sendJson(res, 401, { error: 'Non autorisé' });
      return;
    }
    readJsonBody(req, res, (payload) => {
      const liveMatches = sanitizeLiveMatches(payload && payload.liveMatches);
      if (!liveMatches) {
        sendJson(res, 400, { error: 'liveMatches invalide (format ou nombre de matchs)' });
        return;
      }
      let state = null;
      try {
        if (fs.existsSync(STATE_FILE)) {
          state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
      } catch (e) {
        log('❌ Lecture état impossible pour fusion matchs :', e.message);
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        sendJson(res, 409, { error: "Aucun état de tournoi à mettre à jour" });
        return;
      }

      state.liveMatches = liveMatches;
      state.liveScore = deriveLiveScore(liveMatches, state.liveScore);
      state.lastUpdated = new Date().toISOString();

      try {
        writeStateFile(state);
      } catch (e) {
        log('❌ Échec écriture état (matchs en direct) :', e.message);
        sendJson(res, 500, { error: "Échec d'enregistrement sur le disque" });
        return;
      }
      // Protège le score saisi par l'arbitre d'un enregistrement admin déjà en vol
      lastSavedStateUpdated = state.lastUpdated;
      broadcastEvent('STATE_UPDATE', { state });
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // Flash Info direct (admin authentifié uniquement)
  if (url.pathname === '/api/flash' && req.method === 'POST') {
    if (!isAdminRequest(req)) {
      sendJson(res, 401, { error: 'Non autorisé' });
      return;
    }
    readJsonBody(req, res, (rawFlash) => {
      const flashInfo = sanitizeFlashInfo(rawFlash);
      if (!flashInfo) {
        sendJson(res, 400, { error: 'flashInfo invalide' });
        return;
      }
      // Persister le flashInfo dans STATE_FILE pour les clients qui se connectent ou rafraîchissent
      try {
        if (fs.existsSync(STATE_FILE)) {
          const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
          state.flashInfo = flashInfo;
          if (typeof state.lastUpdated === 'string') lastSavedStateUpdated = state.lastUpdated;
          writeStateFile(state);
          broadcastEvent('STATE_UPDATE', { state });
        }
      } catch (errPersist) {
        log('⚠️  Flash non persisté (sera quand même diffusé) :', errPersist.message);
      }

      broadcastEvent('FLASH_INFO', { flashInfo });
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // Flux SSE (Server-Sent Events) pour synchronisation temps réel (lecture seule, publique)
  if (url.pathname === '/api/events') {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { error: 'Trop de clients SSE connectés' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform', // no-transform empêche la compression/mise en mémoire tampon par Cloudflare
      'X-Accel-Buffering': 'no',                  // désactive la mise en mémoire tampon par les reverse proxies
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({
      type: 'CONNECTED',
      localIp: LOCAL_IP,
      publicUrl: PUBLIC_URL,
      mobileUrl: getEffectiveMobileUrl(),
      tunnelActive: Boolean(PUBLIC_URL)
    })}\n\n`);

    // Pousser immédiatement l'état initial s'il existe (pour les spectateurs 4G qui se connectent)
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        res.write(`data: ${JSON.stringify({ type: 'STATE_UPDATE', state })}\n\n`);
      } catch (e) {
        log('⚠️  État initial SSE non envoyé (JSON illisible) :', e.message);
      }
    }

    sseClients.add(res);
    // Un client qui se déconnecte brutalement ne doit jamais faire planter le processus
    res.on('error', () => sseClients.delete(res));
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ==========================================================================
  // 2. DISTRIBUTION DES FICHIERS STATIQUES (liste blanche uniquement)
  // ==========================================================================
  const pathname = url.pathname;
  if (!STATIC_ALLOWLIST.has(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fichier non trouvé');
    return;
  }

  let filePath = path.join(ROOT_DIR, pathname === '/' ? 'index.html' : pathname);

  // Sécurité traversée de dossier (résolution réelle + préfixe avec séparateur)
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== ROOT_DIR && !resolvedPath.startsWith(ROOT_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Accès interdit');
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier non trouvé');
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    // Les pages HTML restent fraîches ; les assets (js/css) sont mis en cache avec revalidation
    const isHtml = ext === '.html';
    const cacheControl = isHtml ? 'no-cache, must-revalidate' : 'public, max-age=60';
    const etag = `"${stats.size}-${Math.floor(stats.mtimeMs)}"`;

    // Revalidation conditionnelle : 304 si le client a déjà la bonne version
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified = (inm && inm === etag) ||
      (!inm && ims && Math.floor(new Date(ims).getTime() / 1000) >= Math.floor(stats.mtimeMs / 1000));
    if (!isHtml && notModified) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl });
      res.end();
      return;
    }

    // Compression gzip pour les assets texte (économie ~70 % sur le tunnel 4G)
    const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
    const compressible = ['.html', '.js', '.css', '.json', '.svg'].includes(ext);
    if (acceptsGzip && compressible && stats.size > 1024) {
      const zlib = require('zlib');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Encoding': 'gzip',
        'Cache-Control': cacheControl,
        'ETag': etag,
        'Vary': 'Accept-Encoding'
      });
      fs.createReadStream(resolvedPath).pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'ETag': etag,
        'Vary': 'Accept-Encoding'
      });
      fs.createReadStream(resolvedPath).pipe(res);
    }
  });
});

let tunnelProcess = null;

function initTunnel(port) {
  if (noTunnel) {
    log('ℹ️  Mode tunnel désactivé (--no-tunnel). Accès local uniquement.');
    return;
  }
  if (PUBLIC_URL) {
    log(`ℹ️  URL publique préconfigurée : ${PUBLIC_URL}`);
    return;
  }

  log('⏳ Recherche d\'un tunnel 4G public (Cloudflare Quick Tunnel)...');
  const binary = process.env.CLOUDFLARED_BIN || 'cloudflared';
  let resolved = false;

  try {
    tunnelProcess = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    log(`ℹ️  Binaire ${binary} non disponible (${err.message}). Repli local : http://${LOCAL_IP}:${port}`);
    return;
  }

  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.(trycloudflare\.com|a\.pinggy\.(link|online))/i;

  const onData = (chunk) => {
    const text = chunk.toString();
    const match = text.match(urlRegex);
    if (match && !resolved) {
      resolved = true;
      PUBLIC_URL = match[0].replace(/\/+$/, '');
      log('\n===============================================================');
      log('🚀 ACCÈS 4G PUBLIC ACTIVÉ SANS WI-FI !');
      log(`📱 URL Smartphone 4G : ${PUBLIC_URL}`);
      log('✨ Le QR code sur le vidéoprojecteur est désormais public !');
      log('===============================================================\n');
      broadcastEvent('TUNNEL_UPDATE', {
        publicUrl: PUBLIC_URL,
        mobileUrl: getEffectiveMobileUrl(),
        tunnelActive: true
      });
    }
  };

  if (tunnelProcess.stderr) tunnelProcess.stderr.on('data', onData);
  if (tunnelProcess.stdout) tunnelProcess.stdout.on('data', onData);

  tunnelProcess.on('error', (err) => {
    if (!resolved) {
      log(`ℹ️  Tunnel cloudflared non disponible (${err.message}). Repli local : http://${LOCAL_IP}:${port}`);
    }
  });

  // Détection de la mort du tunnel : le QR ne doit pas pointer vers une URL morte
  tunnelProcess.on('close', (code) => {
    if (resolved) {
      log(`⚠️  Le tunnel cloudflared s'est arrêté (code ${code}). Retour en mode réseau local.`);
      PUBLIC_URL = null;
      broadcastEvent('TUNNEL_UPDATE', {
        publicUrl: null,
        mobileUrl: getEffectiveMobileUrl(),
        tunnelActive: false
      });
    }
    tunnelProcess = null;
  });

  const timer = setTimeout(() => {
    if (!resolved) {
      log(`⏱️  Délai d'établissement du tunnel dépassé (10s). Repli sur IP locale : http://${LOCAL_IP}:${port}`);
    }
  }, 10000);
  if (timer.unref) timer.unref();

  const cleanup = () => {
    if (tunnelProcess) {
      try { tunnelProcess.kill('SIGINT'); } catch (e) {}
      tunnelProcess = null;
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} déjà utilisé. Relancez avec un autre port, ex : PORT=8090 node server.js (ou PORT=8090 ./start.sh)\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n===============================================================');
  console.log('🏆  SERVEUR DU TOURNOI INTER-PROMO (TIP) DÉMARRÉ AVEC SUCCÈS');
  console.log('===============================================================');
  console.log(`📡 Sur votre ordinateur :`);
  console.log(`   - Vidéoprojecteur : http://localhost:${PORT}/index.html`);
  console.log(`   - Administration  : http://localhost:${PORT}/admin.html`);
  console.log(`\n📱 Sur les smartphones :`);
  if (PUBLIC_URL) {
    console.log(`   - Accès 4G Public : ${PUBLIC_URL}`);
  } else {
    console.log(`   - Accès Direct    : http://${LOCAL_IP}:${PORT}/index.html`);
  }
  console.log(`\n✨ Le QR Code officiel s'affiche automatiquement sur le vidéoprojecteur !`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`\n⚠️  ADMIN_PASSWORD non défini : un mot de passe de DÉMONSTRATION est utilisé. Définissez ADMIN_PASSWORD=... au lancement.`);
    console.log(`   Pour sécuriser l'accès API (recommandé) : ADMIN_PASSWORD= votremotdepasse node server.js`);
  }
  if (!process.env.REFEREE_PASSWORD) {
    console.log(`⚠️  REFEREE_PASSWORD non défini : un mot de passe arbitre de DÉMONSTRATION est utilisé.`);
    console.log(`   Pour sécuriser l'accès arbitre (recommandé) : REFEREE_PASSWORD=votremotdepasse node server.js`);
  }
  console.log('===============================================================\n');

  initTunnel(PORT);
});

module.exports = { server, sseClients, broadcastEvent };
