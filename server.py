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
"""

import os
import sys
import json
import socket
import mimetypes
from urllib.parse import urlparse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import threading
import time

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

PORT = arg_port or int(os.environ.get('PORT', 8080))
PUBLIC_URL = arg_public_url or os.environ.get('PUBLIC_URL') or None
if PUBLIC_URL:
    PUBLIC_URL = PUBLIC_URL.rstrip('/')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'tournament_state.json')

if not os.path.exists(DATA_DIR):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except Exception:
        pass

def get_local_ip():
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
        removals = []
        for wfile in sse_subscribers:
            try:
                wfile.write(msg)
                wfile.flush()
            except Exception:
                removals.append(wfile)
        for dead in removals:
            if dead in sse_subscribers:
                sse_subscribers.remove(dead)

class TIPRequestHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/api/info':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            data = {
                'localIp': LOCAL_IP,
                'port': PORT,
                'publicUrl': PUBLIC_URL,
                'mobileUrl': get_effective_mobile_url(),
                'adminUrl': f"http://{LOCAL_IP}:{PORT}/admin.html",
                'tunnelActive': bool(PUBLIC_URL)
            }
            self.wfile.write(json.dumps(data).encode('utf-8'))
            return

        if path == '/api/state':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            if os.path.exists(STATE_FILE):
                try:
                    with open(STATE_FILE, 'r', encoding='utf-8') as f:
                        self.wfile.write(f.read().encode('utf-8'))
                        return
                except Exception:
                    pass
            self.wfile.write('{"error": "Aucun état enregistré"}'.encode('utf-8'))
            return

        if path == '/api/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache, no-transform')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()

            init_msg = f"retry: 3000\n\ndata: {json.dumps({'type': 'CONNECTED', 'localIp': LOCAL_IP, 'publicUrl': PUBLIC_URL, 'mobileUrl': get_effective_mobile_url(), 'tunnelActive': bool(PUBLIC_URL)})}\n\n".encode('utf-8')
            try:
                self.wfile.write(init_msg)
                # Si un état existe, l'envoyer immédiatement au nouveau client
                if os.path.exists(STATE_FILE):
                    try:
                        with open(STATE_FILE, 'r', encoding='utf-8') as f:
                            state_obj = json.load(f)
                            state_msg = f"data: {json.dumps({'type': 'STATE_UPDATE', 'state': state_obj})}\n\n".encode('utf-8')
                            self.wfile.write(state_msg)
                    except Exception:
                        pass
                self.wfile.flush()

                with sse_lock:
                    sse_subscribers.append(self.wfile)

                # Boucle de maintien en vie (keepalive toutes les 15 secondes)
                while True:
                    time.sleep(15)
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except Exception:
                with sse_lock:
                    if self.wfile in sse_subscribers:
                        sse_subscribers.remove(self.wfile)
            return

        # Fichiers statiques
        if path == '/':
            path = '/index.html'

        safe_path = os.path.normpath(path.lstrip('/'))
        full_path = os.path.join(ROOT_DIR, safe_path)

        if not full_path.startswith(ROOT_DIR) or not os.path.isfile(full_path):
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write("Fichier non trouvé".encode('utf-8'))
            return

        content_type, _ = mimetypes.guess_type(full_path)
        if not content_type:
            content_type = 'application/octet-stream'
        if content_type.startswith('text/') or content_type == 'application/javascript':
            content_type += '; charset=utf-8'

        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        self.end_headers()

        with open(full_path, 'rb') as f:
            self.wfile.write(f.read())

    def do_POST(self):
        global PUBLIC_URL
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')

        if path == '/api/public-url':
            try:
                payload = json.loads(body)
                if 'publicUrl' in payload:
                    val = payload.get('publicUrl')
                    PUBLIC_URL = val.strip().rstrip('/') if val else None
                    broadcast_event('TUNNEL_UPDATE', {
                        'publicUrl': PUBLIC_URL,
                        'mobileUrl': get_effective_mobile_url(),
                        'tunnelActive': bool(PUBLIC_URL)
                    })
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    resp = {
                        'status': 'ok',
                        'publicUrl': PUBLIC_URL,
                        'mobileUrl': get_effective_mobile_url(),
                        'tunnelActive': bool(PUBLIC_URL)
                    }
                    self.wfile.write(json.dumps(resp).encode('utf-8'))
                    return
                self.send_response(400)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"error": "Champ publicUrl requis"}')
            except Exception:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"error": "Format invalide"}')
            return

        if path == '/api/state':
            try:
                state = json.loads(body)
                with open(STATE_FILE, 'w', encoding='utf-8') as f:
                    json.dump(state, f, indent=2, ensure_ascii=False)
                broadcast_event('STATE_UPDATE', {'state': state})
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"success": true}')
            except Exception:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Format invalide"}')
            return

        if path == '/api/flash':
            try:
                flash_info = json.loads(body)
                try:
                    if os.path.exists(STATE_FILE):
                        with open(STATE_FILE, 'r', encoding='utf-8') as f:
                            st = json.load(f)
                        st['flashInfo'] = flash_info
                        with open(STATE_FILE, 'w', encoding='utf-8') as f:
                            json.dump(st, f, indent=2, ensure_ascii=False)
                        broadcast_event('STATE_UPDATE', {'state': st})
                except Exception:
                    pass
                broadcast_event('FLASH_INFO', {'flashInfo': flash_info})
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"success": true}')
            except Exception:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Format invalide"}')
            return

        self.send_response(404)
        self.end_headers()

def main():
    server_address = ('0.0.0.0', PORT)
    httpd = ThreadingHTTPServer(server_address, TIPRequestHandler)
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
    print("===============================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur...")
        httpd.server_close()

if __name__ == '__main__':
    main()
