# Architektur

Diese Datei beschreibt das interne Design von `emslandringTiming` — für Entwickler,
Wartung und Erweiterungen.

---

## 1. Stack & Sprachen

| Komponente | Technologie |
|---|---|
| Backend | Python 3.12 (asyncio) |
| Web-Framework | FastAPI + Uvicorn |
| Datenbank | SQLite (via aiosqlite) |
| Frontend | Vanilla JS, kein Framework |
| Realtime | WebSocket (FastAPI integriert) |
| PDF-Druck | WeasyPrint (HTML→PDF) + pypdf (Overlay auf Template) |
| QR-Code | segno (reine Python-Library) |
| Drucker | CUPS via `lp`-Befehl |
| Tunnel | Tailscale Funnel (extern) |

---

## 2. Modulübersicht (`server/`)

```
server/
├── main.py          ← FastAPI-App, HTTP-Routen, WebSocket-Endpoint, Lifespan
├── config.py        ← Konfiguration laden/speichern (Hot-Reload)
├── database.py      ← SQLite-Schema + CRUD (aiosqlite)
├── decoder.py       ← AMB P3 TCP-Client (MyLaps RC4)
├── race_engine.py   ← Zustandsmaschine Training/GP
├── run_manager.py   ← Lauf-CRUD, Tages-Initialisierung
├── emulator.py      ← MyLaps ASCII TCP-Server (Kloft-Bridge)
├── ws_hub.py        ← WebSocket Broadcast-Hub
├── printer.py       ← PDF-Druck (WeasyPrint + pypdf + CUPS)
├── ampel.py         ← Devantech ETH008 Steuerung
├── profanity.py     ← Wortfilter für Customer-Namen
└── data/
    ├── fonts/                  ← TrueType-Schriftarten für Druck
    ├── templates/              ← PDF-Vorlagen (training.pdf etc.)
    ├── logo.png                ← Druck-Logo
    └── profanity_de.txt        ← Wortliste
```

---

## 3. Startsequenz (`main.py` lifespan)

```python
async def lifespan(app):
    # 1. Datenbank initialisieren (Schema erstellen falls neu)
    await database.init_db()

    # 2. Stale Läufe vom Vortag auf 'done' setzen
    await run_manager.cleanup_stale_active_runs()
    await run_manager.ensure_today_runs()

    # 3. Decoder-Verbindung asynchron starten
    decoder.start()
    asyncio.create_task(decoder.run_forever())

    # 4. Emulator (MyLaps ASCII-Server) starten
    if cfg.get()["emulator_enabled"]:
        await emulator.start()

    # 5. Ampel-Polling-Task
    asyncio.create_task(ampel.poll_loop())

    # 6. Decoder-Health-Logger (alle 60s)
    asyncio.create_task(health_logger())

    yield   # ← Server läuft

    # Shutdown:
    decoder.stop()
    await emulator.stop()
```

---

## 4. HTTP-API Endpoints

### 4.1 HTML-Seiten

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/` | Operator-UI (`index.html`) |
| GET | `/dashboard` | Read-Only Zuschauer-Dashboard (`dashboard.html`) |
| GET | `/record/{token}` | Mobile Customer-Eingabe (`record.html`) |

### 4.2 Lauf-API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/runs?date=YYYY-MM-DD` | Läufe eines Tages |
| POST | `/api/runs` | Neuen Lauf am heutigen Tag anhängen |
| GET | `/api/runs/{id}` | Lauf-Details inkl. Kart-Tabelle + kart_names |
| PATCH | `/api/runs/{id}` | Lauf-Einstellungen ändern (mode, duration, name, gp_laps) |
| POST | `/api/runs/{id}/arm` | Scharf schalten |
| POST | `/api/runs/{id}/disarm` | Unscharf schalten |
| POST | `/api/runs/{id}/start` | GP starten (RED→GREEN) |
| POST | `/api/runs/{id}/pause` | Pausieren |
| POST | `/api/runs/{id}/resume` | Fortsetzen |
| POST | `/api/runs/{id}/stop` | Beenden |
| POST | `/api/runs/{id}/kart-name` | Lauf-spezifischen Kart-Namen setzen |
| GET | `/api/runs/{id}/print-preview` | HTML-Vorschau |
| POST | `/api/runs/{id}/print` | An CUPS-Drucker senden |

### 4.3 Konfiguration

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/settings` | aktuelle Config lesen |
| PATCH | `/api/settings` | Config aktualisieren (Hot-Reload) |
| GET | `/api/printers` | CUPS-Drucker auflisten |
| GET | `/api/classes` | konfigurierte Kart-Klassen |
| GET | `/api/logo` | Logo-PNG ausliefern |
| POST | `/api/logo` | Logo hochladen |

### 4.4 Daten-API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/transponders` | Liste aller Transponder mit Stats |
| GET | `/api/transponders/{id}/lap-times` | letzte 50 Runden eines Karts |
| GET | `/api/transponders/{id}/history` | Signalstärke-History |
| GET | `/api/bestof?kart_class=X&period=day` | Bestenliste |
| GET | `/api/decoder/health` | aktueller Decoder-Status |
| DELETE | `/api/passing/{pid}` | einzelne Runde löschen |
| DELETE | `/api/bestof/claim/{pid}` | Customer-Name zurücksetzen |
| GET | `/api/record/{token}` | Daten der Mobile-Seite (JSON) |
| POST | `/api/record/{token}` | Customer trägt Namen ein |

### 4.5 Ampel

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/ampel` | aktueller Ampel-Status |

---

## 5. WebSocket-Protokoll (`/ws`)

WebSocket-Endpoint: `ws://<host>:8081/ws?client=<type>`

`client`-Parameter:
- `app` (Default) — Operator-UI
- `dashboard` — Zuschauer-Dashboard
- `other` — Sonstige

Nachrichten gehen vom Server zum Client. Der Client schickt nur ein leeres
keepalive zurück.

### 5.1 Nachrichten-Typen

| Typ | Trigger | Inhalt |
|---|---|---|
| `snapshot` | bei Verbindungsaufbau | aktueller Lauf, Karts, runs_today, decoder-Status, ampel |
| `run_list` | Lauf-Status ändert sich | komplette Lauf-Liste des Tages |
| `run_state` | Lauf wechselt Status (armed/running/...) | id, name, mode, status, remaining_sec, ... |
| `run_updated` | Lauf-Einstellungen geändert | aktualisierte Run-Daten |
| `run_finished` | Lauf-Ende | run_id |
| `kart_table` | nach jedem PASSING neu sortiert | sortierte Liste aller Karts mit Stats |
| `passing` | einzelner Lap-Event | kart_nr, name, lap_time_us, lap_nr, position |
| `timer_tick` | jede Sekunde während `running` | remaining_sec, elapsed_sec |
| `decoder_health` | bei Decoder-Heartbeat | connected, noise, loop |
| `client_count` | Verbindungs-Änderungen | { app: 2, dashboard: 1, other: 0 } |
| `print_ok` / `print_error` | nach Druckauftrag | run_id |
| `defect_alert` | bei Defekt-Erkennung | kart_nr, klasse, wma_us |

Vollständige Format-Definitionen: siehe `server/race_engine.py`, `server/main.py` und
`server/decoder.py` (suche nach `hub.broadcast`).

### 5.2 Beispiel-Snapshot

```json
{
  "type": "snapshot",
  "run": {
    "id": 238,
    "name": "Lauf 3",
    "mode": "training",
    "status": "running",
    "remaining_sec": 402,
    "elapsed_sec": 18,
    "duration_sec": 420
  },
  "karts": [
    {
      "position": 1,
      "kart_nr": 19,
      "name": "Kart 19",
      "laps": 5,
      "best_us": 62400000,
      "last_us": 63100000,
      "avg5_us": 62800000,
      "trend": "stable",
      "last_passing_ts": 1715949023.4,
      "strength": 177
    }
  ],
  "runs_today": [ { "id": 236, "name": "Lauf 1", "status": "done", ... } ],
  "decoder": { "connected": true, "noise": 8, "loop": 119 },
  "ampel": { "enabled": true, "red": false, "green": true }
}
```

---

## 6. Datenbank-Schema

```sql
-- Einfache Key-Value-Settings (aktuell ungenutzt — Config liegt in JSON)
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Läufe (1 Eintrag pro angelegtem Lauf)
CREATE TABLE runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT    NOT NULL,           -- YYYY-MM-DD
    run_number   INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    mode         TEXT    NOT NULL DEFAULT 'training',  -- training | gp_time | gp_laps
    duration_sec INTEGER NOT NULL DEFAULT 420,
    gp_laps      INTEGER,
    status       TEXT    NOT NULL DEFAULT 'pending',
    -- pending | armed | running | paused | finishing | done
    started_at   REAL,                       -- Unix-Timestamp
    finished_at  REAL,
    UNIQUE(date, run_number)
);

-- Lauf-spezifische Kart-Namen (überschreibt globalen Namen)
CREATE TABLE run_kart_names (
    run_id  INTEGER NOT NULL,
    kart_nr INTEGER NOT NULL,
    name    TEXT    NOT NULL,
    PRIMARY KEY (run_id, kart_nr)
);

-- Einzelne Durchgänge ("PASSINGs") aus dem Decoder
CREATE TABLE passings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL,
    transponder_id INTEGER NOT NULL,
    kart_nr        INTEGER,                  -- NULL wenn unbekannter Transponder
    timestamp_us   INTEGER NOT NULL,         -- Decoder-Zeit in µs
    lap_time_us    INTEGER,                  -- NULL für ersten Durchgang ("Einführungsrunde")
    strength       INTEGER,
    hits           INTEGER
);

-- Decoder-Health alle 60s
CREATE TABLE decoder_health (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at INTEGER NOT NULL,            -- Unix-Sekunden
    noise       INTEGER,
    loop_signal INTEGER
);

-- Customer-Claims (QR-Code-Feature)
CREATE TABLE record_claims (
    passing_id  INTEGER PRIMARY KEY,
    token       TEXT    NOT NULL UNIQUE,
    name        TEXT,                        -- NULL bis Customer eingetragen hat
    claimed_at  REAL,                        -- Unix-Timestamp wenn Name gesetzt
    created_at  REAL    NOT NULL,
    FOREIGN KEY (passing_id) REFERENCES passings(id) ON DELETE CASCADE
);

-- Indizes für Performance
CREATE INDEX idx_passings_transponder_id  ON passings(transponder_id);
CREATE INDEX idx_passings_run_id          ON passings(run_id);
CREATE INDEX idx_runs_date                ON runs(date);
CREATE INDEX idx_decoder_health_recorded  ON decoder_health(recorded_at);
CREATE INDEX idx_record_claims_token      ON record_claims(token);
```

---

## 7. Race-Engine Zustandsmaschine

```
                      ┌───────────────────────────┐
                      │                           │
       arm()          │       erstes PASSING      │
PENDING ────────▶ ARMED ──────────────────────▶ RUNNING
   ▲                  │                           │ │ ▲
   │ disarm()         │ disarm() / stop()         │ │ │ resume()
   │                  ▼                           ▼ │ │
   └──── DONE ◀── (nichts) ──── stop() ──── PAUSED ─┘ │
                ▲                              │      │
                │                              └──────┘
                │ alle Karts da / wait_time      pause()
                │ abgelaufen
       FINISHING ── (Timer auf 0 erreicht /
                    Stop / GP-Sieger gefahren)
```

**Training:** Übergang ARMED→RUNNING beim ersten PASSING (Auto-Start).
**Grand Prix:** ARMED-Phase entspricht der „RED"-Phase (Pre-Start),
Übergang zu RUNNING erst durch expliziten Start-Button.

---

## 8. Decoder-Protokoll (AMB P3)

```
Paketstruktur (TCP):
  0x8E  [2 Byte Länge LE]  [Nutzdaten ...]  0x8F

Byte-Stuffing (descape):
  Sequenz 0x8D 0xXX → Einzelbyte (0xXX - 0x20)
  (verhindert dass Nutzdaten 0x8D, 0x8E, 0x8F enthalten und falsch interpretiert werden)

Wichtige Pakettypen (TOR-Feld):
  0x0001 PASSING:   Transponder-ID (4 Byte), Timestamp µs (8 Byte),
                    Signalstärke (1), Hits (1)
  0x0002 HEARTBEAT: Noise, Loop-Signal (kommt alle ~5 s)
```

Implementiert in `server/decoder.py`. Bei Verbindungsverlust automatischer Reconnect
nach 3 s. Wenn kein HEARTBEAT für 15 s → Verbindung als tot werten und neu verbinden.

---

## 9. Druck-Pipeline

```
api_print(run_id)
  │
  └─ printer.print_run(run_id)
       │
       ├─ _gather_run_data(run_id)
       │    ├─ get_run() aus DB
       │    ├─ get_passings_for_run()
       │    ├─ get_run_kart_names()
       │    └─ Karts aggregieren + sortieren (Training: best_us / GP: laps+total_us)
       │
       ├─ pro Kart parallel (ProcessPoolExecutor, spawn-context!):
       │    └─ render_kart_pdf(kart, all_data)
       │          │
       │          ├─ _build_overlay_html(data, kart, sim_laps=0)
       │          │    ├─ _header_elements() ← Kart-Nr, Position, Klasse, Logo/QR
       │          │    ├─ _laps_elements()    ← Rundenzeiten oben links (4×5-Grid)
       │          │    ├─ _stats_elements()   ← Best/Ø/Konsistenz/Hits
       │          │    ├─ _chart_element()    ← Rundenzeit-Verlauf SVG
       │          │    ├─ _matrix_element() (Training) oder
       │          │    │  _gp_ranking_element() (GP)
       │          │    ├─ _bestof_elements()  ← Tag/Woche/Monat/Jahr Listen
       │          │    └─ _footer_element()   ← Druckdatum
       │          │
       │          ├─ WeasyPrint: HTML → PDF (transparent, A4)
       │          ├─ pypdf: Overlay auf training.pdf legen
       │          └─ PDF-Datei in /tmp/
       │
       └─ CUPS lp: PDF an Drucker senden
```

**Wichtig:** Der `ProcessPoolExecutor` läuft im `spawn`-Multiprocessing-Context
(nicht `fork`!). Grund: Firebase-Admin lädt gRPC-Native-Threads beim Import; bei
`fork()` kopiert das System den Speicher, aber nicht die OS-Threads → gRPC-Datenstrukturen
sind inkonsistent → SIGABRT beim Aufräumen → Service-Hang. `spawn` startet
saubere neue Python-Prozesse → kein Problem.

---

## 10. Konfiguration (Hot-Reload)

`config.py` cached die `config.json` und prüft bei jedem `cfg.get()` die `mtime`
der Datei. Wenn die Datei neuer ist als der Cache → neu laden.

Effekt: Änderungen über die Web-UI **oder** direkt per `nano config.json` werden
innerhalb von max. 5 Sekunden wirksam — kein Service-Restart nötig.

**Ausnahme:** Ports werden beim Service-Start gebunden — Port-Wechsel brauchen
Restart.

---

## 11. WebSocket-Broadcast

`ws_hub.py` verwaltet eine `set[WebSocket]` aller verbundenen Clients. Bei
`hub.broadcast(message)`:

1. JSON-Serialisierung
2. An jeden Client senden, parallel via `asyncio.gather`
3. Bei Fehler (Disconnect, Timeout): Client aus dem Set entfernen

Per-Client-Typ-Counts (`app` / `dashboard` / `other`) werden bei jeder
Verbindungs-Änderung als `client_count`-Message gebroadcastet — die UI zeigt
unten rechts „3× App · 1× Dashboard".

---

## 12. Frontend (`web/static/app.js`)

Single-Page-Application ohne Framework. Struktur:

```
state = {
  runs: [],            // alle Läufe des Tages
  activeRun: null,     // aktuell laufender Lauf
  selectedRunId: ...,  // gerade angezeigter Lauf
  karts: [],           // sortierte Kart-Tabelle
  settings: {},        // Cache von /api/settings
  decoder: {},         // letzter Decoder-Status
  ...
}

// WebSocket: dispatched Nachrichten an renderer
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'snapshot':    applySnapshot(msg); break;
    case 'run_state':   updateRunState(msg); break;
    case 'kart_table':  renderKartTable(); break;
    case 'passing':     flashKartRow(msg.kart_nr); break;
    case 'timer_tick':  updateTimer(); updateDocTitle(); break;
    ...
  }
}

// Reconnect-Watchdog (alle 10s) – siehe section 4.1
```

Dashboards (`dashboard.html`, `record.html`) sind eigenständige HTML-Files mit
eigenem JS, lesen nur einen schmalen Subset der Server-Nachrichten.

---

## 13. Sicherheits-Aspekte

| Bereich | Maßnahme |
|---|---|
| **LAN-Zugang** | Keine Authentifizierung — UI ist offen für jeden im LAN |
| **Drucker** | CUPS Web-UI fragt Server-Passwort |
| **Tailscale Funnel** | HTTPS automatisch, Server-Zugang öffentlich aber **nur** über die definierte Public-URL |
| **Customer-API** | `/api/record/{token}` braucht gültiges Token (zufällig, 64-Bit-Entropie). Profanity-Filter serverseitig |
| **24h Lock** | Customer-Name nach 24h nicht mehr änderbar |
| **DB-Zugriff** | nur User `server` hat Lese-/Schreibrechte |

**Bewusste Designentscheidung:** Die Operator-UI hat **kein Login** — alle
Bediener im Karthallen-LAN dürfen alles. Die Annahme ist, dass nur autorisiertes
Personal Zugang zur Kabine hat. Falls Multi-User-Auth gebraucht wird: ein
HTTP-Basic-Auth in FastAPI hinzufügen.

---

## 14. Performance-Aspekte

| Metrik | Wert |
|---|---|
| RAM-Verbrauch Idle | ~45 MB |
| RAM-Verbrauch beim Druck | ~250 MB pro Worker-Prozess (× n Workers) |
| Druck-Dauer | ~1 s pro Kart auf modernem Mini-PC |
| WebSocket-Latency | <50 ms im LAN |
| Decoder-Verarbeitung | <10 ms pro PASSING |
| DB-Schreibvorgang | <5 ms (mit Indizes) |

Bei wachsender DB (>500k Passings): Defekt-Erkennung verlangsamt sich, daher
sind Indizes auf `passings.transponder_id` und `passings.run_id` zwingend.

---

## 15. Erweiterungspunkte

### 15.1 Neue Klasse hinzufügen

In `config.json` unter `classes` ergänzen, dann unter `defect_categories` einen
Block für die neue Klasse. Frontend zeigt sie automatisch in den Klassen-Filtern.

### 15.2 Neue WebSocket-Nachricht

1. In Backend: `await hub.broadcast({"type": "mein_event", ...})`
2. In `web/static/app.js`: case `'mein_event': handle...` im switch ergänzen

### 15.3 Neuer Druckblock

Eine `_my_element(kart, lo)` Funktion in `printer.py` ergänzen, dann in
`_build_overlay_html` einbinden. Layout-Koordinaten im `L`-Dict (oder `LO` für
Überlaufseiten) definieren.

### 15.4 Cloud-Sync

`firebase-admin` ist bereits installiert und in `requirements.txt`. Beispiel-Code
zum Hochladen siehe alte `mylaps_server.py` im Repo-Root. Aktivierung wäre eine
weitere Setting `firebase_credentials` (Pfad zur Service-Account-JSON).

---

## 16. Test-Endpoints (für Entwicklung)

| URL-Parameter | Wirkung |
|---|---|
| `/api/runs/{id}/print-preview?sim_laps=50` | Simuliert 50 Runden pro Kart — testet Überlaufseiten |
| `/api/runs/{id}/print-preview?kart_nr=19` | Nur ein bestimmtes Kart anzeigen |
| `/api/ampel/test/red` | Ampel auf rot schalten (zum Hardware-Test) |
| `/api/ampel/test/green` | Ampel auf grün |
| `/api/ampel/test/off` | Ampel aus |

---

## 17. Build & Deployment-Workflow

1. **Entwicklung:** Auf Mac/Linux mit lokalem Python venv arbeiten.
2. **Commit:** Klassisches Git, Conventional Commits sind gewünscht aber nicht erzwungen.
3. **Push:** auf `main`-Branch im GitHub-Repo.
4. **Stable Tag:** Bei wichtigen Meilensteinen einen `stable-YYYY-MM-DD`-Tag setzen.
5. **Deploy auf Server:** `git pull` + `systemctl restart` auf dem Mini-PC.
6. **Falls Dependencies neu:** vorher `pip install -r requirements.txt` in das venv.
7. **Bei Frontend-Änderungen:** Browser-Cache leeren (`Strg+Shift+R`).

---

*Nächstes Kapitel:* `07_MIGRATION.md` — Backup-PC einrichten / Daten von altem Server holen.
