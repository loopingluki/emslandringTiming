# Konfiguration & Bedienung

Diese Datei beschreibt alle Einstellungen und Bedienschritte der Web-UI. Sie ist
sowohl Referenz für den Operator als auch Bedienungsanleitung für neue Mitarbeiter.

---

## 1. Web-UI öffnen

Im Browser am Kabinen-PC (oder von jedem anderen PC im LAN):

```
http://192.168.178.100:8081
```

Empfohlene Browser: **Chrome**, **Firefox**, **Edge** — aktuelle Version. Safari
funktioniert auch, ist aber bei längerem Tab-Hintergrund-Lauf weniger zuverlässig
(siehe Tab-Drosselung).

---

## 2. Ansichten (Navigation)

Links am Rand sind die Hauptansichten:

| Symbol | Ansicht | Beschreibung |
|---|---|---|
| 🏁 | **Timing** | Live-Anzeige des aktiven Laufs + Lauf-Liste |
| 📊 | **Rankings** | Bestenlisten (Tag/Woche/Monat/Jahr) pro Klasse |
| 🛠 | **Einstellungen** | System-Konfiguration |
| 🚦 | **Transponder** | Liste aller eingerichteten Karts |

---

## 3. Timing-Ansicht

### 3.1 Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ emslandringTiming  · Verbunden · Noise:8 · Loop:119  · 🚦 Ampel ✓   │
├──────────────────┬──────────────────────────────────────────────────┤
│ ◀ 17.05.2026 ▶  │ Lauf 3 – Training                                │
│                  │ ⏱ 06:42 / 07:00  ● LÄUFT                         │
│ ✓ Lauf 1 ▤      │ [▶ Start] [⏸ Pause] [⏹ Stop] [🖨 Drucken]      │
│ ✓ Lauf 2 ▤      ├──────────────────────────────────────────────────┤
│ ● Lauf 3 🟢     │ Pos │ Nr │ Name      │ Best   │ Letzte │ Ø5    │
│   Lauf 4        │  1  │ 19 │ Kart 19   │ 1:02.4 │ 1:03.1 │ 1:02.8│
│   Lauf 5        │  2  │ 32 │ Kart 32   │ 1:03.5 │ 1:03.5 │ 1:03.2│
│   ...           │  3  │ 11 │ Kart 11   │ 1:04.7 │ 1:05.0 │ 1:04.9│
│   [+]           │  ...                                              │
└──────────────────┴──────────────────────────────────────────────────┘
```

### 3.2 Lauf-Liste links

Pro Tag werden automatisch `runs_per_day` (Standard: 10) Läufe angelegt.

Lauf-Symbole:

| Symbol | Bedeutung |
|---|---|
| (grau) | `pending` — wartet auf scharf schalten |
| 🟡 | `armed` — scharf geschaltet, wartet auf ersten Durchgang |
| ● grün | `running` — Lauf läuft, Timer tickt runter |
| ⏸ | `paused` — pausiert |
| ⏳ | `finishing` — Timer ist abgelaufen, letzte Runden zählen noch |
| ✓ grau | `done` — abgeschlossen, in DB gespeichert |

**Aktionen pro Lauf:**

- **Klick:** Lauf auswählen (rechts werden die Karts angezeigt)
- **Rechtsklick:** Kontextmenü mit Lauf-Einstellungen + Kart-Namen-Editor
- **„+" unten:** weiteren Lauf am Ende des Tages anhängen

**Datum-Navigation:** Pfeile links/rechts. Vergangene Tage sind read-only.

### 3.3 Lauf scharf schalten und starten

#### Training

1. Lauf aus der Sidebar wählen
2. **„Scharf schalten"** klicken — Status wechselt zu 🟡 `armed`
3. Sobald das erste Kart die Lichtschranke überquert, startet der Timer automatisch
4. Lauf endet wenn Timer 0 erreicht + Wartezeit (`wait_time_sec`, Default 60 s) abgelaufen ist
5. Alternativ jederzeit **„Stop"** drücken — Lauf wird sofort als `done` gespeichert

#### Grand Prix (Zeit)

1. Lauf-Einstellungen → Modus auf **„Grand Prix Zeit"**
2. „Scharf schalten" → 🟡 `armed`
3. Wenn alle Fahrer im Auto sitzen: **„Start"** → grünes Licht, Timer läuft
4. Nach Ablauf der Zeit + Wartezeit auf alle Karts → `done`

#### Grand Prix (Runden)

1. Lauf-Einstellungen → Modus auf **„Grand Prix Runden"** + Rundenanzahl setzen
2. „Scharf schalten" → 🟡 `armed`
3. **„Start"** → Rennen läuft
4. Sobald führendes Kart die Soll-Rundenanzahl erreicht → `finishing`
5. Alle anderen Karts können noch eine letzte Runde fahren → `done`

### 3.4 Kart-Tabelle rechts

Spalten:

| Spalte | Bedeutung |
|---|---|
| **Pos** | Aktueller Platz |
| **Nr** | Kart-Nummer |
| **Name** | Anzeigename (Default: „Kart 19"; oder Lauf-Override) |
| **Runden** | Anzahl gewerteter Runden (nur GP) |
| **Best** | Beste Rundenzeit |
| **Letzte** | Letzte Rundenzeit |
| **Ø5** | Mittelwert der letzten 5 Runden |
| **Trend** | ↑ schneller / ↓ langsamer / → stabil |
| **Sig** | Signalstärke beim letzten Durchgang (0–255) |

**Klick auf eine Kart-Zeile:** Öffnet ein Detail-Modal mit allen Rundenzeiten und
einem Verlaufs-Chart.

### 3.5 Tab-Titel-Countdown

Wenn ein Lauf läuft, zeigt der Browser-Tab statt nur „emslandringTiming" die
verbleibende Zeit:

- `⏱ 04:23 · Lauf 3 – Training` während `running`
- `⏸ 04:23 · Lauf 3` während `paused`
- `🏁 00:30 Lauf 3` während `finishing`
- `emslandringTiming` wenn idle

So sehen Mitarbeiter den Countdown auch wenn sie den Tab gewechselt haben.

---

## 4. Rankings-Ansicht

Zeigt die Bestenlisten pro Klasse und Zeitraum.

### 4.1 Filter

- **Klasse:** Dropdown mit allen Klassen (Minikart, Leihkart, Rennkart, ...)
- **Zeitraum:** Tag / Woche / Monat / Jahr

### 4.2 Tabelle

| Spalte | Bedeutung |
|---|---|
| **Platz** | 1, 2, 3, ... |
| **Kart** | Nummer + Name (oder Customer-eingetragener Name) |
| **Klasse** | Aktive Klasse |
| **Zeit** | Beste Rundenzeit |
| **Datum** | Tag (bei Tagesliste: Uhrzeit) |
| **Aktion** | Lösch-Button |

### 4.3 Aktionen pro Eintrag

**🗑 (rotes Mülleimer):** Komplette Runde aus der DB löschen — *unwiderruflich*. Nutze
das, wenn z.B. ein falsch erfasster Durchgang die Bestenliste verfälscht hat.

**✕ Name (nur bei Customer-Claims sichtbar):** Setzt den vom Customer eingetragenen
Namen zurück. Die Runde bleibt in der Bestenliste, nur der Name fällt wieder auf
„Kart X" zurück. Nutze das bei beleidigenden / unsinnigen Namen.

Beim Customer-eingetragenen Namen erscheint daneben ein gelbes **Customer-Badge**.

---

## 5. Einstellungen

### 5.1 Allgemein

| Feld | Bedeutung | Default |
|---|---|---|
| **Läufe pro Tag** | Wie viele Läufe werden automatisch beim Tageswechsel angelegt | 10 |
| **Trainingsdauer** | Standard-Zeit eines Trainings | 7:00 (420 s) |
| **GP-Zeit Dauer** | Standard-Zeit eines Grand Prix (Zeitmodus) | 12:00 (720 s) |
| **GP-Runden Anzahl** | Standard-Rundenzahl für GP (Rundenmodus) | 15 |
| **Wartezeit (Training)** | Nach Timer = 0 noch Sekunden warten auf Nachzügler | 60 |
| **Wartezeit (GP)** | Wartezeit Grand Prix | 120 |

### 5.2 Hardware

| Feld | Bedeutung | Default |
|---|---|---|
| **Decoder IP** | IP-Adresse des MyLaps RC4 | `192.168.178.193` |
| **Decoder Port** | TCP-Port | `5403` |
| **HTTP Port** | Port der Web-UI | `8081` |
| **WebSocket Port** | (Legacy, nicht mehr genutzt — WS läuft über HTTP-Port) | `8765` |
| **Emulator Port** | Für Kloft-Bridge | `50000` |
| **Emulator aktiviert** | MyLaps-ASCII-Server starten | aktiv |

Decoder- und Drucker-IP ändert man hier wenn sich die Hardware-Adressen ändern.
**Achtung:** Bei Port-Änderungen muss der Service neu gestartet werden.

### 5.3 Ampel

| Feld | Bedeutung |
|---|---|
| **Aktiviert** | Ja/Nein |
| **IP** | IP des ETH008 |
| **Port** | HTTP-Port (Default 80) |
| **Benutzer / Passwort** | Login der ETH008-Web-UI |
| **Relais Rot** | Kanalnummer (1–8) |
| **Relais Grün** | Kanalnummer (1–8) |

**Sequenzen:**

Pro Zustand kann eingestellt werden, was die Ampel zeigt:

| Zustand | Default | Möglich |
|---|---|---|
| Training scharf | `none` | `none`, `red`, `green`, `off` |
| Training Start | `green` | dito |
| Training Finish | `red` | dito |
| GP Start | `green` | dito |
| GP Finish | `red` | dito |
| Lauf fertig | `off` | dito |
| Unscharf | `off` | dito |

### 5.4 Drucker

| Feld | Bedeutung |
|---|---|
| **Ausgabedrucker** | Dropdown — alle in CUPS bekannten Drucker |
| **Netzwerkdrucker** | Liste von `IP:Port` für Drucker die CUPS nicht auto-findet |
| **Logo für Ausdruck** | PNG-Datei für oben rechts auf dem Ausdruck |
| **🔄 Refresh** | CUPS-Drucker neu suchen |

**Hinweis:** Wenn QR-Code aktiviert ist (siehe unten), wird das Logo durch den
QR-Code ersetzt — aber nur bei Karts, die in eine Top-8-Bestenliste qualifiziert
sind. Andere Karts bekommen weiterhin das Logo.

### 5.5 Defekt-Erkennung

Pro Klasse einstellbar. Erkennt Karts mit langsam werdenden Rundenzeiten (z.B.
schwächelnder Motor, Reifen kaputt).

| Feld | Bedeutung |
|---|---|
| **Aktiviert** | Ja/Nein pro Klasse |
| **Schwelle (Sek pro Runde)** | Über dieser Zeit ist ein Defekt-Verdacht | 60–90 s |
| **WMA-Fenster (N Runden)** | Über wie viele Runden wird der Mittelwert gebildet | 5–30 |
| **Ausreißer-Faktor** | Runden über (Median × Faktor) werden gefiltert | 1.5 |

Der Defekt-Verdacht zeigt sich als Badge im Transponder-Modal — kein Live-Alarm.

**Wie es funktioniert:**

1. Letzte N Runden des Karts werden geholt
2. Median dieser Runden wird berechnet
3. Alle Runden, die mehr als `median × faktor` sind (z.B. ein Crash mit 3-Minuten-Runde),
   werden verworfen
4. Aus den verbleibenden „sauberen" Runden wird ein **gewichteter Mittelwert** (WMA)
   gebildet (jüngere Runden zählen mehr)
5. Liegt der WMA über der Schwelle → Defekt-Verdacht

### 5.6 Bestenliste · Ranking-Modus

Wie oft darf ein Kart in einer Bestenliste auftauchen?

| Option | Verhalten |
|---|---|
| **Pro Kart 1 Eintrag** (Standard) | Kart 52 erscheint nur einmal pro Liste mit der absolut schnellsten Zeit im Zeitraum |
| **Pro Lauf 1 Eintrag** | Pro (Kart, Lauf)-Kombination ein Eintrag. Kart 52 kann z.B. mit drei verschiedenen Top-Zeiten aus drei Läufen mehrfach in der Wochenliste stehen — aber nicht 5× aus demselben Lauf |

### 5.7 Bestenliste · QR-Code

Aktiviert das Feature „Customer trägt seinen Namen ein".

| Feld | Bedeutung |
|---|---|
| **QR-Code aktiviert** | Wenn aus, wird auf Ausdrucken wieder das Logo gedruckt |
| **Tunnel-URL** | Öffentliche URL (z.B. `https://emslandring.tail2c13dd.ts.net`) |

**Empfehlung:** Bei Tunnel-Ausfall (z.B. Tailscale down) einfach hier auf „Nein"
stellen — Logo wird wieder gedruckt, sonst läuft alles weiter wie gewohnt.

---

## 6. Transponder-Verwaltung

Liste aller in der `config.json` eingerichteten Karts.

| Spalte | Bedeutung |
|---|---|
| **Transponder-ID** | Aufgedruckt auf dem Transponder am Kart |
| **Kart-Nr** | Nummer auf der Verkleidung |
| **Name** | Anzeigename (Default „Kart 19", änderbar) |
| **Klasse** | Minikart / Leihkart / Rennkart / Superkart |
| **Gesamt-Laufzeit** | Summe aller im System gefahrenen Runden (Tage / H:M) |
| **Letzte Stärke** | Signalstärke beim letzten Durchgang |

**Klick auf eine Zeile:** Öffnet Detail-Modal mit:
- Letzte 50 Rundenzeiten (inkl. Bestzeit-Markierung)
- WMA über das Defekt-Fenster
- Defekt-Badge (wenn aktiviert + Schwelle überschritten)
- Verlaufschart der Signalstärken (Sparkline)

---

## 7. Bedien-Workflow: Ein typischer Tag

### 7.1 Vor Öffnung

1. Server hochfahren (falls 24/7 läuft → bleibt eh an)
2. Browser am Kabinen-PC öffnen → Timing-UI laden
3. **Top-rechts** prüfen: Decoder „Verbunden", Ampel ✓, Drucker erkannt
4. „Heute" wird automatisch angezeigt — Läufe 1–10 stehen als `pending`

### 7.2 Während des Tages

Pro Lauf:

1. Karts auf die Bahn schicken
2. „Lauf X" auswählen → „Scharf schalten"
3. Erstes Kart fährt → Timer läuft
4. Während des Laufs: Live-Tabelle beobachten, ggf. Pause, ...
5. Timer läuft ab oder „Stop" — Lauf endet
6. „Alle Karts drucken" → Zettel kommen aus dem Drucker
7. Karts in die Box → Beleg-Übergabe → nächster Lauf

### 7.3 Bei besonderen Fällen

| Situation | Aktion |
|---|---|
| Kart fällt aus | Nichts tun — Lauf läuft trotzdem zu Ende |
| Kart-Tausch mitten im Lauf | Rechtsklick → Kart-Namen ändern (überschreibt für diesen einen Lauf) |
| Kunde will Namen in Bestenliste | QR-Code auf seinem Beleg scannen, Name eintragen |
| Unsinniger Customer-Name | Rankings → ✕ Name |
| Falsche Rundenzeit erfasst | Klick auf Kart-Zeile → Detail-Modal → Runde löschen |
| Lauf gestartet aber abgebrochen | „Stop" → Lauf bekommt Status `done` mit den bisherigen Zeiten |
| Drucker streikt | QR-Code temporär deaktivieren, Lauf manuell mit `lp` drucken oder PDF herunterladen |

### 7.4 Nach Schließung

- Service läuft weiter (24/7 — kein Abschalten nötig)
- Bei Tagesabschluss wird die Datenbank automatisch über Cron gesichert (siehe
  `04_OPERATIONS.md`)
- Backup-USB-Stick gegen den vom Vortag austauschen (täglich rotieren)

---

## 8. Sonderfälle

### 8.1 Lauf hängengeblieben vom Vortag

Wenn am Vorabend ein Lauf scharf geschaltet aber nie gefahren wurde, ist er beim
Tageswechsel noch im Status `armed`. **Das System räumt das automatisch auf:**

- Beim Service-Start
- Beim ersten Aufruf von „heutiger Tag"

Stale Läufe werden auf `done` gesetzt, die Race-Engine zurückgesetzt — Lauf 1 des
neuen Tages kann wieder scharf geschaltet werden.

### 8.2 Decoder kommt nicht hoch

Symptome: Top-rechts steht „Getrennt" + rotes Punkt.

1. Decoder neu starten (Stecker ziehen, 10 s warten, wieder rein)
2. Im Browser den Service-Status prüfen: top-rechts klicken → Diagnose-Modal
3. Falls Decoder weiterhin nicht da: `sudo systemctl restart emslandring-timing`
4. Bei dauerhaftem Problem: Kabel, IP-Konflikt, Switch-Port prüfen

### 8.3 Eintragen von Vergleichsläufen

Manchmal soll ein Lauf zu Vergleichszwecken in die DB, ohne dass er „echt" gewertet
wird. Workflow: Lauf normal fahren, nach Abschluss in den Rankings den Eintrag löschen.
Damit verschwindet er aus den Bestenlisten — die Lauf-Historie selbst bleibt.

---

*Nächstes Kapitel:* `04_OPERATIONS.md` — Tagesbetrieb, Logs, Backup, Service-Verwaltung.
