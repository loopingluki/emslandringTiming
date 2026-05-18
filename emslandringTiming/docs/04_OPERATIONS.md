# Tagesbetrieb & Wartung

Diese Datei beschreibt alle Tätigkeiten am laufenden System: Logs lesen, Updates
einspielen, Backups einrichten, Service verwalten.

---

## 1. Wichtige Pfade & Dateien

```
/home/server/emslandring-repo/                     ← Git-Repository
  ├── emslandringTiming/
  │   ├── config.json                              ← Konfiguration (Hot-Reload)
  │   ├── emslandring.db                           ← SQLite-Datenbank ⚠ BACKUP!
  │   ├── server/
  │   │   ├── data/
  │   │   │   ├── logo.png                         ← Druck-Logo
  │   │   │   ├── fonts/                           ← Schriftarten für Druck
  │   │   │   ├── templates/                       ← PDF-Druckvorlagen
  │   │   │   └── profanity_de.txt                 ← Wortliste Profanity-Filter
  │   │   └── *.py                                 ← Quellcode
  │   ├── web/
  │   │   ├── templates/                           ← HTML-Vorlagen
  │   │   └── static/                              ← JS/CSS
  │   └── docs/                                    ← Diese Doku
  │
/etc/systemd/system/
  ├── emslandring-timing.service                   ← Haupt-Service
  └── (optional) ngrok-emslandring.service         ← falls ngrok statt Tailscale
```

---

## 2. Service-Verwaltung

### 2.1 Status prüfen

```bash
sudo systemctl status emslandring-timing --no-pager
```

Erwartet: grüner Punkt + `Active: active (running)`.

### 2.2 Service starten / stoppen / neu starten

```bash
sudo systemctl start    emslandring-timing
sudo systemctl stop     emslandring-timing
sudo systemctl restart  emslandring-timing
```

Bei Code-Updates ist `restart` der normale Weg.

### 2.3 Autostart

```bash
sudo systemctl enable   emslandring-timing   # bei Reboot automatisch starten
sudo systemctl disable  emslandring-timing   # Autostart aus
```

### 2.4 Bei „Restart hängt"

Wenn `sudo systemctl restart emslandring-timing` länger als 90 s hängt:

```bash
# 1. Prozesse hart killen
sudo pkill -9 -f "emslandringTiming/.venv/bin/python"
# 2. Fehler-Marker entfernen
sudo systemctl reset-failed emslandring-timing
# 3. Frisch starten
sudo systemctl start emslandring-timing
sudo systemctl status emslandring-timing --no-pager | head -5
```

Ursache solcher Hänger ist meist ein Druck-Job, dessen Worker-Subprocess sich nicht
sauber beendet (siehe `05_TROUBLESHOOTING.md`).

---

## 3. Logs lesen

### 3.1 Live-Log (wie tail -f)

```bash
sudo journalctl -u emslandring-timing -f
```

`Strg+C` zum Verlassen. Zeigt jede Zeile sobald sie kommt.

### 3.2 Letzte 200 Zeilen

```bash
sudo journalctl -u emslandring-timing -n 200 --no-pager
```

### 3.3 Heute / Gestern

```bash
sudo journalctl -u emslandring-timing --since today --no-pager
sudo journalctl -u emslandring-timing --since yesterday --until today --no-pager
```

### 3.4 Spezielle Suche

Bestimmten Text finden (z.B. Fehler):

```bash
sudo journalctl -u emslandring-timing --no-pager | grep -i "error\|exception"
```

Ohne Ampel-Polling-Spam:

```bash
sudo journalctl -u emslandring-timing -n 200 --no-pager | grep -v ampel
```

### 3.5 Tailscale-Funnel-Logs

```bash
sudo journalctl -u tailscaled --since today --no-pager
```

---

## 4. Code-Update einspielen

Standard-Workflow nach einem Git-Push vom Entwickler:

```bash
cd ~/emslandring-repo
git pull
sudo systemctl restart emslandring-timing
sudo systemctl status emslandring-timing --no-pager | head -10
```

**Falls neue Python-Pakete (`requirements.txt` geändert):**

```bash
~/emslandring-repo/emslandringTiming/.venv/bin/pip install -r ~/emslandring-repo/emslandringTiming/requirements.txt
sudo systemctl restart emslandring-timing
```

**Im Browser:** Hard-Reload mit **Strg+Shift+R** (sonst lädt der Browser das alte
JavaScript aus dem Cache).

---

## 5. Datenbank-Backup

Die `emslandring.db` enthält alle Lauf-Daten, Customer-Claims, Decoder-Health usw.
**Sie ist die einzige unersetzliche Datei!** Alles andere kann jederzeit neu
installiert werden.

### 5.1 Manuelles Backup

```bash
mkdir -p ~/backups
DEST=~/backups/emslandring-$(date +%Y%m%d-%H%M%S).db
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db ".backup '$DEST'"
ls -lh $DEST
```

`sqlite3 .backup` ist sicher während der Service läuft (Online-Backup-API). Niemals
einfach `cp emslandring.db ...` während der Service schreibt!

### 5.2 Automatisches tägliches Backup (cron)

```bash
crontab -e
```

Folgende Zeile hinzufügen (sichert jeden Tag um 03:30 Uhr):

```cron
30 3 * * * sqlite3 /home/server/emslandring-repo/emslandringTiming/emslandring.db ".backup '/home/server/backups/emslandring-$(date +\%Y\%m\%d).db'" && find /home/server/backups -name 'emslandring-*.db' -mtime +30 -delete
```

Erklärung:

- Backup wird unter `~/backups/emslandring-YYYYMMDD.db` abgelegt
- Backups älter als 30 Tage werden gelöscht (verhindert dass die Platte vollläuft)

### 5.3 Backup auf USB-Stick

USB-Stick einstecken, einmalig formatieren als ext4 oder exfat. Mount-Pfad
herausfinden:

```bash
lsblk
# Typisch: /dev/sda1 wird automatisch unter /media/server/<label> gemountet
```

Backup-Skript:

```bash
cat > ~/backup_to_usb.sh <<'EOF'
#!/bin/bash
USB=/media/server/BACKUP    # Pfad anpassen!
if [ ! -d "$USB" ]; then
  echo "USB-Stick nicht gemountet unter $USB"
  exit 1
fi
sqlite3 /home/server/emslandring-repo/emslandringTiming/emslandring.db \
        ".backup '$USB/emslandring-$(date +%Y%m%d-%H%M%S).db'"
# behalte nur die 7 jüngsten
ls -t $USB/emslandring-*.db | tail -n +8 | xargs -r rm
echo "Backup OK: $USB/emslandring-$(date +%Y%m%d-%H%M%S).db"
EOF
chmod +x ~/backup_to_usb.sh
```

Test:

```bash
~/backup_to_usb.sh
```

Per cron täglich:

```cron
0 22 * * * /home/server/backup_to_usb.sh >> /home/server/backup.log 2>&1
```

### 5.4 Backup wiederherstellen

```bash
sudo systemctl stop emslandring-timing
cp /home/server/backups/emslandring-20260517.db \
   /home/server/emslandring-repo/emslandringTiming/emslandring.db
sudo systemctl start emslandring-timing
```

Wichtig: Service **vorher stoppen**, sonst gibt's Lock-Konflikte.

### 5.5 Config-Backup

`config.json` ändert sich selten, sollte aber auch gesichert werden. In das
USB-Backup einfach mit aufnehmen:

```bash
cp ~/emslandring-repo/emslandringTiming/config.json $USB/config-$(date +%Y%m%d).json
```

---

## 6. Decoder-Daten auswerten

### 6.1 Wieviele Passings heute?

```bash
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "SELECT COUNT(*) FROM passings p JOIN runs r ON r.id = p.run_id WHERE r.date = date('now');"
```

### 6.2 Aktuelle Decoder-Health

```bash
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "SELECT datetime(recorded_at,'unixepoch','localtime') AS t, noise, loop_signal FROM decoder_health ORDER BY recorded_at DESC LIMIT 10;"
```

`noise` sollte typisch unter 30, `loop_signal` über 100 sein. Werte deutlich darüber
oder darunter deuten auf Bahn-Probleme (Lichtschranke verdreckt, Schleife defekt).

### 6.3 Größe der DB

```bash
ls -lh ~/emslandring-repo/emslandringTiming/emslandring.db
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "SELECT COUNT(*) FROM passings;"
```

Typische Größenordnung: 100k–500k Passings pro Jahr, DB-Größe ~50–200 MB.

### 6.4 DB komprimieren

SQLite legt im Lauf der Zeit Lücken in der DB-Datei an (durch DELETEs). Einmal
jährlich:

```bash
sudo systemctl stop emslandring-timing
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db "VACUUM;"
sudo systemctl start emslandring-timing
```

Reduziert die Datei um typisch 5–15 %.

---

## 7. Drucker-Wartung

### 7.1 CUPS-Web-UI

```
http://192.168.178.100:631
```

Wartungs-Aufgaben:

- **Druckaufträge → Alle anzeigen → Druck**: stuck Jobs löschen
- **Drucker → Stopp → Wiederaufnehmen**: bei Drucker-Fehlern
- **Drucker → Wartung → Testseite drucken**: nach Drucker-Tausch

### 7.2 Stuck Jobs schnell löschen

```bash
cancel -a
```

Löscht alle Druckaufträge auf allen CUPS-Druckern.

### 7.3 Drucker neu hinzufügen

Wenn der Drucker getauscht wurde:

1. CUPS Web-UI → Drucker hinzufügen (siehe `02_INSTALL.md` Abschnitt 7)
2. Im Timing-UI → Einstellungen → Drucker → Neuer Drucker auswählen + Speichern

---

## 8. Tailscale-Wartung

### 8.1 Status prüfen

```bash
sudo tailscale status
sudo tailscale funnel status
```

### 8.2 Tunnel neu starten

```bash
sudo tailscale funnel --bg 8081
```

(funnel ist persistent — überlebt Reboots automatisch)

### 8.3 Funnel ausschalten

Wenn du Tailscale Funnel temporär abschalten willst (z.B. für Wartung):

```bash
sudo tailscale funnel --https=443 off
```

Achtung: Solange `qr_enabled=Ja` ist, werden QR-Codes mit toter URL gedruckt. Erst
`qr_enabled` in der Web-UI auf „Nein" stellen.

### 8.4 Bei Login-Problemen

Tailscale-Authentifizierung verfällt nicht — aber bei Account-Tausch:

```bash
sudo tailscale logout
sudo tailscale up --hostname=emslandring
# → URL kopieren, im Browser einloggen
```

---

## 9. Updates des Betriebssystems

Wöchentlich oder monatlich:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt autoremove -y
```

**Wenn Kernel-Update:** Reboot nötig.

```bash
sudo reboot
```

Service startet automatisch wieder. Nach Reboot prüfen:

```bash
sudo systemctl status emslandring-timing --no-pager | head -5
```

---

## 10. Disk-Space prüfen

```bash
df -h /
```

Wenn `/` über 80 % läuft:

```bash
du -h --max-depth=1 / 2>/dev/null | sort -hr | head -10
# zeigt die größten Ordner
sudo journalctl --vacuum-time=30d
# Logs älter als 30 Tage löschen
```

---

## 11. Fernzugriff via SSH

Vom Bürorechner aus:

```bash
ssh server@192.168.178.100
```

Dateien hin- und herkopieren (vom Mac/Linux):

```bash
# vom Server holen
scp server@192.168.178.100:/home/server/emslandring-repo/emslandringTiming/emslandring.db ./
# auf den Server schicken
scp ./logo.png server@192.168.178.100:/home/server/emslandring-repo/emslandringTiming/server/data/
```

---

## 12. Konfiguration manuell bearbeiten

Normalerweise via Web-UI. Aber manchmal will man direkt ins JSON:

```bash
nano ~/emslandring-repo/emslandringTiming/config.json
```

Die Software liest die Datei **live** neu (Hot-Reload, max. 5 s Verzögerung).
Für Decoder-IP-Änderungen oder Port-Wechsel ist allerdings ein Service-Restart
nötig.

**Vor dem Bearbeiten Backup machen:**

```bash
cp ~/emslandring-repo/emslandringTiming/config.json ~/config-backup-$(date +%Y%m%d).json
```

---

## 13. Wöchentliche Routine

Empfohlene Wartungs-Routine, einmal pro Woche (z.B. Montag früh):

```bash
#!/bin/bash
# Status
sudo systemctl status emslandring-timing --no-pager | head -3
sudo systemctl status tailscaled        --no-pager | head -3

# Disk
df -h /

# Backup-Größe
du -sh ~/backups

# DB-Größe + Passings-Count
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db \
        "SELECT 'DB: ' || (SELECT printf('%.1f MB', PAGE_SIZE * PAGE_COUNT / 1024.0 / 1024.0) FROM pragma_page_size, pragma_page_count) || ' / Passings: ' || COUNT(*) FROM passings;"

# letzte Fehler im Service
sudo journalctl -u emslandring-timing --since '7 days ago' --no-pager | grep -i 'error\|exception' | tail -10
```

Skript speichern als `~/weekly_check.sh`, ausführbar machen, ggf. per cron jeden
Montag um 08:00 ausführen lassen.

---

## 14. Notfall-Recovery

### Szenario A: Service startet nicht

```bash
sudo journalctl -u emslandring-timing -n 50 --no-pager
# Fehler in der Ausgabe lesen → siehe 05_TROUBLESHOOTING.md
```

### Szenario B: DB beschädigt

```bash
sudo systemctl stop emslandring-timing
sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db "PRAGMA integrity_check;"
# falls "ok" → wahrscheinlich kein DB-Problem
# falls Fehler → Backup einspielen (siehe 5.4)
```

### Szenario C: Komplett alles weg

Repo neu klonen + Backup-DB einspielen — siehe `07_MIGRATION.md`.

---

*Nächstes Kapitel:* `05_TROUBLESHOOTING.md` — Bekannte Probleme und ihre Lösungen.
