# emslandringTiming

**Version 1.0** – Eigenentwicklung zur Ablösung der proprietären MyLaps Race Control Box Software für die Kartbahn Emslandring.

---

## Überblick

`emslandringTiming` ist eine vollständige Zeitnahme-Software, die als Python-Dienst auf dem Ubuntu Mini PC in der Zeitnahme-Kabine läuft. Sie liest Decoder-Signale direkt vom MyLaps RC4 Decoder über das AMB P3 Binärprotokoll und stellt die Zeitergebnisse über eine moderne Web-Oberfläche bereit.

### Funktionsumfang (Version 1.0)

- **Echtzeit-Timing** für Training und Grand Prix (Zeit- und Runden-Modus)
- **WebSocket-basierte Live-Anzeige** im Browser (Timing-UI im Kabinen-PC, Dashboard auf Raspberry Pi)
- **MyLaps ASCII-Emulator** – sendet Ergebnisse ans Kloft-Anzeigesystem (RS485-Bridge)
- **PDF-Ausdruck** für jeden Kart: Rundenzeiten, Bestenliste, Rundenzeit-Chart, Vergleichsmatrix
- **SQLite-Datenbank** – automatische Datenspeicherung, keine manuelle Aktion nötig
- **Konfiguration per JSON** – Hot-Reload ohne Neustart
- **Transponder-Verwaltung** direkt in der Web-UI

---

## Netzwerk & Hardware

```
MyLaps RC4 Decoder          192.168.178.193:5403    (AMB P3 Binärprotokoll, TCP)
Ubuntu Mini PC (Server)     192.168.178.x:8080      (HTTP + WebSocket)
Kabinen-Browser             http://localhost:8080
Raspberry Pi Dashboard      http://ubuntu:8080/dashboard.html
Windows PC (Kloft-Bridge)   TCP → RS485 → Kloft-Anzeige (Port 50000)
```

---

## Projektstruktur

```
emslandringTiming/
├── config.json                  # Zentrale Konfiguration (Hot-Reload)
├── requirements.txt             # Python-Abhängigkeiten
├── README.md                    # Diese Datei
│
├── server/
│   ├── main.py                  # FastAPI-App, HTTP-Routen, WebSocket-Endpoint
│   ├── config.py                # Konfiguration laden/speichern + Transponder-Zugriff
│   ├── database.py              # SQLite-Schema + CRUD-Funktionen (aiosqlite)
│   ├── decoder.py               # AMB P3 async TCP-Client (Decoder-Anbindung)
│   ├── run_manager.py           # Lauf-Verwaltung + Tages-Initialisierung
│   ├── race_engine.py           # Zustandsmaschine Training + Grand Prix
│   ├── emulator.py              # MyLaps ASCII TCP-Server (Kloft-Kompatibilität)
│   ├── ws_hub.py                # WebSocket Broadcast-Hub
│   ├── printer.py               # PDF-Ausdruck via WeasyPrint + pypdf
│   │
│   └── data/
│       ├── timing.db            # SQLite-Datenbank (wird automatisch erstellt)
│       ├── logo.png             # Emslandring-Logo für Ausdrucke
│       ├── fonts/               # GeomGraphic + Lato Schriftarten für WeasyPrint
│       └── templates/
│           └── training.pdf     # PDF-Druckvorlage (Training)
│
├── web/
│   ├── templates/
│   │   └── index.html           # SPA-Shell + alle View-Templates
│   └── static/
│       ├── app.js               # Frontend-Logik (Timing, Einstellungen, Transponder)
│       └── style.css            # Dark Theme
│
└── kloft-bridge/
    └── kloft_bridge.py          # (Phase 2: Windows RS485-Bridge)
```

---

## Installation (Ubuntu)

### 1. Voraussetzungen

```bash
# Python 3.11+
sudo apt update
sudo apt install python3.11 python3.11-venv python3.11-dev

# WeasyPrint-Systemabhängigkeiten
sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf2.0-0 \
                 libffi-dev shared-mime-info

# CUPS-Druckunterstützung (für PDF-Ausdruck an Netzwerkdrucker)
sudo apt install cups python3-cups
```

### 2. Virtuelle Umgebung & Pakete

```bash
cd emslandringTiming
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install weasyprint pypdf cups   # Zusatzpakete für Druck
```

`requirements.txt`:
```
fastapi>=0.110.0
uvicorn[standard]>=0.27.0
aiosqlite>=0.20.0
```

### 3. Konfiguration

`config.json` im Projektordner anpassen:

```json
{
  "decoder_ip":              "192.168.178.193",
  "decoder_port":            5403,
  "http_port":               8080,
  "emulator_port":           50000,
  "runs_per_day":            10,
  "training_duration_sec":   420,
  "gp_time_duration_sec":    720,
  "gp_laps_count":           15,
  "wait_time_sec":           60,
  "wait_time_gp_sec":        60,
  "printer":                 "Kyocera_ECOSYS_PA2100cwx",
  "classes": [ ... ],
  "transponders": {
    "8534580": { "kart_nr": 1, "name": "Kart 1", "class": "Minikart" },
    ...
  }
}
```

Alle Einstellungen können auch über die Web-UI unter **Einstellungen** geändert werden. Änderungen werden sofort ohne Neustart wirksam.

### 4. Autostart als systemd-Dienst

```bash
sudo nano /etc/systemd/system/emslandring-timing.service
```

```ini
[Unit]
Description=emslandringTiming
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/emslandringTiming
ExecStart=/home/ubuntu/emslandringTiming/.venv/bin/python server/main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable emslandring-timing
sudo systemctl start emslandring-timing
```

### 5. Manueller Start (Entwicklung/Test)

```bash
cd emslandringTiming
source .venv/bin/activate
python server/main.py
```

Browser: `http://localhost:8080`

---

## Programmablauf & Skripte

### Startsequenz

```
python server/main.py
    │
    ├── FastAPI lifespan startet
    │     ├── database.init_db()         → SQLite-Schema erstellen (falls neu)
    │     ├── run_manager.ensure_today_runs()  → Tages-Läufe anlegen (falls fehlend)
    │     ├── decoder.start()            → AMB P3 TCP-Client starten
    │     ├── emulator.start()           → MyLaps ASCII TCP-Server starten
    │     └── race_engine initialisiert
    │
    └── uvicorn lauscht auf Port 8080
```

---

### `main.py` – FastAPI-App & Routing

Zentraler Einstiegspunkt. Bindet alle Komponenten zusammen:

- **HTTP-Routen** (`GET /`, `/dashboard`, `/print/{run_id}` usw.)
- **WebSocket-Endpoint** `ws://host:8080/ws` – verbindet Browser mit `ws_hub`
- **REST-API** für alle UI-Aktionen:
  - `GET  /api/runs?date=YYYY-MM-DD`        → Läufe eines Tages
  - `POST /api/runs`                         → Lauf hinzufügen
  - `GET  /api/run/{id}`                     → Lauf-Details mit Kart-Tabelle
  - `POST /api/run/{id}/arm`                 → Lauf scharf schalten
  - `POST /api/run/{id}/start`               → Lauf starten (GP) / Arm setzen (Training)
  - `POST /api/run/{id}/pause`               → Pause
  - `POST /api/run/{id}/resume`              → Fortsetzen
  - `POST /api/run/{id}/stop`                → Lauf beenden
  - `POST /api/run/{id}/settings`            → Lauf-Einstellungen (Modus, Zeit, Name)
  - `GET  /api/run/{id}/print`               → PDF drucken (an CUPS-Drucker)
  - `GET  /api/run/{id}/preview`             → HTML-Vorschau im Browser
  - `GET  /api/config`                        → Konfiguration lesen
  - `POST /api/config`                        → Konfiguration speichern
  - `GET  /api/transponders`                  → Transponder-Liste
  - `GET  /api/decoder`                       → Decoder-Status

---

### `config.py` – Konfiguration

Lädt `config.json` beim Start und bei jeder Änderung automatisch neu (mtime-Check). Stellt bereit:

- `cfg.get()` → aktuelles Config-Dict
- `cfg.get_kart_name(transponder_id)` → Kart-Name aus Transponder-ID
- `cfg.save(new_config)` → Config-Datei schreiben

Die Transponder-Map ordnet jeder Transponder-ID eine Kart-Nummer, einen Namen und eine Klasse zu.

---

### `database.py` – SQLite-Datenbank

Alle Zeitnahme-Daten werden persistent in `server/data/timing.db` gespeichert.

**Schema:**

| Tabelle | Inhalt |
|---------|--------|
| `runs` | Läufe: Datum, Nummer, Name, Modus, Dauer, Status, Zeitstempel |
| `passings` | Durchfahrten: Lauf-ID, Transponder, Kart-Nr, Zeitstempel (µs), Rundenzeit, Signalstärke |
| `run_kart_names` | Kart-Namen pro Lauf (überschreibbar in der UI) |
| `decoder_health` | Heartbeat-Daten: Rauschen, Loop-Signal (alle 60 s eingetragen) |

Alle Datenbankoperationen sind async (`aiosqlite`), blockieren das Event-Loop nicht.

---

### `decoder.py` – AMB P3 Decoder-Client

Stellt die Verbindung zum MyLaps RC4 Decoder (TCP, Port 5403) her und dekodiert das AMB P3 Binärprotokoll.

**Ablauf:**

```
decoder.start(ip, port)
    → asyncio.Task: _run()
        loop:
            _connect_and_read()
                ├── TCP-Verbindung aufbauen (Timeout: 10 s)
                ├── Pakete einlesen + descape() + parse_packet()
                ├── HEARTBEAT → connected=True, on_heartbeat() aufrufen
                └── PASSING   → on_passing() aufrufen
            bei Fehler oder Timeout: 3 s warten, neu verbinden
```

**Wichtige Details:**
- `connected=True` wird erst beim ersten HEARTBEAT-Paket gesetzt, **nicht** beim TCP-Connect
- `HEARTBEAT_TIMEOUT = 15 s`: Kommt 15 s kein Daten vom Decoder → Verbindung als tot werten, neu verbinden
- `descape()` entfernt AMB-spezifisches Byte-Stuffing (Escape-Sequenz `0x8D`)
- Heartbeats werden alle 60 s in `decoder_health` geschrieben

---

### `race_engine.py` – Zustandsmaschine

Verwaltet den Zustand jedes Laufs und verarbeitet eingehende Durchfahrten.

**Zustände:**

```
pending → armed → running → paused → finishing → done
                ↑                  ↑
          (erster PASSING     (Timer = 0  oder
           bei Training)       Stop-Button)
```

**Training-Modus:**
- Lauf scharf schalten → `armed`
- Erstes PASSING eines beliebigen Karts → `running`, Timer startet
- Timer läuft ab → `finishing` (Karts können noch eine letzte Runde fahren)
- `wait_time_sec` abgelaufen oder alle Karts eingekommen → `done`

**Grand Prix (Zeit):**
- Lauf scharf schalten → `armed`
- "Rennen starten"-Button → `running`, Timer startet, `$F GREEN` ans Kloft-System
- Timer läuft ab → `finishing`
- Führendes Kart passiert Lichtschranke → `done`, `$F FINISH` + `$C`

**Grand Prix (Runden):**
- Identisch zu GP-Zeit, aber Abbruch-Bedingung: Führendes Kart erreicht `gp_laps` Runden

**Timer-Task:** Dekrementiert `remaining_sec` jede Sekunde. Sendet `timer_tick` per WebSocket. Bei Pause wird der Task angehalten.

**Lap-Berechnung:** Erste Durchfahrt eines Karts im Lauf → kein `lap_time_us` (= Einführungsrunde). Jede weitere Durchfahrt → `lap_time_us = timestamp_us - vorherige_timestamp_us`.

---

### `ws_hub.py` – WebSocket Hub

Broadcastet Ereignisse an alle verbundenen Browser.

**Nachrichten-Typen:**

| Typ | Beschreibung |
|-----|-------------|
| `snapshot` | Vollständiger Zustand beim Verbindungsaufbau (Run, Karts, Decoder, Läufe) |
| `run_state` | Lauf-Status, verbleibende Zeit, Elapsed |
| `run_list` | Aktualisierte Lauf-Liste (linke Sidebar) |
| `kart_table` | Vollständige Kart-Tabelle (nach jedem PASSING neu sortiert) |
| `passing` | Einzelnes PASSING (für Flash-Animation im UI) |
| `decoder_health` | Decoder verbunden/getrennt, Rauschen, Loop-Signal |
| `timer_tick` | Jede Sekunde während `running` |

Neue Clients erhalten sofort einen `snapshot` des aktuellen Zustands.

---

### `emulator.py` – MyLaps ASCII Emulator

TCP-Server (Port 50000), der das ASCII-Protokoll der MyLaps Race Control Box emuliert. Kompatibel mit der Kloft-Bridge und dem bestehenden RS485-Anzeigesystem.

**Gesendete Nachrichten:**

```
$B  {run_id}  {group_name}         → Lauf-Start (z.B. "Gruppe 3" oder "RACE")
$A  {run_id}  {kart_nr}            → Kart erstmals gesehen
$H  {kart_nr}  {best_lap}          → Beste Rundenzeit (MM:SS.mmm)
$G  {kart_nr}  {laps}  {last_lap}  → Aktuelle Runde + letzte Zeit
$F  9999  GREEN  00:00:00          → Start-Signal
$F  9999  FINISH 00:00:00          → Ziel-Signal
$C  12  {run_id}                   → Lauf abgeschlossen
```

---

### `run_manager.py` – Lauf-Verwaltung

- `ensure_today_runs()`: Prüft beim Start und beim ersten Tagesaufruf, ob Läufe für heute in der DB vorhanden sind. Falls nicht → `runs_per_day` neue Läufe mit Status `pending` anlegen. Löst auch das Problem beim Tageswechsel (Server läuft über Mitternacht).
- `get_runs(date_str)`: Läufe für ein Datum laden + Klassen-Infos anreichern (für Sidebar-Farbcodierung)
- `add_run(date_str)`: Weiteren Lauf am Ende des Tages hinzufügen
- `get_run_with_karts(run_id)`: Lauf-Details + berechnete Kart-Tabelle (Positionen, Bestzeiten, Trends)

---

### `printer.py` – PDF-Ausdruck

Erstellt professionelle Ergebniszettel als PDF und sendet sie direkt an den Netzwerkdrucker (CUPS).

**Ablauf:**

```
print_run(run_id, kart_nr=None)
    ├── Daten aus DB laden (Lauf, Passings, Bestenliste)
    ├── HTML-Overlay generieren (_build_overlay_html)
    │     ├── Kart-Nummer (GeomGraphic, groß)
    │     ├── Klasse + Position
    │     ├── Rundenzeiten-Liste (mehrspältig)
    │     ├── Rundenzeit-Chart (SVG)
    │     ├── Vergleichsmatrix aller Karts
    │     └── Jahres-Bestenliste pro Klasse
    ├── WeasyPrint: HTML → PDF (transparent)
    ├── pypdf: Overlay auf Druckvorlage (training.pdf) legen
    └── CUPS: PDF an Drucker senden
```

**Besonderheiten:**
- Schriftarten: GeomGraphic (Kart-Nummer, Überschriften), Lato (Tabellen)
- Fonts werden für WeasyPrint über `file://`-URLs geladen, für den Browser über `/fonts/` HTTP-Route
- Bei Pfaden mit Nicht-ASCII-Zeichen (z.B. `OneDrive-Persönlich`) werden Fonts in `/tmp/ems_fonts_cache` kopiert
- Matrix-Schriftgröße passt sich dynamisch an: ≤10 Karts → größere Schrift; >10 Karts → kleinere Schrift
- Überlaufseite: Ab 16 Runden wird eine zweite Seite mit allen weiteren Runden gedruckt

**Druck-Vorschau:** `GET /api/run/{id}/preview` rendert den HTML-Overlay im Browser (mit `/fonts/` HTTP-URLs), sodass das Layout vor dem Ausdruck geprüft werden kann.

---

### `web/static/app.js` – Frontend

Single-Page-Application ohne Framework. Kommuniziert per:
- **WebSocket** (`/ws`) für Echtzeit-Updates
- **REST-API** für Aktionen (Start, Stop, Einstellungen)

**Views:**
- **Timing-Seite** (Standard): Linke Sidebar mit Lauf-Liste + Datum-Navigation, rechts Kart-Tabelle mit Positionen, Rundenzeiten, Fortschrittsbalken, Trend-Pfeilen
- **Einstellungen**: Tabs für Allgemein, Hardware, Drucker, Klassen
- **Transponder-Verwaltung**: Alle konfigurierten Transponder mit Kart-Nummer, Klasse, letzter Signalstärke

---

## Bedienung

### Lauf starten (Training)

1. Lauf in der linken Sidebar auswählen
2. **"Scharf schalten"** → Lauf wechselt zu `armed` (gelbes Blinken)
3. Erstes Kart passiert die Lichtschranke → Timer startet automatisch
4. Timer läuft ab → Finishing-Phase, Karts können letzte Runde fahren
5. Lauf endet automatisch nach `wait_time_sec`

### Lauf starten (Grand Prix)

1. Lauf-Einstellungen öffnen (Rechtsklick auf Lauf) → Modus auf "Grand Prix Zeit" oder "Grand Prix Runden"
2. **"Scharf schalten"** → `armed`
3. **"Rennen starten"** → `running`, alle Karts starten gleichzeitig
4. Ende nach Ablauf der Zeit / nach `gp_laps` Runden des Führenden

### Nachträglicher Ausdruck

1. Lauf (Status `done`) in Sidebar auswählen
2. **Drucker-Symbol** anklicken
3. **"Alle Karts drucken"** oder einzelnes Kart aus der Liste wählen
4. Optional: **"Vorschau"** für Browser-Ansicht

### Kart-Namen ändern

- Rechtsklick auf Lauf → **"Kart-Namen"**
- Oder: Einstellungen → Transponder-Verwaltung

---

## Verifikation & Tests

```bash
# Server starten
cd emslandringTiming
source .venv/bin/activate
python server/main.py

# Browser
http://localhost:8080

# MyLaps ASCII Emulator testen
nc 127.0.0.1 50000   # Zeigt $B/$H/$G/$F/$C Nachrichten in Echtzeit

# WebSocket testen
# Browser DevTools → Network → WS → ws://localhost:8080/ws

# Druck-Vorschau (kein Drucker nötig)
http://localhost:8080/api/run/1/preview

# Überlaufseite testen (simuliert 20 zusätzliche Runden)
http://localhost:8080/api/run/1/preview?sim_laps=20

# Datenbankinhalt prüfen
sqlite3 server/data/timing.db "SELECT * FROM runs;"
sqlite3 server/data/timing.db "SELECT COUNT(*) FROM passings;"
```

---

## Technische Details

### AMB P3 Protokoll

Der MyLaps RC4 Decoder kommuniziert über ein proprietäres Binärprotokoll (TCP):

```
Paketstruktur:
  0x8E  [2 Byte Länge LE]  [Nutzdaten]  0x8F

Byte-Stuffing (descape):
  0x8D 0xXX → Byte (0xXX - 0x20)

Pakettypen:
  TOR 0x0001 (PASSING):   Transponder-ID, Zeitstempel µs, Signalstärke, Hits
  TOR 0x0002 (HEARTBEAT): Rauschen, Loop-Signal (alle ~5 s)
```

### Zeitstempel

Alle Zeitstempel werden intern in **Mikrosekunden** (µs) seit Unix-Epoche gespeichert. Die Rundenzeit-Berechnung erfolgt als Differenz zweier aufeinanderfolgender Durchfahrten desselben Karts.

### Datenbankpfad

```
emslandringTiming/server/data/timing.db
```

Die Datenbank wird beim ersten Start automatisch erstellt. Alle Daten bleiben über Neustarts hinaus erhalten.

---

## Offene Punkte (Phase 2)

| Feature | Beschreibung |
|---------|-------------|
| Grand Prix Druckvorlage | Separate `grandprix.pdf` Vorlage (wartet auf Entwurf) |
| Kloft-Bridge (Windows) | `kloft-bridge/kloft_bridge.py` – RS485-Anbindung |
| Firebase-Upload | Automatischer Upload der Ergebnisse nach Laufende |
| Dashboard WebSocket | `dashboard.html` auf neues WS-Protokoll umstellen |
| Historische Daten | Import aus alter Firestore-Datenbank |

---

## Abhängigkeiten

| Paket | Zweck |
|-------|-------|
| `fastapi` | Web-Framework, REST-API, WebSocket |
| `uvicorn[standard]` | ASGI-Server |
| `aiosqlite` | Async SQLite |
| `weasyprint` | HTML → PDF Rendering |
| `pypdf` | PDF-Overlay (Ergebnisse auf Druckvorlage legen) |
| `cups` (System) | Druckaufträge an CUPS-Drucker senden |

---

## Changelog

### Version 1.0 (April 2026)

- Vollständiges Training-Timing mit Echtzeit-WebSocket-UI
- Grand Prix Modus (Zeit + Runden)
- MyLaps ASCII Emulator (Kloft-Kompatibilität)
- PDF-Ausdruck mit dynamischer Rundenzeiten-Matrix
- Einzelkart-Ausdruck (Auswahl aus Lauf-Ergebnissen)
- Druck-Vorschau im Browser
- Decoder-Verbindungsüberwachung (echte Heartbeat-Erkennung)
- Automatische Tages-Initialisierung (auch bei Tageswechsel im laufenden Betrieb)
- GeomGraphic + Lato Schriftarten im Ausdruck
- Überlaufseite ab 16 Runden pro Kart
- Transponder-Verwaltung in der Web-UI
- Hot-Reload der Konfiguration
