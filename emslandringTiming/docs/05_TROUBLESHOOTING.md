# Troubleshooting – bekannte Probleme & Lösungen

Diese Datei sammelt alle Probleme, die in der Entwicklungs- und Betriebsphase
aufgetreten sind, inklusive Ursache und Fix. Wenn du auf ein Problem stößt, das hier
nicht steht — schick die Logs (`sudo journalctl -u emslandring-timing -n 100`) an
den Entwickler.

---

## 1. Service startet nicht

### Symptome

```
sudo systemctl status emslandring-timing
# Active: failed (Result: exit-code)
```

### Diagnose

```bash
sudo journalctl -u emslandring-timing -n 50 --no-pager
```

### Typische Ursachen

| Fehlermeldung | Ursache | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'X'` | Paket fehlt im venv | `~/emslandring-repo/emslandringTiming/.venv/bin/pip install -r requirements.txt` |
| `Address already in use` | Port 8081 wird von anderem Prozess belegt | `sudo lsof -i :8081` zeigt den Prozess, dann killen |
| `Permission denied: 'emslandring.db'` | Falsche Datei-Ownership | `sudo chown -R server:server ~/emslandring-repo` |
| `OSError: [Errno 98] Address already in use` (Decoder) | Zweite Instanz läuft | `sudo pkill -9 -f server/main.py` |
| `json.decoder.JSONDecodeError` | `config.json` ist kaputt | Backup einspielen oder löschen (wird mit Defaults neu erstellt) |

---

## 2. Restart hängt 90 Sekunden

### Symptome

```bash
sudo systemctl restart emslandring-timing
# Hängt am Passwort-Prompt oder direkt danach für 90 s
```

### Ursache

Ein Drucker-Subprocess (ProcessPoolExecutor) beendet sich nicht sauber. systemd
wartet 90 s auf SIGTERM, dann kommt SIGKILL.

### Fix

War ein bekannter Bug bis `stable-2026-05-05` (gRPC + fork()-Konflikt). Mittlerweile
behoben durch Umstellung auf `spawn`-Multiprocessing-Context. Falls es wieder
auftritt:

```bash
sudo pkill -9 -f "emslandringTiming/.venv/bin/python"
sudo systemctl reset-failed emslandring-timing
sudo systemctl start emslandring-timing
```

---

## 3. Decoder zeigt „Getrennt"

### Symptome

Top-rechts in der UI: rotes Punkt + „Getrennt" statt „Verbunden".

### Diagnose

```bash
ping -c3 192.168.178.193          # Decoder erreichbar?
nc -zv 192.168.178.193 5403       # Port offen?
sudo journalctl -u emslandring-timing -n 30 --no-pager | grep -i decoder
```

### Ursachen

| Ursache | Fix |
|---|---|
| Decoder ausgeschaltet | Strom prüfen, LEDs am Decoder |
| Netzwerk-Kabel locker | Switch-LED prüfen |
| IP-Konflikt | Decoder-Web-UI prüfen, ggf. statische IP neu setzen |
| Falsche IP/Port in der App | Einstellungen → Hardware → Decoder IP/Port |
| Firewall blockiert ausgehend | `sudo ufw status` — Default ist outgoing erlaubt |

### Wichtig

`connected=true` wird erst bei eingehendem HEARTBEAT gesetzt, **nicht** bei TCP-Connect.
Heartbeat kommt etwa alle 5 Sekunden. Wenn 15 s kein Heartbeat → System wertet
Verbindung als tot.

---

## 4. Drucker druckt nicht

### Symptome

- Drucken-Button drücken, nichts passiert
- Oder Fehlermeldung „CUPS-Fehler"

### Diagnose

```bash
lpstat -p                  # zeigt eingerichtete Drucker
lpstat -t                  # zeigt Status + offene Jobs
cancel -a                  # löscht alle Jobs
```

### Typische Ursachen

| Ursache | Fix |
|---|---|
| Drucker im CUPS deaktiviert | CUPS-Web-UI → Drucker → „Drucker fortsetzen" |
| Falscher Druckername in Settings | Einstellungen → Drucker → richtigen aus Dropdown wählen |
| Drucker offline | Strom, LAN-Kabel, USB-Kabel prüfen |
| Falscher Treiber | Generic PCL / PostScript versuchen |
| Toner leer | Toner tauschen, Test-Druck aus CUPS |
| Druckauftrag hängt | `cancel -a` |

### Vorschau prüfen

Bevor du den echten Drucker testest, prüfe ob das PDF korrekt generiert wird:

```
http://192.168.178.100:8081/api/runs/<run_id>/print-preview
```

Falls die Vorschau aussieht — Problem liegt am Drucker. Falls die Vorschau auch
kaputt — Problem im Code.

---

## 5. QR-Code im Ausdruck erscheint nicht

### Symptome

Bei einer Top-8-Bestzeit erscheint trotzdem nur das Logo, kein QR-Code.

### Checkliste

1. **Einstellung aktiviert?**
   - Browser → Einstellungen → Bestenliste · QR-Code → QR-Code aktiviert auf **Ja**
2. **Tunnel-URL gesetzt?**
   - Im selben Block: URL muss `https://...` enthalten, **ohne Slash am Ende**
3. **Kart wirklich in Top-8?**
   - Rankings öffnen, Klasse und Zeitraum prüfen — taucht das Kart auf?
4. **Server pulled?**
   - `cd ~/emslandring-repo && git log -1 --oneline` muss aktuelle Version zeigen
5. **Browser-Cache?**
   - **Strg+Shift+R** für Hard-Reload der Druck-Vorschau
6. **PDF aus Cache?**
   - Query-String anhängen: `?_=12345` an die Preview-URL

### Tunnel testen

```bash
curl -s -o /dev/null -w "Tunnel: %{http_code}\n" https://emslandring.tail2c13dd.ts.net
# Erwartet: 200
```

Wenn 502 oder timeout → Tailscale-Funnel offline:

```bash
sudo tailscale funnel --bg 8081
```

---

## 6. QR-Scan zeigt Warnseite (nur ngrok)

### Symptome

Beim Scannen des QR-Codes erscheint vor der eigentlichen Seite eine
„ngrok-free.app verlangt Zustimmung" Warnseite.

### Ursache

Das ist eine Anti-Missbrauch-Sperre von ngrok Free. Lässt sich auf dem Free-Plan
nicht abschalten.

### Fix

**Wechsel zu Tailscale Funnel** — keine Warnseite, ebenfalls gratis. Anleitung in
`02_INSTALL.md` Abschnitt 8.

---

## 7. „Diese Runde ist nicht mehr in der Bestenliste"

### Symptome

Customer scannt QR und sieht Fehlerseite „Eintrag nicht mehr möglich".

### Ursache

Zwischen Druck und Scan wurde die Bestzeit von einer schnelleren Runde aus der Liste
gedrängt. Das ist by-design: Wenn eine Runde nicht mehr in den Top-8 ist, soll auch
kein Name mehr eingetragen werden.

### Was tun?

Nichts — das ist gewolltes Verhalten. Erkläre dem Kunden ggf. dass jemand schneller
gefahren ist.

---

## 8. „Dieser Name ist leider nicht erlaubt"

### Symptome

Customer kann seinen Namen nicht eintragen.

### Ursache

Profanity-Filter hat angeschlagen. Liste der gesperrten Wörter:

```
~/emslandring-repo/emslandringTiming/server/data/profanity_de.txt
```

### Wenn der Filter zu aggressiv ist

Wort aus der Liste entfernen:

```bash
nano ~/emslandring-repo/emslandringTiming/server/data/profanity_de.txt
# Zeile löschen, Strg+O, Strg+X
sudo systemctl restart emslandring-timing
```

### Wenn der Filter zu lasch ist

Wort hinzufügen:

```bash
echo "neue_zensur" | sudo tee -a ~/emslandring-repo/emslandringTiming/server/data/profanity_de.txt
sudo systemctl restart emslandring-timing
```

Der Filter normalisiert auch l33t-Schreibweise (`h1tler`, `n@zi`), du musst nur das
Standardwort eintragen.

---

## 9. Stale Lauf vom Vortag blockiert

### Symptome

Beim ersten Aufruf am neuen Tag: Lauf 1 ist nicht scharf schaltbar.

### Ursache

Am Vortag wurde ein Lauf scharf geschaltet aber nie gefahren. Engine zeigt noch auf
diesen alten Lauf.

### Fix

Das System räumt das **automatisch** beim Service-Start oder beim ersten
`ensure_today_runs()`-Aufruf auf. Falls nicht:

```bash
sudo systemctl restart emslandring-timing
```

Falls auch das nicht hilft, manuell in der DB:

```bash
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "UPDATE runs SET status='done' WHERE status IN ('armed','running','paused','finishing') AND date < date('now');"
sudo systemctl restart emslandring-timing
```

---

## 10. Tab-Titel-Countdown läuft nicht

### Symptome

Im Browser-Tab steht weiter „emslandringTiming" obwohl ein Lauf läuft.

### Diagnose

1. Browser-Cache geleert? (Strg+Shift+R)
2. DevTools (F12) → Console → Fehler?

### Häufige Ursache

`app.js` ist aus dem Cache. **Hard-Reload mit Strg+Shift+R** löst das in 95 % der Fälle.

Bei dauerhaftem Problem: Inkognito-Tab probieren — wenn dort funktioniert, ist
Browser-Cache hartnäckig. Lösung: Browser-Daten manuell löschen.

---

## 11. Dashboard auf Pi geht nicht

### Symptome

Pi zeigt nur weißen Bildschirm oder „This site can't be reached".

### Checkliste

1. **Pi erreichbar?** Vom Bürorechner: `ping 192.168.178.200`
2. **Server erreichbar vom Pi?** SSH auf Pi: `ssh pi@192.168.178.200`, dann `curl -s -o /dev/null -w "%{http_code}\n" http://192.168.178.100:8081/dashboard`
3. **Konfig auf Pi richtig?** Datei `~/pi-kiosk/kiosk.env` muss `SERVER_HOST=192.168.178.100` und `HTTP_PORT=8081` enthalten

Details siehe `08_PI_DASHBOARD.md`.

---

## 12. Schriftart im Ausdruck falsch / fehlt

### Symptome

PDF-Ausdruck hat falsche Schriftart (z.B. Times New Roman statt Bebas Neue / Geom-Graphic).

### Ursache

WeasyPrint kann die Schriftarten nicht laden. Mögliche Gründe:

1. Schriftart-Dateien fehlen in `server/data/fonts/`
2. Pfad enthält Sonderzeichen (z.B. `OneDrive-Persönlich`)

### Fix

Schriftart-Dateien aus dem Repo holen:

```bash
ls ~/emslandring-repo/emslandringTiming/server/data/fonts/
# muss enthalten: Geom_Graphic_*.otf, Lato-*.ttf, BebasNeue-Regular.ttf,
# BarlowCondensed-*.ttf, Barlow-Regular.ttf, KonkretikaBlackWIP.ttf
```

Falls leer: Repo neu klonen / git pull. Falls trotzdem leer → der Entwickler muss
Schriftarten committen.

Bei Sonderzeichen-Problem: emslandringTiming/server/printer.py kopiert beim ersten
Druck die Schriftarten nach `/tmp/ems_fonts_cache/`, damit sollte das Problem
umgangen sein. Falls nicht: Berechtigung von `/tmp` prüfen.

---

## 13. Datenbank wächst zu schnell

### Symptome

DB ist nach wenigen Monaten mehrere GB groß.

### Diagnose

```bash
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "SELECT 'passings: ' || COUNT(*) FROM passings;
         SELECT 'decoder_health: ' || COUNT(*) FROM decoder_health;
         SELECT 'runs: ' || COUNT(*) FROM runs;"
```

Typische Verteilung:

- `passings`: Hauptanteil, ~70 % der DB-Größe
- `decoder_health`: ~25 %, alle 60 s ein Eintrag = ~1 Eintrag/Min × 60 Min × 12 h × 365 = ~260k pro Jahr
- `runs`: minimal

### Aufräumen

Decoder-Health älter als 1 Jahr löschen:

```bash
sudo systemctl stop emslandring-timing
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "DELETE FROM decoder_health WHERE recorded_at < unixepoch() - 365*86400;
         VACUUM;"
sudo systemctl start emslandring-timing
```

Passings älter als 2 Jahre würden Statistiken kaputtmachen — **nicht** löschen ohne
Rücksprache.

---

## 14. Ampel reagiert nicht

### Symptome

Lauf-Status ändert sich, Ampel bleibt aber dunkel.

### Diagnose

```bash
curl -u admin:password http://192.168.178.128/status.xml
# Sollte XML mit Relais-Status zurückgeben
```

### Häufige Ursachen

| Ursache | Fix |
|---|---|
| ETH008 nicht erreichbar | `ping 192.168.178.128` |
| Falsches Login | Einstellungen → Ampel → Benutzer/Passwort prüfen |
| Falsche Relais-Nummern | Einstellungen → Ampel → Relais Rot/Grün prüfen |
| Verkabelung lose | Klemmen am ETH008 prüfen |
| Ampel-Sicherung | im Sicherungskasten prüfen |
| Setting deaktiviert | „Ampel aktiviert" muss auf Ja stehen |

### Status im Logs

```bash
sudo journalctl -u emslandring-timing -n 50 --no-pager | grep -i ampel
```

Bei jedem Status-Wechsel sieht man Zeilen wie `[ampel] set green`.

---

## 15. Browser-Verbindung bricht ab

### Symptome

Live-Anzeige im Browser friert ein, oben rechts steht „Offline" oder kein Live-Punkt.

### Häufige Ursachen

| Ursache | Fix |
|---|---|
| WLAN am Browser-Gerät weg | WLAN prüfen |
| Service neu gestartet | Browser-Tab refreshen |
| Mac-Browser hat Tab in den Hintergrund gedrosselt | Tab kurz aktiv machen, Watchdog reconnectet automatisch |
| Server überlastet | Logs prüfen, ggf. Restart |

Das Frontend hat einen automatischen Reconnect-Watchdog der alle 10 s prüft —
spätestens nach 45 s sollte die Verbindung wieder stehen.

---

## 16. „Permission denied" Fehler

### Symptome

Im Log oder bei Befehlen: `Permission denied`.

### Häufige Stellen

| Datei/Ordner | Befehl |
|---|---|
| `emslandring.db` | `sudo chown server:server ~/emslandring-repo/emslandringTiming/emslandring.db` |
| `config.json` | `sudo chown server:server ~/emslandring-repo/emslandringTiming/config.json` |
| `/tmp/ems_fonts_cache` | `sudo chown -R server:server /tmp/ems_fonts_cache` |
| Komplettes Repo | `sudo chown -R server:server ~/emslandring-repo` |

---

## 17. Logs sind voll mit Ampel-Polling

### Symptome

`sudo journalctl -u emslandring-timing -f` zeigt sekündlich curl-Output für die
Ampel-Status-Abfrage.

### Ursache

`server/ampel.py` nutzt verbose curl-Output, das spammt das Log.

### Workaround

Beim Logs-Lesen einfach Ampel rausfiltern:

```bash
sudo journalctl -u emslandring-timing -f | grep -v ampel
```

Oder im Code: `-v` auf `-s` ändern in `server/ampel.py` (am besten als kleinen
Code-Fix einreichen).

---

## 18. systemd-Warnung: „unit file changed on disk"

### Symptome

Bei Service-Befehlen: `Warning: The unit file ... changed on disk. Run 'systemctl daemon-reload'`.

### Fix

```bash
sudo systemctl daemon-reload
```

Tritt auf wenn jemand `emslandring-timing.service` editiert hat. Einmaliger Reload
löst das.

---

## 19. Allgemeine Diagnose-Befehle

Wenn du keine Ahnung hast woran's hängt:

```bash
# Service-Status
sudo systemctl status emslandring-timing --no-pager
sudo systemctl status tailscaled         --no-pager
sudo systemctl status cups               --no-pager

# Logs aller drei
sudo journalctl -u emslandring-timing -n 30 --no-pager
sudo journalctl -u tailscaled         -n 30 --no-pager
sudo journalctl -u cups               -n 30 --no-pager

# Netzwerk
ip addr show
ping -c3 192.168.178.193   # Decoder
ping -c3 192.168.178.128   # Ampel
ping -c3 1.1.1.1           # Internet
nslookup tailscale.com     # DNS

# Ressourcen
free -h                    # RAM
df -h /                    # Disk
top -bn1 | head -20        # CPU & Top-Prozesse

# Software
curl -s -o /dev/null -w "Local:    %{http_code}\n" http://localhost:8081
curl -s -o /dev/null -w "Tunnel:   %{http_code}\n" https://emslandring.tail2c13dd.ts.net
lpstat -p                  # Drucker

# DB
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db "SELECT COUNT(*) FROM passings;"
```

Diese Diagnose-Daten an den Entwickler schicken → schneller Support möglich.

---

*Nächstes Kapitel:* `06_ARCHITECTURE.md` — Wie das System intern aufgebaut ist (für Entwickler).
