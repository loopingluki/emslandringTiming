# Installation – Schritt für Schritt

Diese Anleitung führt einen **neuen Server** vom blanken Ubuntu-USB-Stick bis zur
voll funktionsfähigen Timing-Anlage. Alle Befehle können 1:1 abgetippt werden.

**Zielzustand am Ende:**

- Ubuntu 24.04 LTS läuft
- `emslandringTiming`-Service läuft automatisch beim Hochfahren
- Operator-UI ist unter `http://192.168.178.100:8081` erreichbar
- Drucker ist eingerichtet
- Tailscale Funnel macht den Server für QR-Scans öffentlich
- Decoder + Ampel sind verbunden und funktionieren

**Geschätzte Zeit:** 2–3 Stunden inkl. Ubuntu-Installation.

---

## 1. Ubuntu installieren

### 1.1 USB-Stick vorbereiten

1. Ubuntu 24.04 LTS Desktop ISO herunterladen: https://ubuntu.com/download/desktop
2. USB-Stick mit Rufus (Windows) oder Etcher (Mac) bootbar machen.
3. USB-Stick in den neuen Mini-PC stecken, Bildschirm + Tastatur + Maus + LAN-Kabel
   anschließen.

### 1.2 Installation

1. PC einschalten, ggf. **F11/F12** für Boot-Menü → USB-Stick auswählen.
2. „Install Ubuntu" wählen, Sprache **Deutsch**.
3. Tastatur **Deutsch**, „Normale Installation" + „Updates herunterladen" anhaken.
4. „Festplatte löschen und Ubuntu installieren" (auf Mini-PC ohne andere Daten).
5. Zeitzone: **Europe/Berlin**.
6. Benutzer anlegen:
   - **Name:** Karthalle Server
   - **Rechnername:** `server` (das ist der Hostname, wichtig!)
   - **Benutzername:** `server`
   - **Passwort:** _<sicher wählen, aufschreiben>_
   - „Automatisch anmelden" **NICHT** anhaken (Sicherheit)
7. Installation läuft 15–20 Min, danach Neustart.

### 1.3 Erstes Update

Nach dem ersten Login Terminal öffnen (`Strg+Alt+T`) und ausführen:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
    git curl wget htop net-tools openssh-server \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf2.0-0 \
    libffi-dev shared-mime-info \
    cups cups-bsd printer-driver-postscript-hp \
    sqlite3
```

Was wird installiert:

- **git/curl/wget/htop**: Standard-Tools
- **openssh-server**: Damit du dich vom Bürorechner einloggen kannst (`ssh server@192.168.178.100`)
- **python3.12 + Komponenten**: Python-Umgebung
- **libpango/libcairo/...**: Systembibliotheken für WeasyPrint (PDF-Druck)
- **cups + Treiber**: Druckerverwaltung
- **sqlite3**: DB-Tool für gelegentliche Datenkontrolle (optional)

---

## 2. Netzwerk konfigurieren

Der Server **muss** eine statische IP haben, damit Browser/Pi/Drucker ihn immer finden.

### 2.1 Über die GUI

1. Einstellungen → Netzwerk → kabelgebundene Verbindung → Zahnrad-Symbol
2. Reiter **IPv4** → Methode auf **Manuell**
3. Adressen:
   - Adresse: `192.168.178.100`
   - Netzmaske: `255.255.255.0`
   - Gateway: `192.168.178.1`
4. DNS: `192.168.178.1, 1.1.1.1` (durch Komma getrennt)
5. **Anwenden** → Verbindung kurz aus- und wieder einschalten.

### 2.2 Test

```bash
ip addr show         # zeigt 192.168.178.100/24
ping -c3 192.168.178.1   # Router erreichbar
ping -c3 1.1.1.1         # Internet erreichbar
ping -c3 google.de       # DNS funktioniert
```

### 2.3 SSH-Zugang vom Bürorechner

Auf dem Bürorechner (Mac/Linux/Windows mit OpenSSH):

```bash
ssh-copy-id server@192.168.178.100
# Passwort eingeben — danach Login ohne Passwort möglich
ssh server@192.168.178.100
```

Ab jetzt kannst du alle weiteren Schritte vom Bürorechner aus per SSH machen,
musst nicht mehr am Mini-PC selbst sitzen.

---

## 3. Repository klonen

```bash
cd ~
git clone https://github.com/loopingluki/emslandringTiming.git emslandring-repo
cd emslandring-repo
ls
```

Erwartet: Du siehst u.a. den Ordner `emslandringTiming/`.

**Hinweis:** Im Klartext braucht das Repo Zugriff. Falls das Repo privat ist, vorher
einen Personal Access Token (PAT) auf github.com erstellen und beim Klonen als
Passwort verwenden.

---

## 4. Python-Umgebung anlegen

```bash
cd ~/emslandring-repo/emslandringTiming
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install weasyprint pypdf
```

Das installiert:

- aus `requirements.txt`: `fastapi`, `uvicorn`, `aiosqlite`, `python-multipart`,
  `firebase-admin`, `pikepdf`, `segno`
- zusätzlich: `weasyprint` (HTML→PDF) und `pypdf` (PDF-Overlay)

**Test:**

```bash
.venv/bin/python -c "import fastapi, segno, weasyprint; print('OK')"
```

---

## 5. Konfiguration

### 5.1 `config.json` erstellen

Beim ersten Start erzeugt die Software automatisch eine `config.json` mit Defaults.
Wir können sie auch von Hand erstellen, damit der Service direkt mit den richtigen
Werten startet:

```bash
nano ~/emslandring-repo/emslandringTiming/config.json
```

Inhalt:

```json
{
  "decoder_ip":              "192.168.178.193",
  "decoder_port":            5403,
  "http_port":               8081,
  "websocket_port":          8765,
  "emulator_port":           50000,
  "runs_per_day":            10,
  "training_duration_sec":   420,
  "gp_time_duration_sec":    720,
  "gp_laps_count":           15,
  "wait_time_sec":           60,
  "wait_time_gp_sec":        120,
  "firebase_credentials":    "",
  "printer":                 "",
  "ampel_ip":                "192.168.178.128",
  "ampel_port":              80,
  "ampel_username":          "admin",
  "ampel_password":          "password",
  "ampel_enabled":           false,
  "qr_enabled":              false,
  "qr_base_url":             "",
  "bestof_mode":             "per_kart"
}
```

Speichern mit `Strg+O`, Enter, `Strg+X`.

**Hinweise:**

- `firebase_credentials` leer lassen, wenn kein Firebase-Upload genutzt wird.
- `printer` leer lassen — wird später nach CUPS-Setup eingetragen.
- `qr_enabled` und `ampel_enabled` zunächst auf `false`, später aktivieren.
- `transponders` und `classes` müssen **nicht** in der `config.json` stehen — beim
  ersten Start kommen die Defaults aus `server/config.py` automatisch dazu.

### 5.2 Datenverzeichnis anlegen

Falls noch nicht vorhanden:

```bash
mkdir -p ~/emslandring-repo/emslandringTiming/server/data
```

Dort kommt später automatisch hin:

- `emslandring.db` (Datenbank — wird beim ersten Start angelegt)
- `logo.png` (über Web-UI hochzuladen)
- `fonts/` (kommt mit dem Repo)
- `templates/` (PDF-Druckvorlagen, kommt mit dem Repo)

---

## 6. systemd-Service einrichten

Damit `emslandringTiming` beim Hochfahren automatisch startet und bei Crashs neu
gestartet wird.

```bash
sudo nano /etc/systemd/system/emslandring-timing.service
```

Inhalt (Pfad anpassen wenn anderer Username als `server`):

```ini
[Unit]
Description=emslandringTiming – Kartbahn Zeitnahme
After=network-online.target cups.service
Wants=network-online.target

[Service]
Type=simple
User=server
Group=server
WorkingDirectory=/home/server/emslandring-repo/emslandringTiming
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/server/emslandring-repo/emslandringTiming/.venv/bin/python server/main.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Memory-Limit: bei Leak alle 24h Neustart
RuntimeMaxSec=86400

[Install]
WantedBy=multi-user.target
```

Speichern, dann:

```bash
sudo systemctl daemon-reload
sudo systemctl enable emslandring-timing
sudo systemctl start emslandring-timing
sudo systemctl status emslandring-timing --no-pager | head -10
```

Erwartet: `active (running)`.

**Test im Browser:**

Vom Bürorechner aus: `http://192.168.178.100:8081` öffnen — du solltest die
Timing-UI sehen.

---

## 7. Drucker einrichten (CUPS)

### 7.1 Drucker anschließen

- **USB-Drucker:** Per USB an den Mini-PC. Wird i.d.R. automatisch erkannt.
- **Netzwerk-Drucker:** Per LAN an den Switch. IP-Adresse merken (z.B. via
  Drucker-Display oder Router-Admin).

### 7.2 CUPS Web-UI aktivieren

```bash
sudo cupsctl --remote-admin --remote-any --share-printers
sudo systemctl restart cups
```

Damit ist `http://192.168.178.100:631` vom Netz aus erreichbar.

### 7.3 Drucker hinzufügen

1. Browser: `http://192.168.178.100:631/admin`
2. „Drucker und Klassen hinzufügen" → Login mit `server` + Passwort
3. „Drucker hinzufügen"
4. **USB-Drucker** auswählen oder **Netzwerkdrucker** mit IP eingeben (z.B.
   `socket://192.168.178.150:9100` für HP/Brother JetDirect)
5. Name vergeben (z.B. `Kyocera_P2235dn`) — der **wird genau so** in die
   `config.json` eingetragen!
6. Treiber auswählen — wenn der exakte nicht da ist, **„Generic PCL Printer"** oder
   **„Generic PostScript Printer"** funktioniert meistens.
7. „Drucker hinzufügen"
8. Testseite drucken → falls OK weiter, sonst Treiber wechseln.

### 7.4 Drucker in der App aktivieren

Im Browser → Einstellungen → **Drucker** → Drucker-Dropdown öffnen → den eben
angelegten auswählen → **Speichern**.

Test: Einen erledigten Lauf auswählen → Drucker-Symbol → „Alle Karts drucken".

---

## 8. Tailscale Funnel einrichten (für QR-Code-Feature)

Damit Kunden per Handy den QR-Code scannen und ihren Namen eintragen können, muss
der Server unter einer **öffentlichen URL** erreichbar sein. Tailscale Funnel ist
die einfachste kostenlose Lösung.

### 8.1 Account anlegen

1. https://login.tailscale.com/start öffnen
2. Mit Google/Microsoft/GitHub registrieren (kostenlos)

### 8.2 Tailscale auf Ubuntu installieren

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### 8.3 Server mit Account verbinden

```bash
sudo tailscale up --hostname=emslandring
```

Es erscheint eine URL wie `https://login.tailscale.com/a/abc123xyz`.
Diese URL **am Bürorechner im Browser öffnen**, mit dem gleichen Account einloggen,
„Connect" klicken.

### 8.4 HTTPS + MagicDNS aktivieren

1. https://login.tailscale.com/admin/dns öffnen
2. **„MagicDNS"** aktivieren (Toggle)
3. **„HTTPS Certificates"** aktivieren (Toggle)

### 8.5 Funnel aktivieren

In der Admin-Console:

1. https://login.tailscale.com/admin/acls öffnen
2. Im ACL-Editor sicherstellen dass der Block existiert:
```json
"nodeAttrs": [
  {
    "target": ["*"],
    "attr":   ["funnel"]
  }
]
```
3. **Save**.

### 8.6 Funnel starten

Auf dem Ubuntu:

```bash
sudo tailscale funnel --bg 8081
```

Output enthält eine Zeile wie:
```
Available on the internet:
https://emslandring.tail2c13dd.ts.net/
```

**Diese URL notieren!** Sie wird gleich in die App eingetragen.

### 8.7 In der App aktivieren

Browser → Einstellungen → **Bestenliste · QR-Code**:

- QR-Code aktiviert: **Ja**
- Tunnel-URL: `https://emslandring.tail2c13dd.ts.net` (ohne Slash am Ende, deine
  tatsächliche URL einsetzen!)
- **Speichern**

### 8.8 Test

1. Druck-Vorschau eines Laufes aufrufen, der eine Top-8-Bestzeit enthält:
   `http://192.168.178.100:8081/api/runs/<run_id>/print-preview`
2. Bei qualifizierten Karts erscheint ein QR-Code statt Logo.
3. QR mit dem **Handy** (über Mobilfunk, **nicht** WLAN) scannen → sollte deine
   Mobile-Seite öffnen.

---

## 9. Ampel anschließen (optional)

### 9.1 Hardware

1. Devantech ETH008 mit Strom (12 V) und LAN verbinden.
2. Statische IP `192.168.178.128` setzen (Web-UI des ETH008 unter dessen Default-IP
   öffnen, Einstellungen → Network → Static).
3. Login: `admin` / `password` (Default — am besten ändern in der ETH008-Web-UI).

### 9.2 Verkabelung

```
Relais 4 (Rot)
  COM ──── L (230V)
  NO  ──── Lampe Rot ──── N (230V)

Relais 6 (Grün)
  COM ──── L (230V)
  NO  ──── Lampe Grün ─── N (230V)
```

**WICHTIG:** Verkabelung 230 V nur durch Elektrofachkraft! Die Relais des ETH008
können bis 16 A schalten.

### 9.3 In der App aktivieren

Browser → Einstellungen → **Ampel**:

- Ampel aktiviert: **Ja**
- IP: `192.168.178.128`
- Port: `80`
- Benutzer: `admin`
- Passwort: _<wie in ETH008 gesetzt>_
- Relais Rot: `4`
- Relais Grün: `6`
- **Speichern**

Test: Im Timing-UI rechts oben sollte „Ampel ✓" stehen. Lauf scharf schalten → die
Ampel sollte sich entsprechend der konfigurierten Sequenz schalten.

---

## 10. Logo hochladen

Für den Ergebnisausdruck oben rechts:

1. Browser → Einstellungen → **Drucker** → „Logo für Ausdruck"
2. PNG-Datei (z.B. Karthallenlogo, transparenter Hintergrund) hochladen
3. Vorschau erscheint, **Speichern**

Empfohlene Größe: ca. 800×600 Pixel, PNG mit transparentem Hintergrund.

---

## 11. Klassen und Transponder einrichten

Die Software liefert Default-Daten für die Emslandring-Konfiguration mit. Für eine
**neue Kartbahn** musst du das anpassen:

### 11.1 Klassen

Browser → Einstellungen → **Klassen** (in der Web-UI nicht direkt editierbar — über
JSON anpassen):

```bash
nano ~/emslandring-repo/emslandringTiming/config.json
```

Block ergänzen/anpassen:

```json
"classes": [
  {"name": "Minikart",  "color": "#f9a800"},
  {"name": "Leihkart",  "color": "#1565c0"},
  {"name": "Rennkart",  "color": "#c62828"},
  {"name": "Superkart", "color": "#757575"}
],
```

### 11.2 Transponder

Im selben File:

```json
"transponders": {
  "8534580": {"kart_nr": 1, "name": "Kart 1", "class": "Minikart"},
  "7203974": {"kart_nr": 2, "name": "Kart 2", "class": "Minikart"},
  ...
}
```

Format: `"<Transponder-ID>": {"kart_nr": <Kart-Nummer>, "name": "<Anzeigename>", "class": "<Klassen-Name>"}`.

Die Transponder-IDs stehen auf den Aufklebern der MyLaps-Transponder.

Nach dem Speichern: Konfiguration wird automatisch nachgeladen (Hot-Reload, max. 5 s
Wartezeit) — kein Service-Neustart nötig.

---

## 12. Verifikations-Tests

### 12.1 Basis-Funktion

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8081
# Erwartet: HTTP 200
```

### 12.2 Decoder-Verbindung

Browser → Timing-UI → Top-rechts sollte stehen:
- 🟢 „Verbunden" (Decoder gefunden)
- „Noise: 8 · Loop: 119" (Werte ändern sich)

Falls nicht: `sudo journalctl -u emslandring-timing -f` zeigt die Verbindungsfehler.

### 12.3 Drucker-Test

Einen abgeschlossenen Test-Lauf (mind. 1 Kart) drucken — der erste echte Druck testet
die ganze Pipeline.

### 12.4 Tailscale-Tunnel

```bash
curl -s -o /dev/null -w "Tunnel: %{http_code}\n" https://emslandring.tail2c13dd.ts.net
# Erwartet: 200 (eigene URL einsetzen!)
```

### 12.5 Datenbank wird geschrieben

```bash
ls -la ~/emslandring-repo/emslandringTiming/emslandring.db
# sollte > 0 Bytes haben, Mtime aktuell
```

---

## 13. Härtung & Sicherheit

### 13.1 Automatische Sicherheitsupdates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
# Auf „Ja" klicken
```

### 13.2 Firewall (UFW)

```bash
sudo ufw allow 22/tcp        # SSH
sudo ufw allow 8081/tcp      # emslandringTiming UI
sudo ufw allow 50000/tcp     # MyLaps Emulator (Kloft-Bridge)
sudo ufw allow 631/tcp       # CUPS
sudo ufw enable
sudo ufw status
```

Tailscale-Traffic geht durch Tailscale-eigene Verschlüsselung, braucht keine
UFW-Regel.

### 13.3 SSH absichern

```bash
sudo nano /etc/ssh/sshd_config
```

Folgende Zeilen setzen/ändern:

```
PasswordAuthentication no    # nur Key-Login
PermitRootLogin no
```

Wichtig: VORHER per `ssh-copy-id` deinen Public Key hochladen! Sonst sperrst du dich aus.

```bash
sudo systemctl restart ssh
```

---

## 14. Backup einrichten

Automatisches tägliches Backup der Datenbank auf einen externen USB-Stick oder
Netzwerk-Share. Siehe `docs/04_OPERATIONS.md` Abschnitt „Backup".

---

## 15. Checkliste „Server fertig"

- [ ] Ubuntu 24.04 LTS installiert, alle Updates eingespielt
- [ ] Statische IP `192.168.178.100/24` konfiguriert
- [ ] SSH funktioniert vom Bürorechner
- [ ] Repo unter `~/emslandring-repo` geklont
- [ ] Python-venv mit allen Paketen angelegt
- [ ] `config.json` mit korrekten IPs angelegt
- [ ] systemd-Service `emslandring-timing` läuft (`active (running)`)
- [ ] Browser zeigt Timing-UI unter `http://192.168.178.100:8081`
- [ ] Drucker in CUPS angelegt, Drucker-Name in Settings eingetragen
- [ ] Tailscale aktiviert, Funnel-URL läuft und ist in Settings eingetragen
- [ ] Ampel-ETH008 verbunden und konfiguriert (falls vorhanden)
- [ ] Logo hochgeladen
- [ ] Klassen + Transponder in `config.json`
- [ ] Decoder zeigt „Verbunden" mit Noise/Loop-Werten
- [ ] Test-Lauf durchlaufen lassen, Ausdruck OK
- [ ] QR-Code im Ausdruck erscheint, Scan vom Handy öffnet Mobile-Seite
- [ ] Firewall aktiv, automatische Updates an
- [ ] DB-Backup-Strategie umgesetzt

---

*Nächstes Kapitel:* `03_CONFIGURATION.md` — Web-UI Tour & alle Settings im Detail.
