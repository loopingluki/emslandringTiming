# emslandringTiming

**Vollständige Kartbahn-Zeitnahmesoftware** als Ersatz für die proprietäre MyLaps
Race Control Box. Läuft als Python-Dienst auf einem Ubuntu Mini-PC in der
Zeitnahme-Kabine.

---

## Aktueller Stand

**Stable:** `stable-2026-05-17`

### Features

- ⏱ **Echtzeit-Timing** für Training, Grand Prix (Zeit) und Grand Prix (Runden)
- 🌐 **Web-UI** im Browser — Operator, Pi-Dashboard, Mobile-Customer alle parallel
- 📊 **Bestenlisten** (Tag / Woche / Monat / Jahr) mit umschaltbarem Ranking-Modus
- 🖨 **Druck-Ausgabe** als professioneller PDF-Zettel pro Kart
- 🚦 **Ampel-Steuerung** über Devantech ETH008 Ethernet-Relay
- 📱 **QR-Code-Feature**: Customer scannt nach Top-8-Bestzeit, trägt seinen Namen ein
- 🛡 **Profanity-Filter** für Customer-Namen (DE-Wortliste, l33t-resistent)
- 🔍 **Defekt-Erkennung** pro Klasse (WMA + Ausreißer-Filter)
- 📡 **MyLaps ASCII Emulator** für die Kloft-Anzeigetafel
- 💾 **SQLite-Datenbank** mit automatischen Online-Backups

---

## Dokumentation

Vollständige Dokumentation im Ordner [`docs/`](docs/). Empfohlene Lesereihenfolge:

| Dokument | Inhalt |
|---|---|
| [`docs/01_HARDWARE.md`](docs/01_HARDWARE.md) | Hardware-Liste, Topologie, Stückliste |
| [`docs/02_INSTALL.md`](docs/02_INSTALL.md) | Komplette Erstinstallation Schritt für Schritt |
| [`docs/03_CONFIGURATION.md`](docs/03_CONFIGURATION.md) | Web-UI Tour, alle Settings dokumentiert |
| [`docs/04_OPERATIONS.md`](docs/04_OPERATIONS.md) | Tagesbetrieb, Logs, Backups, Service-Verwaltung |
| [`docs/05_TROUBLESHOOTING.md`](docs/05_TROUBLESHOOTING.md) | Bekannte Probleme und Lösungen |
| [`docs/06_ARCHITECTURE.md`](docs/06_ARCHITECTURE.md) | Code-Architektur (für Entwickler) |
| [`docs/07_MIGRATION.md`](docs/07_MIGRATION.md) | Backup-PC einrichten, Server-Migration |
| [`docs/08_PI_DASHBOARD.md`](docs/08_PI_DASHBOARD.md) | Raspberry Pi für Zuschauer-Dashboard |

**Wenn du das System gerade frisch aufsetzt:** Lies in genau dieser Reihenfolge.
Jede Datei ist self-contained — wenn du nur ein Problem hast, kannst du direkt zu
`05_TROUBLESHOOTING.md` springen.

---

## Schnellstart (Server läuft schon)

```
Operator-UI:        http://192.168.178.100:8081
Zuschauer-Dashboard: http://192.168.178.100:8081/dashboard
Customer-Mobile:    https://emslandring.tail2c13dd.ts.net/record/<token>
```

### Häufige Befehle (auf dem Ubuntu)

```bash
# Service-Status
sudo systemctl status emslandring-timing --no-pager | head -10

# Live-Logs
sudo journalctl -u emslandring-timing -f

# Service neu starten
sudo systemctl restart emslandring-timing

# Code-Update einspielen
cd ~/emslandring-repo && git pull && sudo systemctl restart emslandring-timing
```

---

## Projektstruktur

```
emslandringTiming/
├── README.md                     ← diese Datei
├── docs/                         ← komplette Doku
├── config.json                   ← Konfiguration (Hot-Reload)
├── requirements.txt              ← Python-Abhängigkeiten
│
├── server/
│   ├── main.py                   ← FastAPI-App, HTTP-Routen, WebSocket
│   ├── config.py                 ← Config-Loader
│   ├── database.py               ← SQLite-Schema + CRUD
│   ├── decoder.py                ← AMB P3 Decoder-Client
│   ├── race_engine.py            ← Zustandsmaschine Training/GP
│   ├── run_manager.py            ← Lauf-CRUD, Tages-Init
│   ├── emulator.py               ← MyLaps ASCII Server (Kloft)
│   ├── ws_hub.py                 ← WebSocket Broadcast
│   ├── printer.py                ← PDF-Druck (WeasyPrint+pypdf+CUPS)
│   ├── ampel.py                  ← Devantech ETH008
│   ├── profanity.py              ← Wortfilter
│   └── data/
│       ├── fonts/                ← TrueType-Schriftarten
│       ├── templates/            ← PDF-Druckvorlagen
│       ├── logo.png              ← Druck-Logo
│       └── profanity_de.txt      ← Wortliste
│
├── web/
│   ├── templates/
│   │   ├── index.html            ← Operator-UI
│   │   ├── dashboard.html        ← Zuschauer-Dashboard
│   │   └── record.html           ← Customer Mobile-Seite
│   └── static/
│       ├── app.js                ← Frontend-Logik
│       └── style.css             ← Dark Theme
│
└── emslandring.db                ← SQLite-Datenbank (wird auto-erstellt) ⚠ BACKUP!
```

---

## Tech-Stack

- **Python 3.12** + asyncio
- **FastAPI** + Uvicorn (HTTP + WebSocket)
- **SQLite** via aiosqlite
- **WeasyPrint** + pypdf (PDF-Druck)
- **segno** (QR-Code-Generierung)
- **Tailscale Funnel** (öffentlicher HTTPS-Tunnel, kostenlos)
- **CUPS** (Drucker-Verwaltung)

---

## Voraussetzungen für eine Installation

- 1× Ubuntu Mini-PC (≥ 4 GB RAM, ≥ 64 GB SSD)
- 1× MyLaps RC4 Decoder (im LAN auf statischer IP)
- 1× Drucker (USB oder Netzwerk)
- 1× LAN-Switch + Kabel
- _Optional:_ Devantech ETH008 + Ampel
- _Optional:_ Raspberry Pi für Zuschauer-Dashboard

Detaillierte Hardware-Liste: [`docs/01_HARDWARE.md`](docs/01_HARDWARE.md)

---

## Lizenz & Mitwirkende

Interne Eigenentwicklung für die Kartbahn Emslandring Dankern. Keine offizielle
Lizenz — Code-Zugriff nur durch berechtigte Personen.

---

## Changelog

### 2026-05-17 (`stable-2026-05-17`)

- **Feature:** QR-Code-Bestenliste — Customer scannt nach Rekord, trägt Namen ein
- **Feature:** Tailscale Funnel als kostenloser Internet-Tunnel (statt ngrok)
- **Feature:** Profanity-Filter für Customer-Namen
- **Feature:** Umschaltbarer Ranking-Modus (per_kart / per_run)
- **Fix:** Bestenliste auf Ausdruck nutzt jetzt Customer- und Lauf-Override-Namen
- **Fix:** Kart-Namen-Modal zeigt direkt nach Speichern die korrekten Werte

### 2026-05-11 (`stable-2026-05-11b`)

- **Feature:** Read-Only Zuschauer-Dashboard unter `/dashboard`
- **Feature:** Grand-Prix-Ausdruck mit Ranking-Tabelle statt Matrix
- **Feature:** Überlaufseiten für eigene Rundenzeiten bei > 20 Runden
- **Feature:** Tab-Titel-Countdown im Browser
- **Feature:** Robuste Defekt-Erkennung (Ausreißer-Filter vor WMA)

### 2026-05-05 (`stable-2026-05-05`)

- **Fix:** PDF-Pool auf `spawn`-Multiprocessing — verhindert gRPC-Crash beim Druck
- **Fix:** Hängengebliebene Läufe vom Vortag werden automatisch beendet
- **UI:** Kart-Tabelle alle Spalten linksbündig

### 2026-05-04 (`stable-2026-05-04`)

- **Feature:** ProcessPool-Render für parallelen Druck mehrerer Karts
- **Feature:** DB-Indizes für schnelle Defekt-Erkennung bei vielen Passings
- **Theme:** Druck-Theme: Kontrast angepasst (Dark)

### 2026-05-01 (`stable-2026-05-01`)

- **Initial Stable:** Basis-Funktion Training, GP, Druck, Live-UI, Emulator

---

*Bei Fragen / Anpassungen den ursprünglichen Entwickler kontaktieren oder einen
neuen Entwickler per Doku einlesen lassen.*
