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
 *                          (défaut : voir DEFAULT_ADMIN_PASSWORD ci-dessous,
 *                           à remplacer impérativement via cette variable)
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
// 🔒 SÉCURITÉ : jeton d'administration requis pour TOUTE écriture (POST /api/*)
// Le client calcule sha256(motDePasse + "_TIP_AUTH_OK") à la connexion admin
// (voir admin.html) et l'envoie dans l'en-tête X-Admin-Token.
// ============================================================================
// ⚠️ Mot de passe de DÉMONSTRATION uniquement si ADMIN_PASSWORD n'est pas défini.
// Toujours lancer en production avec : ADMIN_PASSWORD=... node server.js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE_ME_DEMO_PASSWORD';
const EXPECTED_ADMIN_TOKEN = crypto.createHash('sha256')
  .update(ADMIN_PASSWORD + '_TIP_AUTH_OK')
  .digest('hex');
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2 Mo max par requête POST
const MAX_SSE_CLIENTS = 200;
const FLASH_LEVELS = new Set(['urgent', 'info', 'call']);
// Rate limiting très léger sur /api/login (anti brute force basique)
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const loginAttempts = []; // timestamps des tentatives récentes

function loginRateLimited() {
  const now = Date.now();
  while (loginAttempts.length && now - loginAttempts[0] > LOGIN_WINDOW_MS) loginAttempts.shift();
  if (loginAttempts.length >= LOGIN_MAX_ATTEMPTS) return true;
  loginAttempts.push(now);
  return false;
}

// Fichiers statiques autorisés (liste blanche : .git, .bin, data/, etc. ne sont JAMAIS servis)
const STATIC_ALLOWLIST = new Set([
  '/', '/index.html', '/admin.html', '/arbitre.html',
  '/app.js', '/qrcode.js', '/style.css'
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isAdminRequest(req) {
  const token = req.headers['x-admin-token'];
  if (!token || typeof token !== 'string') return false;
  const a = Buffer.from(token, 'utf-8');
  const b = Buffer.from(EXPECTED_ADMIN_TOKEN, 'utf-8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Lecture du corps avec limite de taille + parse JSON sécurisé
function readJsonBody(req, res, onSuccess) {
  let body = '';
  let aborted = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) {
      sendJson(res, 413, { error: 'Payload trop volumineux (max 2 Mo)' });
      return;
    }
    try {
      onSuccess(JSON.parse(body));
    } catch (e) {
      sendJson(res, 400, { error: 'Format JSON invalide' });
    }
  });
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'Lecture du corps interrompue' });
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

  // Connexion admin : le serveur vérifie le mot de passe et renvoie le jeton de session.
  // C'est la SEULE source de vérité du mot de passe (plus de hash côté client).
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (loginRateLimited()) {
      sendJson(res, 429, { error: 'Trop de tentatives, réessayez dans une minute' });
      return;
    }
    readJsonBody(req, res, (payload) => {
      const password = payload && typeof payload.password === 'string' ? payload.password : '';
      const candidate = crypto.createHash('sha256').update(password + '_TIP_AUTH_OK').digest('hex');
      const a = Buffer.from(candidate, 'utf-8');
      const b = Buffer.from(EXPECTED_ADMIN_TOKEN, 'utf-8');
      if (password && a.length === b.length && crypto.timingSafeEqual(a, b)) {
        log('🔓 Connexion admin réussie');
        sendJson(res, 200, { ok: true, token: EXPECTED_ADMIN_TOKEN });
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
  console.log('===============================================================\n');

  initTunnel(PORT);
});

module.exports = { server, sseClients, broadcastEvent };
