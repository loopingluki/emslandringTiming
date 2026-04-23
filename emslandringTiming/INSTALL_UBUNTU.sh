#!/bin/bash
# =============================================================================
# emslandringTiming – Ubuntu Installationsscript
# Getestet auf Ubuntu 22.04 LTS
# Ausführen als normaler User (sudo wird bei Bedarf angefordert)
# =============================================================================
set -e

APP_DIR="$HOME/emslandringTiming"
VENV="$APP_DIR/.venv"
SERVICE_NAME="emslandring-timing"

echo "======================================================"
echo " emslandringTiming – Installation"
echo "======================================================"

# ── 1. System-Pakete ──────────────────────────────────────────────────────────
echo ""
echo "→ Systemabhängigkeiten installieren..."
sudo apt-get update -qq
sudo apt-get install -y \
    python3.11 python3.11-venv python3.11-dev \
    git curl \
    libpango-1.0-0 libpangoft2-1.0-0 \
    libcairo2 libgdk-pixbuf2.0-0 \
    libffi-dev shared-mime-info \
    cups python3-cups

echo "✓ System-Pakete installiert"

# ── 2. Repository holen ───────────────────────────────────────────────────────
echo ""
echo "→ Repository klonen / aktualisieren..."
if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR"
    git pull origin main
    echo "✓ Repository aktualisiert"
else
    git clone https://github.com/loopingluki/emslandringTiming.git "$APP_DIR"
    echo "✓ Repository geklont nach $APP_DIR"
fi

cd "$APP_DIR"

# ── 3. Virtuelle Umgebung ──────────────────────────────────────────────────────
echo ""
echo "→ Python Virtual Environment einrichten..."
if [ ! -d "$VENV" ]; then
    python3.11 -m venv "$VENV"
fi
source "$VENV/bin/activate"

echo "→ Python-Pakete installieren..."
pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install weasyprint pypdf -q

echo "✓ Python-Pakete installiert"
deactivate

# ── 4. Datenbank-Verzeichnis anlegen ──────────────────────────────────────────
mkdir -p "$APP_DIR/server/data/templates"
mkdir -p "$APP_DIR/server/data/fonts"

# ── 5. systemd Service ────────────────────────────────────────────────────────
echo ""
echo "→ systemd Service einrichten..."

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=emslandringTiming – Kartbahn Zeitnahme
After=network.target cups.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$VENV/bin/python server/main.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Umgebungsvariablen
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
echo "✓ Service $SERVICE_NAME eingerichtet"

# ── 6. CUPS Drucker-Berechtigung ──────────────────────────────────────────────
echo ""
echo "→ Drucker-Berechtigung für User $USER..."
sudo usermod -aG lpadmin "$USER" 2>/dev/null || true
echo "✓ User zur lpadmin-Gruppe hinzugefügt"

# ── 7. Fertig ─────────────────────────────────────────────────────────────────
echo ""
echo "======================================================"
echo " Installation abgeschlossen!"
echo "======================================================"
echo ""
echo "NÄCHSTE SCHRITTE:"
echo ""
echo "1. Firebase-Credentials kopieren (falls vorhanden):"
echo "   scp service-account.json ubuntu@<IP>:~/emslandringTiming/"
echo "   Dann in config.json eintragen:"
echo '   "firebase_credentials": "/home/ubuntu/emslandringTiming/service-account.json"'
echo ""
echo "2. Service starten:"
echo "   sudo systemctl start $SERVICE_NAME"
echo ""
echo "3. Logs beobachten:"
echo "   sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "4. Im Browser öffnen:"
echo "   http://localhost:8080"
echo "   oder vom Netzwerk: http://$(hostname -I | awk '{print $1}'):8080"
echo ""
echo "Nützliche Befehle:"
echo "  sudo systemctl status $SERVICE_NAME    # Status"
echo "  sudo systemctl restart $SERVICE_NAME   # Neustart"
echo "  sudo systemctl stop $SERVICE_NAME      # Stoppen"
echo ""
