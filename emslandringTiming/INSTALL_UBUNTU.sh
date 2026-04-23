#!/bin/bash
# =============================================================================
# emslandringTiming – Ubuntu Installationsscript
# Getestet auf Ubuntu 20.04, 22.04, 24.04 LTS
# Ausführen als normaler User (sudo wird bei Bedarf angefordert)
# =============================================================================
set -e

# Das GitHub-Repo hat emslandringTiming/ als Unterordner:
#   repo root / emslandringTiming / server / main.py
REPO_DIR="$HOME/emslandring-repo"
APP_DIR="$REPO_DIR/emslandringTiming"
VENV="$APP_DIR/.venv"
SERVICE_NAME="emslandring-timing"

echo "======================================================"
echo " emslandringTiming – Installation"
echo "======================================================"

# ── 1. Python-Version ermitteln ───────────────────────────────────────────────
echo ""
echo "→ Python-Version prüfen..."

PYTHON_BIN=""
for v in 3.12 3.11; do
    if command -v python${v} &>/dev/null; then
        PYTHON_BIN="python${v}"
        break
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "→ Python 3.11 nicht gefunden – füge deadsnakes PPA hinzu..."
    sudo apt-get install -y software-properties-common -qq
    sudo add-apt-repository ppa:deadsnakes/ppa -y
    sudo apt-get update -qq
    sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
    PYTHON_BIN="python3.11"
fi

echo "✓ Verwende $PYTHON_BIN ($(${PYTHON_BIN} --version))"

# ── 2. System-Pakete ──────────────────────────────────────────────────────────
echo ""
echo "→ Systemabhängigkeiten installieren..."
sudo apt-get update -qq
sudo apt-get install -y \
    git curl \
    libpango-1.0-0 libpangoft2-1.0-0 \
    libcairo2 libgdk-pixbuf2.0-0 \
    libffi-dev shared-mime-info \
    cups python3-cups

echo "✓ System-Pakete installiert"

# ── 3. Repository holen ───────────────────────────────────────────────────────
echo ""
echo "→ Repository klonen / aktualisieren..."
if [ -d "$REPO_DIR/.git" ]; then
    cd "$REPO_DIR"
    git pull origin main
    echo "✓ Repository aktualisiert"
else
    # Alten fehlgeschlagenen Clone-Versuch aufräumen falls vorhanden
    rm -rf "$REPO_DIR"
    git clone https://github.com/loopingluki/emslandringTiming.git "$REPO_DIR"
    echo "✓ Repository geklont nach $REPO_DIR"
fi

echo "✓ App-Verzeichnis: $APP_DIR"
ls "$APP_DIR/requirements.txt" > /dev/null || { echo "FEHLER: requirements.txt nicht gefunden in $APP_DIR"; exit 1; }

# ── 4. Virtuelle Umgebung ─────────────────────────────────────────────────────
echo ""
echo "→ Python Virtual Environment einrichten ($PYTHON_BIN)..."
cd "$APP_DIR"

if [ ! -d "$VENV" ]; then
    $PYTHON_BIN -m venv "$VENV"
fi
source "$VENV/bin/activate"

echo "→ Python-Pakete installieren..."
pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install weasyprint pypdf -q

echo "✓ Python-Pakete installiert"
deactivate

# ── 5. Datenverzeichnisse anlegen ─────────────────────────────────────────────
mkdir -p "$APP_DIR/server/data/templates"
mkdir -p "$APP_DIR/server/data/fonts"

# ── 6. systemd Service ────────────────────────────────────────────────────────
echo ""
echo "→ systemd Service einrichten (Autostart bei Reboot aktiviert)..."

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=emslandringTiming – Kartbahn Zeitnahme
After=network.target cups.service
Wants=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$VENV/bin/python server/main.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
echo "✓ Service '$SERVICE_NAME' eingerichtet und für Autostart registriert"

# ── 7. CUPS Drucker-Berechtigung ──────────────────────────────────────────────
echo ""
echo "→ Drucker-Berechtigung für User $USER..."
sudo usermod -aG lpadmin "$USER" 2>/dev/null || true
echo "✓ User zur lpadmin-Gruppe hinzugefügt"

# ── 8. Alten fehlerhaften Clone aufräumen ─────────────────────────────────────
if [ -d "$HOME/emslandringTiming" ] && [ ! -f "$HOME/emslandringTiming/requirements.txt" ]; then
    echo "→ Alten fehlerhaften Clone entfernen (~./emslandringTiming)..."
    rm -rf "$HOME/emslandringTiming"
    echo "✓ Aufgeräumt"
fi

# ── 9. Fertig ─────────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "======================================================"
echo " Installation abgeschlossen!"
echo "======================================================"
echo ""
echo "App-Verzeichnis : $APP_DIR"
echo "Konfig-Datei    : $APP_DIR/config.json"
echo ""
echo "NÄCHSTE SCHRITTE:"
echo ""
echo "1. Firebase-Credentials kopieren (vom Mac aus):"
echo "   scp service-account.json $USER@${SERVER_IP}:${APP_DIR}/"
echo "   Dann in config.json eintragen:"
echo "   nano $APP_DIR/config.json"
echo "   → Zeile: \"firebase_credentials\": \"${APP_DIR}/service-account.json\""
echo ""
echo "2. Service starten:"
echo "   sudo systemctl start $SERVICE_NAME"
echo ""
echo "3. Logs live beobachten:"
echo "   sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "4. Im Browser öffnen:"
echo "   http://${SERVER_IP}:8080"
echo ""
echo "Autostart bei Reboot: bereits aktiviert (systemctl enable)"
echo "Test: sudo reboot  →  nach 30s: systemctl status $SERVICE_NAME"
echo ""
echo "Nützliche Befehle:"
echo "  sudo systemctl status  $SERVICE_NAME"
echo "  sudo systemctl restart $SERVICE_NAME"
echo "  sudo systemctl stop    $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo ""
