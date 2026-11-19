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
                         (défaut : mot de passe de DÉMONSTRATION, à remplacer)
  REFEREE_PASSWORD       Mot de passe arbitre (distinct de l'admin), autorise
                         uniquement l'écriture des matchs en direct
                         (/api/live-matches), jamais des poules/classements
"""

import os
import sys
import json
import re
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
# 🔒 SÉCURITÉ : deux jetons distincts, deux périmètres distincts.
#  - Jeton ADMIN   : POST /api/state, /api/flash, /api/public-url
#  - Jeton ARBITRE : POST /api/live-matches (matchs en direct uniquement)
# ============================================================================
# ⚠️ Mots de passe de DÉMONSTRATION uniquement si ADMIN_PASSWORD / REFEREE_PASSWORD
# ne sont pas définis.
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD') or 'CHANGE_ME_DEMO_PASSWORD'
EXPECTED_ADMIN_TOKEN = hashlib.sha256((ADMIN_PASSWORD + '_TIP_AUTH_OK').encode('utf-8')).hexdigest()
REFEREE_PASSWORD = os.environ.get('REFEREE_PASSWORD') or 'CHANGE_ME_DEMO_REFEREE'
EXPECTED_REFEREE_TOKEN = hashlib.sha256((REFEREE_PASSWORD + '_TIP_REFEREE_OK').encode('utf-8')).hexdigest()
ADMIN_SALT = '_TIP_AUTH_OK'
REFEREE_SALT = '_TIP_REFEREE_OK'
ROLE_ADMIN = 'admin'
ROLE_REFEREE = 'referee'
MAX_BODY_SIZE = 2 * 1024 * 1024  # 2 Mo max par requête POST
MAX_SSE_CLIENTS = 200
MAX_LIVE_MATCHES = 50
MATCH_ID_RE = re.compile(r'^match_[A-Za-z0-9_-]{1,64}$')
FILIERE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
FLASH_LEVELS = {'urgent', 'info', 'call'}
# Rate limiting très léger sur /api/login (anti brute force basique)
# Un compteur PAR RÔLE : une rafale ratée côté arbitre ne bloque pas l'admin.
LOGIN_WINDOW_MS = 60 * 1000
LOGIN_MAX_ATTEMPTS = 20
_login_attempts = {ROLE_ADMIN: [], ROLE_REFEREE: []}
_login_lock = threading.Lock()

def login_rate_limited(role):
    attempts = _login_attempts.get(role)
    if attempts is None:
        return True  # rôle inconnu : refus sans comptabiliser
    now = time.time() * 1000
    with _login_lock:
        while attempts and now - attempts[0] > LOGIN_WINDOW_MS:
            attempts.pop(0)
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            return True
        attempts.append(now)
        return False

def resolve_login_role(value):
    """Rôle demandé : absent = admin (rétrocompatibilité), sinon admin/referee."""
    if value is None:
        return ROLE_ADMIN
    if value in (ROLE_ADMIN, ROLE_REFEREE):
        return value
    return None

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

def now_iso():
    """Horodatage ISO 8601 UTC avec millisecondes (même format que JS toISOString)."""
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + f'.{int(time.time() * 1000) % 1000:03d}Z'

def is_admin_request(handler):
    token = handler.headers.get('X-Admin-Token', '')
    return hmac.compare_digest(token, EXPECTED_ADMIN_TOKEN)

def is_referee_request(handler):
    token = handler.headers.get('X-Referee-Token', '')
    return hmac.compare_digest(token, EXPECTED_REFEREE_TOKEN)

def token_for_role(role):
    if role == ROLE_REFEREE:
        return EXPECTED_REFEREE_TOKEN, REFEREE_SALT
    if role == ROLE_ADMIN:
        return EXPECTED_ADMIN_TOKEN, ADMIN_SALT
    return None

def clamp_int(value, minimum, maximum, fallback):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, n))

def sanitize_live_match(raw, fallback_id=None):
    """Reconstruit un match depuis une liste blanche de champs (aucun champ inconnu)."""
    if not isinstance(raw, dict):
        return None
    match_id = raw.get('id')
    if not (isinstance(match_id, str) and MATCH_ID_RE.match(match_id)):
        match_id = fallback_id if isinstance(fallback_id, str) and MATCH_ID_RE.match(fallback_id) else None
    if not match_id:
        return None

    ends_at = raw.get('timerEndsAt')
    try:
        ends_at = int(ends_at)
        has_ends_at = ends_at > 0
    except (TypeError, ValueError):
        has_ends_at = False

    def text(key, fallback, limit=80):
        val = raw.get(key)
        val = str(val)[:limit] if val is not None else ''
        return val or fallback

    def color(key, fallback):
        val = raw.get(key)
        return val if isinstance(val, str) and HEX_COLOR_RE.match(val) else fallback

    def filiere(key):
        val = raw.get(key)
        return val if isinstance(val, str) and FILIERE_ID_RE.match(val) else ''

    return {
        'id': match_id,
        'active': raw.get('active') is True,
        'title': text('title', 'MATCH'),
        'teamAName': text('teamAName', 'Équipe A'),
        'teamAColor': color('teamAColor', '#ef4444'),
        'teamAFiliereId': filiere('teamAFiliereId'),
        'scoreA': clamp_int(raw.get('scoreA'), 0, 9999, 0),
        'teamBName': text('teamBName', 'Équipe B'),
        'teamBColor': color('teamBColor', '#2563eb'),
        'teamBFiliereId': filiere('teamBFiliereId'),
        'scoreB': clamp_int(raw.get('scoreB'), 0, 9999, 0),
        'timerMinutes': clamp_int(raw.get('timerMinutes'), 0, 180, 10),
        'timerSeconds': clamp_int(raw.get('timerSeconds'), 0, 59, 0),
        'timerRunning': raw.get('timerRunning') is True and has_ends_at,
        'timerEndsAt': ends_at if has_ends_at else None,
        'timerRemainingOnPause': clamp_int(raw.get('timerRemainingOnPause'), 0, 86400, 600),
        'updatedAt': clamp_int(raw.get('updatedAt'), 0, 2**53 - 1, int(time.time() * 1000)),
    }

def sanitize_live_matches(raw):
    if not isinstance(raw, dict):
        return None
    if len(raw) == 0 or len(raw) > MAX_LIVE_MATCHES:
        return None
    result = {}
    for key, value in raw.items():
        clean = sanitize_live_match(value, key)
        if clean is None:
            return None
        result[clean['id']] = clean
    return result

def derive_live_score(live_matches, previous_live_score):
    for match in live_matches.values():
        if match.get('active'):
            return dict(match)
    if isinstance(previous_live_score, dict):
        copy = dict(previous_live_score)
        copy['active'] = False
        return copy
    return {'active': False}

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

        # Connexion (admin ou arbitre) : le serveur vérifie le mot de passe et renvoie
        # le jeton correspondant au rôle demandé.
        if path == '/api/login':
            body = self.read_body()
            if body is None:
                send_json(self, 413, {"error": "Payload trop volumineux ou illisible (max 2 Mo)"})
                return
            try:
                payload = json.loads(body)
            except Exception:
                send_json(self, 400, {"error": "Format JSON invalide"})
                return
            role = resolve_login_role(payload.get('role') if isinstance(payload, dict) else None)
            if role is None:
                send_json(self, 400, {"ok": False, "error": "Rôle invalide (admin ou referee)"})
                return
            if login_rate_limited(role):
                send_json(self, 429, {"error": "Trop de tentatives, réessayez dans une minute"})
                return
            password = payload.get('password') if isinstance(payload, dict) else None
            password = password if isinstance(password, str) else ''
            expected_token, salt = token_for_role(role)
            candidate = hashlib.sha256((password + salt).encode('utf-8')).hexdigest()
            if password and hmac.compare_digest(candidate, expected_token):
                log("🔓 Connexion arbitre réussie" if role == ROLE_REFEREE else "🔓 Connexion admin réussie")
                send_json(self, 200, {"ok": True, "token": expected_token, "role": role})
            else:
                send_json(self, 401, {"ok": False, "error": "Mot de passe incorrect"})
            return

        # Mise à jour des matchs en direct (arbitre OU admin) : SEUL périmètre du
        # jeton arbitre. Seuls liveMatches/liveScore sont remplacés.
        if path == '/api/live-matches':
            if not (is_referee_request(self) or is_admin_request(self)):
                send_json(self, 401, {"error": "Non autorisé"})
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
            live_matches = sanitize_live_matches(payload.get('liveMatches') if isinstance(payload, dict) else None)
            if live_matches is None:
                send_json(self, 400, {"error": "liveMatches invalide (format ou nombre de matchs)"})
                return
            with state_lock:
                if not os.path.exists(STATE_FILE):
                    send_json(self, 409, {"error": "Aucun état de tournoi à mettre à jour"})
                    return
                try:
                    state = load_state_file()
                except Exception as e:
                    log(f"❌ Lecture état impossible pour fusion matchs : {e}")
                    send_json(self, 500, {"error": "Lecture de l'état impossible"})
                    return
                if not isinstance(state, dict):
                    send_json(self, 409, {"error": "Aucun état de tournoi à mettre à jour"})
                    return
                state['liveMatches'] = live_matches
                state['liveScore'] = derive_live_score(live_matches, state.get('liveScore'))
                state['lastUpdated'] = now_iso()
                try:
                    write_state_file(state)
                except Exception as e:
                    log(f"❌ Échec écriture état (matchs en direct) : {e}")
                    send_json(self, 500, {"error": "Échec d'enregistrement sur le disque"})
                    return
                # Protège le score de l'arbitre d'un enregistrement admin déjà en vol
                last_saved_state_updated = state['lastUpdated']
            broadcast_event('STATE_UPDATE', {'state': state})
            send_json(self, 200, {"success": True})
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
    if not os.environ.get('REFEREE_PASSWORD'):
        print("⚠️  REFEREE_PASSWORD non défini : un mot de passe arbitre de DÉMONSTRATION est utilisé.")
        print("   Pour sécuriser l'accès arbitre (recommandé) : REFEREE_PASSWORD=votremotdepasse python3 server.py")
    print("===============================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur...")
        httpd.server_close()

if __name__ == '__main__':
    main()
