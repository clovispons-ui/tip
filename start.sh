#!/usr/bin/env bash
# ==============================================================================
# SCRIPT DE LANCEMENT EN UN CLIC - TOURNOI INTER-FILIÈRES (TIP)
# Démarre le serveur local et le tunnel 4G public pour l'accès smartphone
#
# Usage :
#   ./start.sh              (ou ./start.sh start)  -> démarre le serveur
#   ./start.sh stop                                   -> arrête le serveur
#   ./start.sh restart                                -> redémarre
#   ./start.sh status                                 -> état du serveur
#   ./start.sh --no-tunnel                            -> démarre sans tunnel 4G
#
# Variables d'environnement (transmises au serveur) :
#   ADMIN_PASSWORD       Mot de passe administrateur (écritures complètes)
#   REFEREE_PASSWORD     Mot de passe arbitre (matchs en direct uniquement)
# Exemple :
#   ADMIN_PASSWORD=... REFEREE_PASSWORD=... ./start.sh
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.tip-server.pid"

# ------------------------------------------------------------------------------
# Utilitaires de gestion du processus
# ------------------------------------------------------------------------------

# Vrai si $1 est le PID d'un serveur TIP lancé depuis ce dossier
is_tip_server_pid() {
    local pid="$1"
    [ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "$SCRIPT_DIR/server\.\(js\|py\)"
}

server_pid() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if is_tip_server_pid "$pid"; then
            echo "$pid"
            return 0
        fi
    fi
    # Repli : chercher dans la table des processus (pidfile absent ou périmé)
    pgrep -f "$SCRIPT_DIR/server\.\(js\|py\)" 2>/dev/null | head -n 1
}

cmd_stop() {
    local pid
    pid="$(server_pid || true)"
    if [ -z "$pid" ]; then
        echo "ℹ️  Aucun serveur TIP en cours d'exécution."
        rm -f "$PID_FILE"
        return 0
    fi
    echo "🛑 Arrêt du serveur TIP (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    # Attendre l'arrêt propre (max ~5s), puis forcer si nécessaire
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        is_tip_server_pid "$pid" || break
        sleep 0.5
    done
    if is_tip_server_pid "$pid"; then
        echo "⚠️  Le processus ne s'arrête pas, envoi de SIGKILL..."
        kill -9 "$pid" 2>/dev/null || true
    fi
    # Nettoyer un éventuel cloudflared restant lié à ce serveur
    pkill -f "cloudflared tunnel --url http://127.0.0.1" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "✔ Serveur arrêté."
}

cmd_status() {
    local pid
    pid="$(server_pid || true)"
    if [ -n "$pid" ]; then
        echo "✔ Serveur TIP en cours d'exécution (PID $pid) : http://localhost:${PORT:-8080}/index.html"
    else
        echo "ℹ️  Serveur TIP arrêté."
        return 1
    fi
}

# Sous-commande éventuelle en premier argument
CMD="${1:-start}"
case "$CMD" in
    stop)    cmd_stop;    exit 0 ;;
    status)  cmd_status;  exit 0 ;;
    restart) cmd_stop || true; shift; ;;
    start)   shift ;;
    *)       # pas une sous-commande : tout est transmis au serveur (ex: --no-tunnel)
             ;;
esac

echo "==============================================================="
echo "🏆  LANCEMENT DU TOURNOI INTER-FILIÈRES (TIP)"
echo "==============================================================="

# 1. Vérification de l'environnement d'exécution (Node.js ou Python 3)
USE_PYTHON=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo "⚠️  Node.js v18+ requis (version détectée : $(node --version 2>/dev/null)). Tentative avec Python 3..."
    else
        RUNTIME="node"
    fi
fi
if [ -z "$RUNTIME" ] && command -v python3 >/dev/null 2>&1; then
    RUNTIME="python3"
    USE_PYTHON=1
fi
if [ -z "$RUNTIME" ]; then
    echo "❌ Erreur : Ni Node.js (v18+) ni Python 3 ne sont installés sur cette machine."
    echo "   Veuillez installer Node.js (v18+) ou Python 3 pour exécuter le TIP."
    exit 1
fi

echo "✔ Environnement d'exécution : $RUNTIME ($($RUNTIME --version 2>/dev/null || true))"

# 2. Vérification et préparation du binaire Cloudflare Tunnel (cloudflared)
BIN_DIR="$SCRIPT_DIR/.bin"
LOCAL_CLOUDFLARED="$BIN_DIR/cloudflared"

if command -v cloudflared >/dev/null 2>&1; then
    echo "✔ Binaire cloudflared détecté dans le PATH système."
elif [ -x "$LOCAL_CLOUDFLARED" ]; then
    echo "✔ Binaire cloudflared autonome détecté dans .bin/cloudflared."
    export CLOUDFLARED_BIN="$LOCAL_CLOUDFLARED"
else
    # Tenter un téléchargement épinglé et vérifié (version + empreinte SHA-256 officielle)
    # si connecté à Internet. Sans correspondance exacte, AUCUN binaire n'est exécuté.
    CLOUDFLARED_VERSION="2024.12.2"
    case "$(uname -m)" in
        x86_64)  CF_ARCH="amd64" ; CF_SHA256="5237675a5e806120729acc78c5be02f9db5f406717699587abfa72b49b39fe40" ;;
        aarch64|arm64) CF_ARCH="arm64" ; CF_SHA256="a80f7f014f568e53b2d75f449255bf737d6833e809de6c4103aad0adc83f56fc" ;;
        *) CF_ARCH="" ;;
    esac
    mkdir -p "$BIN_DIR"
    if [ -n "$CF_ARCH" ] && command -v curl >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 \
       && curl -s --connect-timeout 2 --max-time 5 -I https://github.com >/dev/null 2>&1; then
        echo "⏳ Recherche du binaire Cloudflare Tunnel (cloudflared v${CLOUDFLARED_VERSION}, ${CF_ARCH})..."
        DL_URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CF_ARCH}"
        if curl -sL --connect-timeout 5 --max-time 60 "$DL_URL" -o "$LOCAL_CLOUDFLARED" \
           && echo "${CF_SHA256}  $LOCAL_CLOUDFLARED" | sha256sum -c - >/dev/null 2>&1; then
            chmod +x "$LOCAL_CLOUDFLARED"
            echo "✔ cloudflared v${CLOUDFLARED_VERSION} téléchargé et vérifié (SHA-256) dans .bin/cloudflared."
            export CLOUDFLARED_BIN="$LOCAL_CLOUDFLARED"
        else
            echo "ℹ️  Téléchargement ou vérification SHA-256 échoué : aucun binaire téléchargé ne sera exécuté."
            echo "    Le serveur démarrera en mode local (réseau du gymnase) avec repli automatique."
            rm -f "$LOCAL_CLOUDFLARED"
        fi
    else
        echo "ℹ️  cloudflared non présent localement (ou arch non supportée / pas de sha256sum)."
        echo "    Le serveur démarrera en mode local avec repli automatique."
    fi
fi

echo ""
echo "🚀 Démarrage du serveur TIP..."
echo "---------------------------------------------------------------"

# 3. Lancement du serveur selon l'environnement disponible
# On écrit le PID juste avant exec : exec conserve le PID, donc le pidfile
# désigne fiableMENT le processus serveur pour ./start.sh stop/status.
echo $$ > "$PID_FILE"
if [ "$USE_PYTHON" -eq 1 ]; then
    exec python3 "$SCRIPT_DIR/server.py" "$@"
else
    exec node "$SCRIPT_DIR/server.js" "$@"
fi
