#!/usr/bin/env bash
# ==============================================================================
# SCRIPT DE LANCEMENT EN UN CLIC - TOURNOI INTER-FILIÈRES (TIP)
# Démarre le serveur local et le tunnel 4G public pour l'accès smartphone
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==============================================================="
echo "🏆  LANCEMENT DU TOURNOI INTER-FILIÈRES (TIP)"
echo "==============================================================="

# 1. Vérification de l'environnement d'exécution (Node.js ou Python 3)
USE_PYTHON=0
if command -v node >/dev/null 2>&1; then
    RUNTIME="node"
elif command -v python3 >/dev/null 2>&1; then
    RUNTIME="python3"
    USE_PYTHON=1
else
    echo "❌ Erreur : Ni Node.js ni Python 3 ne sont installés sur cette machine."
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
    # Tenter un téléchargement automatique rapide si connecté à Internet
    mkdir -p "$BIN_DIR"
    echo "⏳ Recherche du binaire Cloudflare Tunnel (cloudflared)..."
    if command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 2 -I https://github.com >/dev/null 2>&1; then
        echo "📥 Téléchargement de cloudflared (outil gratuit officiel Cloudflare)..."
        if curl -sL --connect-timeout 5 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$LOCAL_CLOUDFLARED" && chmod +x "$LOCAL_CLOUDFLARED"; then
            echo "✔ cloudflared téléchargé avec succès dans .bin/cloudflared."
            export CLOUDFLARED_BIN="$LOCAL_CLOUDFLARED"
        else
            echo "ℹ️  Téléchargement non disponible. Le serveur utilisera le repli automatique sur réseau local."
        fi
    else
        echo "ℹ️  cloudflared non présent localement. Le serveur démarrera en mode local avec repli automatique."
    fi
fi

echo ""
echo "🚀 Démarrage du serveur TIP..."
echo "---------------------------------------------------------------"

# 3. Lancement du serveur selon l'environnement disponible
if [ "$USE_PYTHON" -eq 1 ]; then
    exec python3 "$SCRIPT_DIR/server.py" "$@"
else
    exec node "$SCRIPT_DIR/server.js" "$@"
fi
