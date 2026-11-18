#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SERVEUR LOCAL AUTONOME PYTHON - TOURNOI INTER-PROMO (TIP)
Zéro dépendance requise (utilise uniquement la bibliothèque standard Python 3).

Lancement :
  python3 server.py
ou depuis la racine :
  python3 tip/server.py

Options CLI :
  --port <port>          Port d'écoute (défaut : 8080 ou $PORT)
  --public-url <url>     URL publique 4G forcée (défaut : $PUBLIC_URL)
  --no-tunnel            Désactiver la recherche de tunnel

Variables d'environnement :
  ADMIN_PASSWORD         Mot de passe admin requis pour les écritures API
                         (défaut : voir DEFAULT_ADMIN_PASSWORD ci-dessous)
"""

import os
import sys
import json
import socket
import mimetypes
import hashlib
import hmac
import threading
import time
from urllib.parse import urlparse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# Analyse des arguments CLI et variables d'environnement
arg_port = None
arg_public_url = None
no_tunnel = '--no-tunnel' in sys.argv or os.environ.get('TUNNEL') == '0'

i = 1
while i < len(sys.argv):
    if sys.argv[i] == '--port' and i + 1 < len(sys.argv):
        try:
            arg_port = int(sys.argv[i + 1])
        except ValueError:
            pass
        i += 1
    elif sys.argv[i] == '--public-url' and i + 1 < len(sys.argv):
        arg_public_url = sys.argv[i + 1]
        i += 1
    i += 1

try:
    env_port = int(os.environ.get('PORT', 8080))
except ValueError:
    env_port = 8080
PORT = arg_port or env_port
PUBLIC_URL = arg_public_url or os.environ.get('PUBLIC_URL') or None
if PUBLIC_URL:
    PUBLIC_URL = PUBLIC_URL.rstrip('/')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'tournament_state.json')

# ============================================================================
# 🔒 SÉCURITÉ : jeton d'administration requis pour TOUTE écriture (POST /api/*)
# ============================================================================
# ⚠️ Mot de passe de DÉMONSTRATION uniquement si ADMIN_PASSWORD n'est pas défini.
# Toujours lancer en production avec : ADMIN_PASSWORD=... python3 server.py
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD') or 'CHANGE_ME_DEMO_PASSWORD'
EXPECTED_ADMIN_TOKEN = hashlib.sha256((ADMIN_PASSWORD + '_TIP_AUTH_OK').encode('utf-8')).hexdigest()
MAX_BODY_SIZE = 2 * 1024 * 1024  # 2 Mo max par requête POST
MAX_SSE_CLIENTS = 200
FLASH_LEVELS = {'urgent', 'info', 'call'}
# Rate limiting très léger sur /api/login (anti brute force basique)
LOGIN_WINDOW_MS = 60 * 1000
LOGIN_MAX_ATTEMPTS = 20
_login_attempts = []
_login_lock = threading.Lock()

def login_rate_limited():
    now = time.time() * 1000
    with _login_lock:
        while _login_attempts and now - _login_attempts[0] > LOGIN_WINDOW_MS:
            _login_attempts.pop(0)
        if len(_login_attempts) >= LOGIN_MAX_ATTEMPTS:
            return True
        _login_attempts.append(now)
        return False

# Fichiers statiques autorisés (liste blanche : .git, .bin, data/, etc. ne sont JAMAIS servis)
STATIC_ALLOWLIST = {
    '/', '/index.html', '/admin.html', '/arbitre.html',
    '/app.js', '/qrcode.js', '/style.css'
}

if not os.path.exists(DATA_DIR):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except Exception as e:
        print(f"❌ Impossible de créer le dossier data/ : {e}", file=sys.stderr)

def log(*args):
    import datetime
    print(datetime.datetime.now().isoformat(timespec='seconds'), *args, flush=True)

def is_admin_request(handler):
    token = handler.headers.get('X-Admin-Token', '')
    return hmac.compare_digest(token, EXPECTED_ADMIN_TOKEN)

def send_json(handler, status, obj):
    # Si les en-têtes sont déjà expédiés (double appel, client parti), ne rien faire
    if getattr(handler, '_headers_sent', False):
        return
    try:
        body = json.dumps(obj).encode('utf-8')
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json; charset=utf-8')
        handler.send_header('Content-Length', str(len(body)))
        handler.end_headers()
        handler._headers_sent = True
        handler.wfile.write(body)
    except Exception as e:
        handler._headers_sent = True
        log(f"⚠️  Réponse abandonnée (client parti ?) : {e}")

# Verrou global : toutes les lectures/écritures de l'état passent par lui
state_lock = threading.Lock()
last_saved_state_updated = None

def write_state_file(state):
    """Écriture atomique (tmp + os.replace) pour éviter un fichier tronqué."""
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)

def load_state_file():
    with open(STATE_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def is_valid_tournament_state(state):
    if not isinstance(state, dict):
        return False
    sports = state.get('sports')
    if not isinstance(sports, dict) or len(sports) == 0:
        return False
    return all(isinstance(sports[k], dict) and isinstance(sports[k].get('teams'), list)
               for k in sports)

def sanitize_flash_info(f):
    if not isinstance(f, dict):
        return None
    level = f.get('level')
    return {
        'active': bool(f.get('active')),
        'message': str(f.get('message', ''))[:500],
        'level': level if level in FLASH_LEVELS else 'urgent',
        'timestamp': f.get('timestamp') if isinstance(f.get('timestamp'), str) else time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    }

def sanitize_public_url(val):
    if not val:
        return None
    from urllib.parse import urlsplit
    try:
        u = urlsplit(str(val).strip())
        if u.scheme not in ('http', 'https') or not u.netloc:
            return None
        path_part = (u.path or '').rstrip('/')
        return f"{u.scheme}://{u.netloc}{path_part}"
    except Exception:
        return None

# Charger le dernier lastUpdated connu au démarrage
try:
    if os.path.exists(STATE_FILE):
        with state_lock:
            existing = load_state_file()
            if isinstance(existing.get('lastUpdated'), str):
                last_saved_state_updated = existing['lastUpdated']
except Exception as e:
    log(f"⚠️  Fichier d'état illisible au démarrage (ignoré) : {e}")

def get_local_ip():
    # Préférer la route par défaut, mais ignorer les interfaces VPN/tunnel
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        return ip
    except Exception:
        return 'localhost'
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass

LOCAL_IP = get_local_ip()

def get_effective_mobile_url():
    if PUBLIC_URL:
        return PUBLIC_URL.rstrip('/')
    return f"http://{LOCAL_IP}:{PORT}/index.html"

# Abonnés SSE
sse_subscribers = []
sse_lock = threading.Lock()

def broadcast_event(event_type, payload):
    msg = f"data: {json.dumps({'type': event_type, **payload})}\n\n".encode('utf-8')
    with sse_lock:
        snapshot = list(sse_subscribers)
    removals = []
    for wfile in snapshot:
        try:
            wfile.write(msg)
            wfile.flush()
        except Exception:
            removals.append(wfile)
    if removals:
        with sse_lock:
            for dead in removals:
                if dead in sse_subscribers:
                    sse_subscribers.remove(dead)

class TIPRequestHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self._headers_sent = False
        # En-têtes de sécurité (pas de CORS wildcard : toutes les requêtes sont same-origin)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        # 'unsafe-inline' requis : l'appli repose sur des gestionnaires inline (onclick/onsubmit).
        # La protection XSS repose sur l'échappement systématique des données (escapeHtml/escapeJsString).
        self.send_header('Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'")
        super().end_headers()

    def log_message(self, fmt, *args):
        log(f"{self.client_address[0]} {fmt % args}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def read_body(self):
        """Lit le corps avec limite de taille ; renvoie None si trop volumineux ou illisible.

        Renvoie la sentinelle '__ABORTED__' pour signaler 'lu mais déjà répondu'
        (pas utilisé ; gardé pour compatibilité)."""

        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return None
        if length < 0 or length > MAX_BODY_SIZE:
            return None
        try:
            return self.rfile.read(length).decode('utf-8')
        except Exception:
            # Client déconnecté pendant la lecture : ne rien planter
            return None

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/api/info':
            send_json(self, 200, {
                'localIp': LOCAL_IP,
                'port': PORT,
                'publicUrl': PUBLIC_URL,
                'mobileUrl': get_effective_mobile_url(),
                'adminUrl': f"http://{LOCAL_IP}:{PORT}/admin.html",
                'tunnelActive': bool(PUBLIC_URL)
            })
            return

        if path == '/api/state':
            with state_lock:
                if os.path.exists(STATE_FILE):
                    try:
                        # Servi en JSON compact (~34 % plus léger que le fichier pretty sur disque)
                        with open(STATE_FILE, 'r', encoding='utf-8') as f:
                            obj = json.load(f)
                        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json; charset=utf-8')
                        self.send_header('Content-Length', str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    except Exception as e:
                        log(f"❌ Erreur lecture état : {e}")
            send_json(self, 200, {"error": "Aucun état enregistré"})
            return

        if path == '/api/events':
            with sse_lock:
                can_accept = len(sse_subscribers) < MAX_SSE_CLIENTS
            if not can_accept:
                send_json(self, 503, {"error": "Trop de clients SSE connectés"})
                return
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache, no-transform')
                self.send_header('X-Accel-Buffering', 'no')
                self.send_header('Connection', 'keep-alive')
                self.end_headers()

                init_msg = f"retry: 3000\n\ndata: {json.dumps({'type': 'CONNECTED', 'localIp': LOCAL_IP, 'publicUrl': PUBLIC_URL, 'mobileUrl': get_effective_mobile_url(), 'tunnelActive': bool(PUBLIC_URL)})}\n\n".encode('utf-8')

                # Si un état existe, l'envoyer immédiatement au nouveau client
                with state_lock:
                    state_msg = None
                    if os.path.exists(STATE_FILE):
                        try:
                            state_obj = load_state_file()
                            state_msg = f"data: {json.dumps({'type': 'STATE_UPDATE', 'state': state_obj})}\n\n".encode('utf-8')
                        except Exception as e:
                            log(f"⚠️  État initial SSE non envoyé (JSON illisible) : {e}")

                self.wfile.write(init_msg)
                if state_msg:
                    self.wfile.write(state_msg)
                self.wfile.flush()

                with sse_lock:
                    sse_subscribers.append(self.wfile)

                # Boucle de maintien en vie (keepalive toutes les 15 secondes)
                while True:
                    time.sleep(15)
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except Exception:
                        raise
            except Exception:
                with sse_lock:
                    if self.wfile in sse_subscribers:
                        sse_subscribers.remove(self.wfile)
            return

        # Fichiers statiques : LISTE BLANCHE uniquement (.git, .bin, data/, etc. jamais servis)
        if path not in STATIC_ALLOWLIST:
            body = b"Fichier non trouv\xc3\xa9"
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == '/':
            path = '/index.html'

        # Sécurité traversée de dossier : realpath + commonpath (bloque ../ et les liens symboliques)
        full_path = os.path.realpath(os.path.join(ROOT_DIR, path.lstrip('/')))
        root_real = os.path.realpath(ROOT_DIR)
        if os.path.commonpath([full_path, root_real]) != root_real or not os.path.isfile(full_path):
            body = b"Fichier non trouv\xc3\xa9"
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        content_type, _ = mimetypes.guess_type(full_path)
        if not content_type:
            content_type = 'application/octet-stream'
        if content_type.startswith('text/') or content_type in ('application/javascript', 'application/json'):
            content_type += '; charset=utf-8'

        stat = os.stat(full_path)
        is_html = full_path.endswith('.html')
        etag = f'"{stat.st_size}-{int(stat.st_mtime)}"'
        cache_control = 'no-cache, must-revalidate' if is_html else 'public, max-age=60'

        # Revalidation conditionnelle : 304 si le client a déjà la bonne version
        inm = self.headers.get('If-None-Match')
        ims = self.headers.get('If-Modified-Since')
        not_modified = False
        if not is_html:
            if inm and inm == etag:
                not_modified = True
            elif not inm and ims:
                try:
                    import email.utils
                    ims_ts = email.utils.mktime_tz(email.utils.parsedate_tz(ims))
                    if int(ims_ts) >= int(stat.st_mtime):
                        not_modified = True
                except Exception:
                    pass
        if not_modified:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', cache_control)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        with open(full_path, 'rb') as f:
            data = f.read()

        # Compression gzip pour les assets texte (économie ~70 % sur le tunnel 4G)
        accepts_gzip = 'gzip' in (self.headers.get('Accept-Encoding') or '')
        ext = os.path.splitext(full_path)[1].lower()
        compressible = ext in ('.html', '.js', '.css', '.json', '.svg')
        if accepts_gzip and compressible and len(data) > 1024:
            import gzip as gzip_mod
            data = gzip_mod.compress(data, 6)
            encoding = 'gzip'
        else:
            encoding = None

        self.send_response(200)
        self.send_header('Content-Type', content_type)
        if encoding:
            self.send_header('Content-Encoding', encoding)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache_control)
        self.send_header('ETag', etag)
        self.send_header('Vary', 'Accept-Encoding')
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception as e:
            log(f"⚠️  Envoi interrompu (client parti ?) : {e}")

    def do_POST(self):
        global PUBLIC_URL, last_saved_state_updated
        parsed = urlparse(self.path)
        path = parsed.path

        # Connexion admin : le serveur vérifie le mot de passe et renvoie le jeton de session.
        if path == '/api/login':
            if login_rate_limited():
                send_json(self, 429, {"error": "Trop de tentatives, réessayez dans une minute"})
                return
            body = self.read_body()
            if body is None:
                send_json(self, 413, {"error": "Payload trop volumineux ou illisible (max 2 Mo)"})
                return
            try:
                payload = json.loads(body)
            except Exception:
                send_json(self, 400, {"error": "Format JSON invalide"})
                return
            password = payload.get('password') if isinstance(payload, dict) else None
            password = password if isinstance(password, str) else ''
            candidate = hashlib.sha256((password + '_TIP_AUTH_OK').encode('utf-8')).hexdigest()
            if password and hmac.compare_digest(candidate, EXPECTED_ADMIN_TOKEN):
                log("🔓 Connexion admin réussie")
                send_json(self, 200, {"ok": True, "token": EXPECTED_ADMIN_TOKEN})
            else:
                send_json(self, 401, {"ok": False, "error": "Mot de passe incorrect"})
            return

        # Toute autre écriture nécessite le jeton admin
        if not is_admin_request(self):
            send_json(self, 401, {"error": "Non autorisé"})
            return

        body = self.read_body()
        if body is None:
            send_json(self, 413, {"error": "Payload trop volumineux ou illisible (max 2 Mo)"})
            return

        if path == '/api/public-url':
            try:
                payload = json.loads(body)
            except Exception:
                send_json(self, 400, {"error": "Format JSON invalide"})
                return
            if 'publicUrl' not in payload:
                send_json(self, 400, {"error": "Champ publicUrl requis"})
                return
            val = payload.get('publicUrl')
            clean = sanitize_public_url(val)
            if val and not clean:
                send_json(self, 400, {"error": "URL invalide (http/https uniquement)"})
                return
            PUBLIC_URL = clean
            log(f"🔗 URL publique mise à jour : {PUBLIC_URL or '(désactivée)'}")
            broadcast_event('TUNNEL_UPDATE', {
                'publicUrl': PUBLIC_URL,
                'mobileUrl': get_effective_mobile_url(),
                'tunnelActive': bool(PUBLIC_URL)
            })
            send_json(self, 200, {
                'status': 'ok',
                'publicUrl': PUBLIC_URL,
                'mobileUrl': get_effective_mobile_url(),
                'tunnelActive': bool(PUBLIC_URL)
            })
            return

        if path == '/api/state':
            try:
                state = json.loads(body)
            except Exception:
                send_json(self, 400, {"error": "Format JSON invalide"})
                return
            if not is_valid_tournament_state(state):
                send_json(self, 400, {"error": "État invalide (sports/teams manquants)"})
                return
            with state_lock:
                incoming = state.get('lastUpdated') if isinstance(state.get('lastUpdated'), str) else None
                if last_saved_state_updated and incoming and incoming < last_saved_state_updated:
                    send_json(self, 409, {"error": "État périmé refusé (lastUpdated antérieur)"})
                    return
                if incoming:
                    last_saved_state_updated = incoming
                try:
                    write_state_file(state)
                except Exception as e:
                    log(f"❌ Échec écriture état : {e}")
                    send_json(self, 500, {"error": "Échec d'enregistrement sur le disque"})
                    return
            broadcast_event('STATE_UPDATE', {'state': state})
            send_json(self, 200, {"success": True})
            return

        if path == '/api/flash':
            try:
                flash_info = json.loads(body)
            except Exception:
                send_json(self, 400, {"error": "Format JSON invalide"})
                return
            flash_info = sanitize_flash_info(flash_info)
            if flash_info is None:
                send_json(self, 400, {"error": "flashInfo invalide"})
                return
            # Persister le flashInfo dans STATE_FILE pour les clients qui se connectent ou rafraîchissent
            with state_lock:
                try:
                    if os.path.exists(STATE_FILE):
                        st = load_state_file()
                        st['flashInfo'] = flash_info
                        write_state_file(st)
                        if isinstance(st.get('lastUpdated'), str):
                            last_saved_state_updated = st['lastUpdated']
                        broadcast_event('STATE_UPDATE', {'state': st})
                except Exception as e:
                    log(f"⚠️  Flash non persisté (sera quand même diffusé) : {e}")

            broadcast_event('FLASH_INFO', {'flashInfo': flash_info})
            send_json(self, 200, {"success": True})
            return

        send_json(self, 404, {"error": "Endpoint inconnu"})

def main():
    server_address = ('0.0.0.0', PORT)
    try:
        httpd = ThreadingHTTPServer(server_address, TIPRequestHandler)
    except OSError as e:
        if e.errno == 98:  # EADDRINUSE
            print(f"\n❌ Port {PORT} déjà utilisé. Relancez avec un autre port, ex : PORT=8090 python3 server.py (ou PORT=8090 ./start.sh)\n", file=sys.stderr)
            sys.exit(1)
        raise
    print("\n===============================================================")
    print("🏆  SERVEUR DU TOURNOI INTER-PROMO (TIP) DÉMARRÉ EN PYTHON 3")
    print("===============================================================")
    print(f"📡 Sur votre ordinateur :")
    print(f"   - Vidéoprojecteur : http://localhost:{PORT}/index.html")
    print(f"   - Administration  : http://localhost:{PORT}/admin.html")
    print(f"\n📱 Sur les smartphones :")
    if PUBLIC_URL:
        print(f"   - Accès 4G Public : {PUBLIC_URL}")
    else:
        print(f"   - Accès Direct    : http://{LOCAL_IP}:{PORT}/index.html")
    print("\n✨ Le QR Code officiel s'affiche automatiquement sur le vidéoprojecteur !")
    if not os.environ.get('ADMIN_PASSWORD'):
        print("\n⚠️  ADMIN_PASSWORD non défini : un mot de passe de DÉMONSTRATION est utilisé. Définissez ADMIN_PASSWORD=... au lancement.")
        print("   Pour sécuriser l'accès API (recommandé) : ADMIN_PASSWORD=votremotdepasse python3 server.py")
    print("===============================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur...")
        httpd.server_close()

if __name__ == '__main__':
    main()
