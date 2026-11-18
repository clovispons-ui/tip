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
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

// S'assurer que le dossier data existe
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// Détection de l'adresse IP locale non interne (pour accès smartphone)
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Filtrer les adresses IPv4 non internes
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
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
  // CORS pour faciliter le développement et l'accès réseau
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ==========================================================================
  // 1. ENDPOINTS D'API
  // ==========================================================================

  // Info réseau du serveur (IP, port, URL smartphone, statut 4G)
  if (url.pathname === '/api/info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      localIp: LOCAL_IP,
      port: PORT,
      publicUrl: PUBLIC_URL,
      mobileUrl: getEffectiveMobileUrl(),
      adminUrl: `http://${LOCAL_IP}:${PORT}/admin.html`,
      tunnelActive: Boolean(PUBLIC_URL)
    }));
    return;
  }

  // Mise à jour dynamique de l'URL publique (depuis un runner, script externe ou admin)
  if (url.pathname === '/api/public-url' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.publicUrl !== undefined) {
          PUBLIC_URL = payload.publicUrl ? payload.publicUrl.trim().replace(/\/+$/, '') : null;
          broadcastEvent('TUNNEL_UPDATE', {
            publicUrl: PUBLIC_URL,
            mobileUrl: getEffectiveMobileUrl(),
            tunnelActive: Boolean(PUBLIC_URL)
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            status: 'ok',
            publicUrl: PUBLIC_URL,
            mobileUrl: getEffectiveMobileUrl(),
            tunnelActive: Boolean(PUBLIC_URL)
          }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Champ publicUrl requis" }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Format JSON invalide" }));
      }
    });
    return;
  }

  // Lecture de l'état partagé
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (fs.existsSync(STATE_FILE)) {
      try {
        const data = fs.readFileSync(STATE_FILE, 'utf-8');
        res.end(data);
        return;
      } catch (e) {}
    }
    res.end(JSON.stringify({ error: "Aucun état enregistré" }));
    return;
  }

  // Enregistrement de l'état partagé (depuis l'admin)
  if (url.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
        broadcastEvent('STATE_UPDATE', { state });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Format JSON invalide" }));
      }
    });
    return;
  }

  // Flash Info direct
  if (url.pathname === '/api/flash' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const flashInfo = JSON.parse(body);
        // Persister le flashInfo dans STATE_FILE pour les clients qui se connectent ou rafraîchissent
        try {
          if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            const state = JSON.parse(raw);
            state.flashInfo = flashInfo;
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
            broadcastEvent('STATE_UPDATE', { state });
          }
        } catch (errPersist) {}

        broadcastEvent('FLASH_INFO', { flashInfo });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Format JSON invalide" }));
      }
    });
    return;
  }

  // Flux SSE (Server-Sent Events) pour synchronisation temps réel
  if (url.pathname === '/api/events') {
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
      } catch (e) {}
    }

    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // ==========================================================================
  // 2. DISTRIBUTION DES FICHIERS STATIQUES (HTML, CSS, JS)
  // ==========================================================================
  let filePath = path.join(ROOT_DIR, url.pathname === '/' ? 'index.html' : url.pathname);

  // Sécurité traversée de dossier
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Accès interdit');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier non trouvé');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

let tunnelProcess = null;

function initTunnel(port) {
  if (noTunnel) {
    console.log('ℹ️  Mode tunnel désactivé (--no-tunnel). Accès local uniquement.');
    return;
  }
  if (PUBLIC_URL) {
    console.log(`ℹ️  URL publique préconfigurée : ${PUBLIC_URL}`);
    return;
  }

  console.log('⏳ Recherche d\'un tunnel 4G public (Cloudflare Quick Tunnel)...');
  const binary = process.env.CLOUDFLARED_BIN || 'cloudflared';
  let resolved = false;

  try {
    tunnelProcess = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    console.log(`ℹ️  Binaire ${binary} non disponible (${err.message}). Repli local : http://${LOCAL_IP}:${port}`);
    return;
  }

  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.(trycloudflare\.com|a\.pinggy\.(link|online))/i;

  const onData = (chunk) => {
    const text = chunk.toString();
    const match = text.match(urlRegex);
    if (match && !resolved) {
      resolved = true;
      PUBLIC_URL = match[0].replace(/\/+$/, '');
      console.log('\n===============================================================');
      console.log('🚀 ACCÈS 4G PUBLIC ACTIVÉ SANS WI-FI !');
      console.log(`📱 URL Smartphone 4G : ${PUBLIC_URL}`);
      console.log('✨ Le QR code sur le vidéoprojecteur est désormais public !');
      console.log('===============================================================\n');
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
      console.log(`ℹ️  Tunnel cloudflared non disponible (${err.message}). Repli local : http://${LOCAL_IP}:${port}`);
    }
  });

  const timer = setTimeout(() => {
    if (!resolved) {
      console.log(`⏱️  Délai d'établissement du tunnel dépassé (10s). Repli sur IP locale : http://${LOCAL_IP}:${port}`);
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
  console.log('===============================================================\n');

  initTunnel(PORT);
});

module.exports = { server, sseClients, broadcastEvent };
