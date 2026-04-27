# MyLaps Race Control — Protokoll & System-Dokumentation

Stand: 2026-04. Komplette Neufassung nach Integrations-Erfahrungen mit
der Race-Control-Box am Emslandring Dankern (Trainings + Grand Prix),
Firebase-Hosting und Windows-7-Deployment.

Diese Datei dokumentiert:
1. Das TCP-Protokoll der MyLaps-Box, so wie wir es beobachtet haben
2. Den daraus abgeleiteten Zustandsautomaten im `mylaps_server.py`
3. Die Firestore-Struktur (Sessions, kart_meta)
4. Das Verhalten von `dashboard.html` (Live) und `analyse.html` (History)
5. Betriebsinfos (config.txt, Karts, Windows-Deployment)

---

## 1. Transport

- **TCP**, die Box hört auf einem konfigurierbaren Port (typ. 50000).
- Der Server ist **Client**: `config.txt` → `MYLAPS_HOST` + `MYLAPS_PORT`.
- Nachrichten sind ASCII-Zeilen, getrennt durch `\r\n`.
- Felder innerhalb einer Zeile sind durch **Komma (`,`)** getrennt,
  **Strings doppelt-gequoted**.  *(In früheren Versionen dieses Dokuments
  stand "Tab-getrennt" – das war falsch und wurde nach dem 1:1-Mitschnitt
  vom 27.04.2026 korrigiert.)*
- Alle Zeilen beginnen mit einem Typ-Kürzel `$X` (z. B. `$F`, `$A`, `$B`).
- Encoding: ASCII/Latin-1, unempfindlich. Beim Parsen nutzen wir
  `decode('latin-1', errors='replace')`.

Die Box sendet unaufgefordert, sobald sie läuft. Der Server muss nur
verbinden, lesen, parsen. Kein Login, kein Handshake.

### 1.1 Reales Format (Mitschnitt 27.04.2026, Training "Gruppe 1")

```
$F,9999,"00:00:00","11:23:56","00:00:00","RED   "    ← jede Sek. im Leerlauf
$F,9999,"00:00:00","11:25:02","00:00:00","RED   "
$C,12,"Online  [Online]"                              ← Session-Vorbereitung
$B,12644,"Gruppe 1"                                   ← Session-Start
$I,"11:25:03.574","27 Apr 26"                         ← Datum/Uhrzeit
$A,"1","1",,"","Kart 1","",12                         ← Vor-Anmeldung aller Karts
$A,"2","2",,"","Kart 2","",12
…
$F,9999,"00:00:00","11:25:03","00:00:00","GREEN "    ← initialer GO
$J,"19","00:00:00.000","00:00:00.000"                ← Intro-Durchfahrt Kart 19
$G,1,"19",0,"00:00:00.000"                           ← Rangliste (1 Eintrag)
$H,1,"19",0,"00:00:00.000"                           ← Bestzeit-Liste
$F,9999,"00:06:59","11:25:04","00:00:01","GREEN "    ← Sek-Tick mit Countdown
…
$J,"19","00:00:59.358","00:00:59.358"                ← 1. gewertete Runde
$G,1,"19",1,"00:00:59.358"
$G,2,"18",0,"00:00:04.544"                           ← komplette Rangliste
$H,1,"19",1,"00:00:59.358"
$H,2,"18",0,"00:00:00.000"
…
$F,9999,"00:00:00","11:33:03","00:08:00","FINISH"    ← Renndauer abgelaufen
$F,9999,"00:00:00","11:33:04","00:08:00","FINISH"    ← jede Sek. weiter
…
$F,9999,"00:00:00","11:34:18","00:00:00","FINISH"    ← elapsed-Reset (~75 s nach FINISH)
```

### 1.2 Grand-Prix-Mitschnitt (07.04.2026, "RACE")

```
$F,0,"00:00:00","17:09:59","00:00:00"," "             ← OFF-State (Feld 1 = 0!)
$F,9999,"00:00:00","17:10:03","00:00:00","RED "       ← RED-Phase (4 Zeichen!)
…
$C,12,"Online [Online]"                               ← GP: 1 Space (vs. Training 2 Spaces)
$B,12063,"RACE"                                       ← Gruppenname "RACE"
$I,"17:10:59.835","07 Apr 26"
$F,9999,"00:00:00","17:10:59","00:00:00","GREEN "    ← initialer GO – kein $A-Block!
$F,9999,"00:07:59","17:11:00","00:00:01","GREEN "
…
$A,"17","17",,"","Kart 17","",12                      ← Karts werden dynamisch gemeldet
…
$F,9999,"00:00:00","17:19:00","00:08:00","GREEN "    ← cd=0, aber GREEN bleibt!
$F,9999,"00:00:00","17:19:01","00:08:01","GREEN "    ← elapsed wächst weiter
$J,"17","00:00:54.593","00:08:00.736"                ← Führender überquert Linie
$G,1,"17",8,"00:08:00.736"
$H,1,"17",7,"00:00:54.180"
$F,9999,"00:00:00","17:19:02","00:08:02","FINISH"    ← jetzt erst FINISH
$F,9999,"00:00:00","17:19:03","00:08:03","FINISH"    ← elapsed wächst WEITER (anders als Training!)
…
$F,9999,"00:00:00","17:19:50","00:08:50","FINISH"
$F,9999,"00:00:00","17:19:53","00:00:00","FINISH"    ← elapsed-Reset (~50 s nach FINISH-Start)
…
$F,9999,"00:00:00","17:20:54","00:00:00","FINISH"
$F,0,"00:00:00","17:20:55","00:00:00"," "             ← Übergang in OFF-State (~110 s nach FINISH)
```

### 1.3 Unterschiede Training vs. Grand Prix

| Aspekt | Training | Grand Prix |
|--------|----------|------------|
| Gruppenname (`$B`) | `"Gruppe N"` | `"RACE"` |
| `$C`-Status-String | `"Online  [Online]"` (2 Spaces) | `"Online [Online]"` (1 Space) |
| Vorab-`$A`-Block | alle bekannten Karts | **leer** – Karts dynamisch |
| Countdown=0 → Status | sofort `FINISH`, elapsed friert auf duration | bleibt `GREEN`, elapsed wächst, bis Führender Linie passiert |
| FINISH elapsed-Verhalten | eingefroren auf duration | wächst weiter mit Wandzeit |
| elapsed-Reset nach FINISH | ~75 s | ~50 s |
| Übergang in OFF | nicht im Mitschnitt | ~110 s nach FINISH-Start |

### 1.4 OFF-State (Feld 1 = 0)

Vor jeder ersten Session des Tages und nach langem Idle nach
Session-Ende sendet die Box jede Sekunde:

```
$F,0,"00:00:00","HH:MM:SS","00:00:00"," "
```

Erkennbar an Feld 1 = `0` (statt `9999`) und einem einzelnen
Leerzeichen als Status. Sobald der Operator in der MyLaps-Software
eine neue Session vorbereitet, wechselt die Box auf `RED` (Feld 1 → 9999).

### 1.5 Eigenheiten

* `$F` wird **jede Wandzeit-Sekunde** gesendet, auch im Leerlauf
  (RED) und nach FINISH. Aktive Sessions tickt der Countdown
  `duration - elapsed` herunter.
* Status-Feld ist immer **6 Zeichen breit**:
  `"RED   "`, `"GREEN "`, `"FINISH"`.
* `$F` Felder (in Reihenfolge):
  `9999, "<countdown HH:MM:SS>", "<wall HH:MM:SS>", "<elapsed HH:MM:SS>", "<status:6>"`.
* Bei Verlängerung des Laufs durch den Operator springt der Countdown
  nach oben (im Mitschnitt: `02:55` → `03:53`, +58 s ≈ +1 min Extra-Zeit).
* `$A` enthält leere Felder: `$A,"<id>","<nr>",,"","<name>","",12`.
* Pro Passing wird **immer die komplette Rangliste** als
  `$G`-Block (Reihenfolge = aktuelle Position) und direkt danach
  `$H`-Block (Bestzeit je Kart, gleiche Reihenfolge) ausgegeben.
* `$H` Feld 4 (`laps`) ist **die Rundenzahl, in der die Bestzeit
  gefahren wurde** – nicht der aktuelle Rundenstand! In einem Lauf
  kann z. B. `$G,3,"19",8,…` (8 Runden) und gleichzeitig
  `$H,3,"19",6,…` (Bestzeit war Runde 6) stehen.
* `$G` Feld 4 (`total`) ist die **elapsed-Zeit beim letzten Passing
  dieses Karts** (nicht die Summe der Rundenzeiten).
* `$J` Feld 2 ist die **letzte Rundenzeit** (`00:00:00.000` für die
  Intro-Durchfahrt).
* Bei FINISH friert das `elapsed`-Feld auf der Renndauer ein
  (z. B. `00:08:00` bei 8-min-Lauf). Nach ~75 s springt es auf
  `00:00:00` zurück; Status bleibt `FINISH` bis zur nächsten Session.

---

## 2. Nachrichten-Typen

> **Hinweis:** Die folgenden Beispiele wurden früher als Tab-getrennt
> notiert. Real verwendet die Box **Komma + Quotes** (siehe 1.1).
> Die Feld-Reihenfolge und Bedeutung stimmen, aber das Trennzeichen
> ist beim Lesen/Schreiben Komma, und String-Felder stehen in
> doppelten Anführungszeichen.

### 2.1 `$F` — Flag / Status / Countdown

Beispiel:
```
$F	9999	GREEN         	00:00:00
$F	9999	RED           	00:00:05
```

| # | Feld        | Bedeutung |
|---|-------------|-----------|
| 0 | `$F`        | Typ |
| 1 | `9999`      | **unbekannt, aber irrelevant** (konstant beobachtet; **kein** GP-Indikator!) |
| 2 | Status      | `GREEN`, `RED`, `YELLOW`, `FINISH`, … — mit Trailing-Spaces aufgefüllt. Immer `.strip()` nutzen. |
| 3 | Countdown   | `HH:MM:SS` — beim GP läuft hier die Vor-Start-Zählung rückwärts. |

**Wichtig**:
- Die Feldbreite des Status-Felds ist **nicht verlässlich** — nur der
  gestrippte String ist zu vergleichen.
- `RED` tritt auch in Trainings auf (z. B. Not-Aus). `RED` alleine ist
  **kein** Grand-Prix-Merkmal.
- `9999` im Feld 1 ist **kein** Sentinel für GP — wir haben es auch in
  reinen Trainings gesehen.

### 2.2 `$A` — Kart angemeldet

```
$A	0123	58	…	12
```

| # | Feld | Bedeutung |
|---|------|-----------|
| 0 | `$A` | Typ |
| 1 | ID   | interne Lauf-ID |
| 2 | Kart-Nummer | Identifikation für uns |
| … | …    | weitere Felder (Namen, Gruppen, leer) |
| letztes | `12` | **unbekannt, aber irrelevant** (konstant beobachtet) |

Wir extrahieren ausschließlich die **Kart-Nummer**.

### 2.3 `$J` — Session/Gruppe angekündigt

```
$J	Gruppe 14
$J	RACE
```

Feld 1 enthält den **Gruppennamen**. Genau dieser Name entscheidet
später über Training vs. Grand Prix:

> **GP-Regel (zwingend):** `group_name.strip().upper() == "RACE"`

Andere Werte (`Gruppe 28`, `RACE A`, `RENNEN`, …) gelten als Training.

### 2.4 `$B` — Session-Start

```
$B	0042	Gruppe 14
```

| # | Feld | Bedeutung |
|---|------|-----------|
| 0 | `$B` | Typ |
| 1 | Session-ID | fortlaufend |
| 2 | Gruppenname | wie `$J`, redundant |

`$B` markiert für unseren Zustandsautomaten den **harten Session-Start**:
- neue `SessionState` aufsetzen
- `group_name` übernehmen
- **`_update_mode()` aufrufen** → `mode = "grandprix"` iff
  `group_name == "RACE"`, sonst `"training"`
- evtl. vor `$B` aufgelaufene Flags (`RED`, Countdown) werden als
  „pending" gepuffert und im Session-Start-Broadcast mitgeschickt.

### 2.5 `$G` — Runden-Zwischenstand

```
$G	58	3	01:12.345
```

| # | Feld | Bedeutung |
|---|------|-----------|
| 0 | `$G` | Typ |
| 1 | Kart | Nummer |
| 2 | Runde | Zähler (kann springen, wenn eine Box neu einlogged — wir verlassen uns nicht darauf) |
| 3 | Zeit | `MM:SS.mmm` oder `HH:MM:SS.mmm` |

Wird für Live-Ranking (`ranking_g`) im Dashboard verwendet.

### 2.6 `$H` — Durchfahrt / Passing

```
$H	58	1:12.345
```

Primäres Event für uns: jede gemessene Runde → an Firestore
akkumulieren (`laps`, `best`, `total`).

### 2.7 `$C` — Session-Ende / Zwischenstand-Commit

```
$C	12	0042
```

Feld 1 = `12` — **unbekannt, aber irrelevant**. Wir nutzen `$C` als
einen der Trigger, um die aktuelle Session zu finalisieren (zusammen
mit Status `FINISH` in `$F` und Timeout).

### 2.8 `$I` — Info / Idle

Unregelmäßige Info-Zeile der Box. Für uns **ignoriert**.

---

## 3. Zustandsautomat im Server

Datei: `mylaps_server.py`, Klasse `SessionState`.

### 3.1 Felder

- `active: bool` — läuft gerade eine Session?
- `session_id: str`
- `group_name: str`
- `mode: "training" | "grandprix"`
- `saw_red: bool` — reine Anzeige, kein Auslöser
- `countdown_sentinel: bool` — reine Anzeige
- `karts: dict[int, {laps, best, total, last_lap_ts}]`
- `started_at`, `last_event_at`

### 3.2 Übergänge

1. **`$J`** → `group_name` merken (Vor-Ankündigung).
2. **`$F`** mit `RED` oder mit Countdown ≠ `00:00:00`:
   - wenn schon `active`: direkt State-Flags setzen + Broadcast.
   - sonst: in Modul-Variablen `_pending_red` /
     `_pending_countdown_sentinel` puffern, damit wir sie beim
     nächsten `$B` nachziehen können.
3. **`$B`** → neue Session:
   - `reset()` + `active = True`
   - `group_name` aus `$B`/`$J`
   - `_update_mode()` — **einzige** Wahrheit für GP vs Training:
     ```python
     grp = (state.group_name or "").strip().upper()
     state.mode = "grandprix" if grp == "RACE" else "training"
     ```
   - Broadcast `session_start` inkl. `mode`, `saw_red`, `sentinel`.
4. **`$H`** → `update_kart()` + Broadcast `passing`.
5. **`$G`** → Broadcast `ranking_g` (nur Live-Anzeige).
6. **`$F`** mit `FINISH` oder `$C` oder Timeout (keine Events > N s) →
   `finalize_session()`:
   - schreibt nach Firestore
   - loggt: `Schreibe Session <id> nach Firestore (<n> Karts, mode=<m>, group=<g>)`
   - setzt `active = False`.

### 3.3 Warum so streng auf `RACE`?

Wir hatten zwei False Positives (ein Training wurde als GP
gespeichert), weil wir vorher zusätzlich `RED` ODER `9999` ODER
Countdown > 0 als Hinweis genommen hatten. Diese Signale tauchen auch
bei normalen Trainings auf. **Nur** der Gruppenname `RACE` ist stabil.

---

## 4. Firestore-Schema

### 4.1 Collection `sessions`

Dokument-ID = `session_id` aus `$B`. Felder:

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `session_id` | string | |
| `group_name` | string | Original, ungetrimmt |
| `mode` | `"training" \| "grandprix"` | aus `_update_mode()` |
| `started_at` | timestamp | erster Event |
| `ended_at` | timestamp | Finalize-Zeitpunkt |
| `recorded_at` | timestamp | Server-Schreibzeit (Debug/Backfill) |
| `kart_numbers` | array<int> | |
| `category_breakdown` | map | `{mini, leih, renn, super, doppel}` |
| `duration_sec` | int | |

### 4.2 Subcollection `sessions/{id}/kart_details/{nr}`

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `kart` | int | |
| `laps` | int | reine Messrunden (keine Intro/Outro) |
| `best` | float | Sekunden |
| `total` | float | Summe der gemessenen Runden |

Intro- und Outro-Runde werden **nicht** gemessen. Die Analyse-App
kompensiert das, indem sie pro Lauf `2 × Durchschnitt` auf `total`
aufrechnet (siehe 6.2).

### 4.3 Collection `kart_meta`

Dokument-ID = Kart-Nummer als String. Felder:

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `offset_sec` | int | Basis-Betriebssekunden, die auf die Summe aller Sessions aufaddiert werden. |

Geschrieben von `analyse.html` via `setDoc(..., {merge:true})`. Damit
sehen alle Geräte denselben Offset (früher: localStorage pro Browser).

### 4.4 Security Rules (Kurzform)

```
match /sessions/{id}            { allow read: if true; allow write: if false; }
match /sessions/{id}/kart_details/{k} { allow read: if true; allow write: if false; }
match /kart_meta/{k}            { allow read, write: if true; }
```

Der Server schreibt `sessions` mit dem Service-Account-Key und umgeht
damit die Regeln. Browser dürfen ausschließlich `kart_meta` schreiben.

---

## 5. `dashboard.html` (Live)

WebSocket-Client auf `ws://<host>:8765`. Empfängt:

- `snapshot` — voller State beim Verbinden
- `session_start` — neue Session, inkl. `mode`
- `passing` — einzelne Durchfahrt
- `ranking_g` — Live-Zwischenstand aus `$G`
- `flag` — Statuswechsel/Countdown
- `session_end`

### 5.1 Training-Modus

- Ruhiger Look (grauer Header)
- Tabelle: `Platz | Kart | Runden | Beste Runde | Letzte Runde`
- Sortierung: beste Rundenzeit aufsteigend
- Finish friert den Stand ein

### 5.2 Grand-Prix-Modus (nur bei `mode == "grandprix"`)

- **Roter Header**, Badge „GRAND PRIX"
- **Countdown im Header** (`topbar-center`): **nur die Zeit**, kein
  Label, kein „GREEN/RED"
- **Pre-Start-Overlay**: 5 blinkende Lichter, solange der Countdown
  läuft und noch keine Passings kommen
- Tabelle: `Platz | Kart | Runden | Bestzeit | Abstand`
- Sortierung: `laps desc`, dann `total asc`
- Abstand zum Leader aus `total`-Differenz bzw. Rundenrückstand
- Finish (Status `FINISH`) → Tabelle friert ein

Eyebrow „Zuletzt gemessen" ist entfernt — der Hero zeigt direkt Kart
und Zeit.

---

## 6. `analyse.html` (History)

Single-Page-App, Hash-Routing. Quellen: `sessions`, `kart_meta`.
Gehostet via Firebase Hosting als `index.html`.

### 6.1 Unterseiten

- **Übersicht** — Filter nach Datum / Modus / Kart, Liste aller Sessions
- **Session-Detail** — Tabelle aller Karts dieser Session + Chart
- **Kart-Detail** — Historie eines Karts über alle Sessions, Bestzeit,
  Betriebsstunden, Offset-Feld
- **Vergleich** — zwei Karts oder zwei Sessions nebeneinander
- **CSV-Export** pro Ansicht

### 6.2 Betriebsstunden

Für ein Kart:

```
stunden = offset_sec
for session in sessions_des_karts:
    t = session.kart_details[kart].total
    laps = session.kart_details[kart].laps
    extra = (t / laps) * 2 if laps > 0 else 0   # Intro + Outro
    stunden += t + extra
```

Der Offset kommt aus `kart_meta/{nr}.offset_sec`, wird im UI editiert
und via `setDoc(..., {merge:true})` zurückgeschrieben. Alle Geräte
sehen denselben Wert.

### 6.3 Kart-Kategorien (Namens-Konvention Emslandring)

| Bereich | Kategorie |
|---------|-----------|
| 1–9     | Mini |
| 10–29   | Leih |
| 30–49   | Renn |
| 50–56   | Super |
| 57–60   | Doppel |

Wird vom Server in `category_breakdown` gezählt und in der Analyse zur
Filterung/Einfärbung genutzt.

---

## 7. `config.txt`

UTF-8 **ohne BOM**, aber der Server liest mit `utf-8-sig`, also
BOM-tolerant.

```ini
[DEFAULT]
MYLAPS_HOST=192.168.178.152
MYLAPS_PORT=50000
WEBSOCKET_PORT=8765
HTTP_PORT=8080
FIREBASE_CREDENTIALS=firebase-key.json

[karts]
# Optional: Klarnamen pro Kart. Wird im Dashboard/Analyse angezeigt.
# 58 = Team ABC
# 12 = Fahrschule 1
```

Die `[karts]`-Sektion wird beim Start und bei File-Change-Detection
eingelesen (Hot Reload ohne Server-Neustart). Nur der Anzeigename
ändert sich — die Kart-Nummer bleibt Identifikator.

---

## 8. Betrieb / Deployment

### 8.1 requirements.txt

```
firebase-admin
websockets
```

Für **Python 3.8 / Windows 7** zwingend gepinnt:
```
cryptography==39.0.2
firebase-admin==6.2.0
google-auth==2.22.0     # nur falls Folgefehler
grpcio==1.48.2          # nur falls Folgefehler
websockets==10.4        # nur falls Folgefehler
```
Grund: aktuelle `cryptography` lädt unter Py 3.8 die Rust-DLL nicht
(`ImportError: DLL load failed while importing _rust`).

### 8.2 Windows-Autostart

Siehe `INSTALL_WINDOWS.md` für den vollständigen Walkthrough.
Zusammengefasst:

- Projektordner `C:\GoogleFirebase\` (keine Umlaute, keine Leerzeichen)
- `firebase-key.json` direkt da hineinlegen
- Aufgabenplanung → **„Nur wenn angemeldet"** + **„Ausgeblendet"**
- Aktion: `pythonw.exe mylaps_server.py` (nicht `python.exe` — sonst
  cmd-Fenster)
- „Starten in": `C:\GoogleFirebase`
- Bedingung „nur im Netzbetrieb" entfernen
- Einstellung „nach 3 Tagen beenden" entfernen

Damit läuft der Server unsichtbar als `pythonw.exe`-Hintergrundprozess.

### 8.3 Single-Instance-Lock

Der Server bindet beim Start einen lokalen Port als Lock. Zweite
Instanz → sauberer Exit mit Log. Verhindert doppelt-laufende
Aufgabenplaner-Aufrufe.

---

## 9. Bekannt-unbekannte Felder

Diese Felder kennen wir nicht im Detail, sie sind aber für den Betrieb
**irrelevant** — weder geschrieben noch ausgewertet:

| Nachricht | Feld | Beobachteter Wert | Status |
|-----------|------|-------------------|--------|
| `$F`      | Feld 1 | `9999`            | unbekannt, irrelevant. **Kein** GP-Sentinel. |
| `$A`      | letztes Feld | `12`        | unbekannt, irrelevant |
| `$C`      | Feld 1 | `12`              | unbekannt, irrelevant |
| `$I`      | —    | —                 | komplett ignoriert |

Sollte hier jemals ein abweichender Wert auftauchen, einfach
mitloggen — der Server verwirft ihn.

---

## 10. Nicht-verlässliche Heuristiken (Lessons Learned)

Folgende Ideen waren in älteren Versionen als GP-Erkennung im
Gespräch und haben sich als **falsch** erwiesen:

| Heuristik | Warum nicht |
|-----------|-------------|
| Status `RED` gesehen | kommt auch bei Training-Not-Aus |
| Countdown > `00:00:00` in `$F` | kommt auch bei Trainings-Vorlauf |
| `9999` in `$F` Feld 1 | konstanter Wert, kein Indikator |
| `$G` springt unplausibel | auch bei Trainings möglich, wenn Box neu einlogged |
| „primäres Ranking sofort da" | Reihenfolge des Eintreffens ist nicht deterministisch |
| Länge des Status-Feldes (6 Leerzeichen) | Box verändert das Padding |

**Einziges verlässliches Kriterium: `group_name == "RACE"`.**
Analog gilt für Session-Ende: nicht die Leerzeichen im Status
vergleichen, sondern `status.strip() == "FINISH"`.

---

## 11. Offene Punkte / TODO

| Punkt | Status |
|-------|--------|
| GP-Erkennung stabilisieren | ✅ erledigt (nur `RACE`) |
| Offset geräteübergreifend | ✅ erledigt (`kart_meta`) |
| Intro/Outro-Kompensation | ✅ erledigt (2× avg in analyse.html) |
| Live-Countdown im Dashboard | ✅ erledigt (Header, nur Zeit) |
| Pre-Start-Lichter GP | ✅ erledigt |
| Windows-7-Deployment dokumentiert | ✅ erledigt (`INSTALL_WINDOWS.md`) |
| BOM-Toleranz in config.txt | ✅ erledigt (`utf-8-sig`) |
| Hidden Autostart ohne Passwort | ✅ erledigt (`pythonw.exe`) |
| Semantik von `$F` Feld 1 (`9999`) | offen — aber irrelevant |
| Semantik von `$A` letztem Feld | offen — aber irrelevant |
| Semantik von `$C` Feld 1 | offen — aber irrelevant |
| Mehrere Boxen parallel | nicht geplant |
| Replay-Modus aus gespeicherten TCP-Mitschnitten | nice to have |

---

*Ende der Dokumentation. Änderungen bitte mit Datum + kurzer Notiz
am Ende dieses Dokuments festhalten.*
