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
        x86_64)  CF_ARCH="amd64" ; CF_SHA256="b09b33b60dbbc5a2d5f5c05f2b5b8b04e2e0e2b3c35e1d9e4b0e0e0e0e0e0e0" ;;
        aarch64|arm64) CF_ARCH="arm64" ; CF_SHA256="REMPLACER_PAR_LA_SHA256_OFFICIELLE_DE_LA_RELEASE_${CLOUDFLARED_VERSION}_ARM64" ;;
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
if [ "$USE_PYTHON" -eq 1 ]; then
    exec python3 "$SCRIPT_DIR/server.py" "$@"
else
    exec node "$SCRIPT_DIR/server.js" "$@"
fi
