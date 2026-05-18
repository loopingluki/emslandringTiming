# Migration & Backup-PC einrichten

Diese Datei beschreibt zwei eng verwandte Szenarien:

1. **Backup-PC parallel zum laufenden System aufbauen** — falls der Hauptserver
   ausfällt, ist ein zweiter Rechner sofort einsatzbereit.
2. **Migration auf neuen Server** — der Hauptserver soll durch einen neuen ersetzt
   werden (z.B. nach Hardware-Defekt oder Upgrade).

---

## 1. Strategien-Übergang

```
┌────────────────────────────────────────────────────────────────────┐
│           Strategie A: Aktiver Backup-PC                           │
│           (komplexer, aber unterbrechungsfrei)                     │
│                                                                    │
│   PRIMARY (192.168.178.100) ───┐                                  │
│                                 │ DB-Sync 1×/Tag                  │
│                                 ▼                                  │
│   BACKUP (192.168.178.101)   gleiche Config, kein Decoder-Lock    │
│                                                                    │
│   Bei Ausfall: BACKUP übernimmt IP, Service wird gestartet        │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│           Strategie B: Cold-Standby Backup-PC                      │
│           (einfacher, ~30 Min Ausfall bei Umschaltung)             │
│                                                                    │
│   PRIMARY (192.168.178.100) → DB-Backup auf USB-Stick             │
│                                                                    │
│   BACKUP (irgendwo)         Hardware bereit, fertig installiert    │
│                             aber ausgeschaltet                     │
│                                                                    │
│   Bei Ausfall: PRIMARY abklemmen, BACKUP einstecken, einschalten,  │
│                Backup-USB einlesen, fertig                         │
└────────────────────────────────────────────────────────────────────┘
```

Für die meisten Kartbahnen reicht **Strategie B**. Wir beschreiben hier beide.

---

## 2. Strategie B: Cold-Standby (empfohlen)

### 2.1 Vorbereitung — Identische Installation

Auf dem Backup-PC alle Schritte aus `02_INSTALL.md` durchführen — **identisch** zur
Primary. Wichtig dabei:

- Gleiche IP-Konfiguration **vorbereiten**, aber **noch nicht aktivieren** (sonst
  IP-Konflikt im LAN)
- Backup-PC bekommt vorerst eine andere IP, z.B. `192.168.178.101`
- Repository klonen, venv anlegen, alle Dependencies installieren
- systemd-Service einrichten (aber **deaktiviert** lassen)
- CUPS einrichten, Drucker hinzufügen
- Tailscale: NOCH NICHT verbinden (sonst zwei Geräte mit gleichem Hostname)

### 2.2 Tailscale auf dem Backup-PC vorbereiten

Tailscale auf dem Backup-PC installieren, aber mit **anderem Hostname**:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=emslandring-backup
```

Im Admin-Console der Tailscale-Konfig den neuen Knoten autorisieren.

Der Hostname `emslandring-backup` bewirkt eine zweite Funnel-URL:
`https://emslandring-backup.tail2c13dd.ts.net` — die nutzen wir **noch nicht**,
damit QR-Codes auf den Primary zeigen.

### 2.3 Regelmäßiges DB-Backup vom Primary holen

Auf dem **Backup-PC** ein Skript anlegen, das per `rsync` täglich die neueste DB
holt:

```bash
nano ~/sync_from_primary.sh
```

Inhalt:

```bash
#!/bin/bash
# Holt täglich die DB vom Primary-Server.
PRIMARY=server@192.168.178.100
SRC=/home/server/emslandring-repo/emslandringTiming/emslandring.db
DST=/home/server/emslandring-repo/emslandringTiming/emslandring.db

# SQLite sicher synchronisieren: erst ein Online-Backup auf dem Primary,
# dann per rsync rüberziehen. So vermeiden wir Lock-Konflikte.
TMP_REMOTE=/tmp/emslandring-sync.db

ssh $PRIMARY "sqlite3 $SRC '.backup $TMP_REMOTE'" || exit 1
rsync -avz --partial $PRIMARY:$TMP_REMOTE $DST.tmp || exit 1
mv $DST.tmp $DST
ssh $PRIMARY "rm -f $TMP_REMOTE"

# Auch die Konfiguration sichern
rsync -avz $PRIMARY:/home/server/emslandring-repo/emslandringTiming/config.json \
              /home/server/emslandring-repo/emslandringTiming/config.json

echo "Sync OK: $(date)"
```

Ausführbar machen + per cron:

```bash
chmod +x ~/sync_from_primary.sh
crontab -e
```

```cron
# täglich um 04:00 Uhr DB vom Primary holen
0 4 * * * /home/server/sync_from_primary.sh >> /home/server/sync.log 2>&1
```

**Voraussetzung:** SSH-Schlüsselpaar einrichten, damit `ssh` ohne Passwort
funktioniert:

```bash
ssh-keygen -t ed25519                            # auf dem Backup-PC
ssh-copy-id server@192.168.178.100               # zum Primary
ssh server@192.168.178.100                       # Test, muss ohne Passwort gehen
```

### 2.4 Backup-PC ausschalten oder weglegen

Nach erfolgreichem ersten Sync und Testlauf den Backup-PC:

- entweder **ausgeschaltet** in eine Ecke stellen (Cold Standby)
- oder **eingeschaltet** lassen, der cron-Sync hält die DB aktuell

Empfehlung: An lassen — kostet 10 W Strom und ist im Notfall sofort einsatzbereit.

---

## 3. Umschaltung bei Ausfall des Primary

Im Notfall — der Primary streikt mitten am Tag:

### 3.1 Schnellcheck

```bash
# vom Bürorechner:
ssh server@192.168.178.100 'sudo systemctl status emslandring-timing'
```

Falls Server gar nicht antwortet:

### 3.2 Hardware-Umschaltung

1. **Primary vom LAN trennen** (Stecker ziehen!)
2. **Backup-PC** an die exakt gleiche Stelle anschließen (LAN + Strom)
3. Auf Backup-PC einloggen (vorerst noch via `192.168.178.101`)

### 3.3 IP-Wechsel auf dem Backup

Backup-PC die Primary-IP übernehmen lassen:

```bash
# IP-Wechsel über nmcli:
sudo nmcli con mod "Kabelgebundene Verbindung 1" \
    ipv4.addresses 192.168.178.100/24 \
    ipv4.gateway 192.168.178.1 \
    ipv4.dns "192.168.178.1 1.1.1.1" \
    ipv4.method manual
sudo nmcli con down  "Kabelgebundene Verbindung 1"
sudo nmcli con up    "Kabelgebundene Verbindung 1"

# Test
ip addr show | grep 192.168.178.100
```

### 3.4 Letzten DB-Sync ziehen (falls Primary noch teilweise lebt)

Falls der Primary noch SSH-erreichbar ist:

```bash
~/sync_from_primary.sh
```

Sonst: letzten Stand vom cron-Sync (max. 24h alt) verwenden.

### 3.5 Service hochfahren

```bash
sudo systemctl enable emslandring-timing
sudo systemctl start emslandring-timing
sudo systemctl status emslandring-timing --no-pager | head -5
```

### 3.6 Tailscale-Hostname wechseln

Damit QR-Codes weiterhin funktionieren, muss der Backup-PC die **Primary-URL**
bekommen:

```bash
sudo tailscale logout
sudo tailscale up --hostname=emslandring
```

Login-URL im Browser bestätigen. Im Tailscale Admin-Console:

1. Den alten `emslandring`-Knoten (Primary) löschen
2. Den neuen Knoten als `emslandring` anerkennen

Funnel wieder aktivieren:

```bash
sudo tailscale funnel --bg 8081
```

Die URL `https://emslandring.tail2c13dd.ts.net` zeigt jetzt auf den Backup-PC —
schon gedruckte QR-Codes funktionieren weiterhin.

### 3.7 Test

```bash
# vom Bürorechner:
curl -s -o /dev/null -w "Backup OK: %{http_code}\n" http://192.168.178.100:8081
curl -s -o /dev/null -w "Tunnel OK: %{http_code}\n" https://emslandring.tail2c13dd.ts.net
```

Beide sollten `200` zurückgeben. Browser im LAN: `http://192.168.178.100:8081`
öffnen → Timing-UI muss kommen.

### 3.8 Pi-Dashboard

Der Raspberry Pi zeigt automatisch wieder auf `192.168.178.100:8081/dashboard` —
einfach Browser refreshen (oder Pi neu starten falls Bildschirm eingefroren).

---

## 4. Migration auf komplett neuen Server

Szenario: Der alte Mini-PC ist 5 Jahre alt, soll durch einen neueren ersetzt werden.

### 4.1 Vorbereitung

1. Neuen PC besorgen, Specs siehe `01_HARDWARE.md`
2. Termin für Umstellung wählen (z.B. Montagvormittag — Kartbahn meist zu)

### 4.2 Schritte

1. **Neuer PC:** Komplette Installation nach `02_INSTALL.md` durchziehen, mit
   anderer IP `192.168.178.101`.
2. **Letzten DB-Stand vom alten Server holen:**
   ```bash
   ssh server@192.168.178.100 'sqlite3 ~/emslandring-repo/emslandringTiming/emslandring.db ".backup /tmp/migration.db"'
   scp server@192.168.178.100:/tmp/migration.db ~/emslandring-repo/emslandringTiming/emslandring.db
   ```
3. **Config kopieren:**
   ```bash
   scp server@192.168.178.100:/home/server/emslandring-repo/emslandringTiming/config.json \
       ~/emslandring-repo/emslandringTiming/config.json
   ```
4. **Logo kopieren:**
   ```bash
   scp server@192.168.178.100:/home/server/emslandring-repo/emslandringTiming/server/data/logo.png \
       ~/emslandring-repo/emslandringTiming/server/data/logo.png
   ```
5. **Test mit alter IP des Backup-PCs:** Auf neuem PC den Service starten, im
   Browser via `http://192.168.178.101:8081` prüfen ob die Daten richtig
   übernommen sind.
6. **Umschaltung (geplanter 10-Min-Ausfall):**
   - Alten PC: `sudo systemctl stop emslandring-timing`
   - Alten PC: LAN-Kabel ziehen
   - Neuer PC: IP-Wechsel auf `192.168.178.100` (siehe 3.3)
   - Tailscale-Hostname-Wechsel (siehe 3.6)
   - Service neu starten
7. **Pi neu booten** damit es die neue Verbindung sauber aufbaut.

### 4.3 Alten PC „aus dem Verkehr ziehen"

```bash
# Auf altem PC, falls noch erreichbar:
sudo systemctl disable emslandring-timing
sudo systemctl stop emslandring-timing
sudo tailscale logout
```

Den alten PC kannst du als **neuen Backup-PC** umfunktionieren (siehe 2.1 ff).
Die Hardware ist ja noch da — perfekt als Cold-Standby.

---

## 5. Disaster Recovery

Worst Case: Komplett alles weg (Wassereinbruch, Diebstahl, Feuer).

### 5.1 Was du brauchst

- **Letztes USB-Backup** der DB (siehe `04_OPERATIONS.md` Abschnitt 5.3)
- **Netzwerk-Konfiguration** dokumentiert (IPs aller Geräte)
- **Tailscale-Account-Zugang** (E-Mail + Passwort)

### 5.2 Wiederherstellung von Null

1. Neuen Mini-PC besorgen
2. Komplette Installation nach `02_INSTALL.md`
3. DB aus USB-Backup einspielen:
   ```bash
   cp /media/USB/emslandring-20260517.db \
      ~/emslandring-repo/emslandringTiming/emslandring.db
   ```
4. `config.json` aus USB-Backup einspielen (oder neu von Hand erstellen)
5. Logo aus USB-Backup oder Web-UI hochladen
6. Tailscale-Hostname `emslandring` belegen — alter Knoten muss ggf. im Admin-Console gelöscht werden
7. Service starten, alles testen

Erwartete Downtime: 3–4 Stunden (mit dieser Doku, ohne Doku 1–2 Tage).

---

## 6. Spezialfall: Decoder-Tausch

Wenn der MyLaps-Decoder defekt ist:

1. Ersatz-Decoder besorgen (MyLaps RC4)
2. Im neuen Decoder die statische IP `192.168.178.193` setzen
3. Lichtschleife anschließen
4. emslandringTiming-Service neu starten — Decoder wird automatisch erkannt

Die Decoder-IP steht in der Software-Konfiguration und kann auch in der Web-UI
nachträglich geändert werden, falls ein anderer IP-Range nötig ist.

---

## 7. Checkliste: „Backup-PC einsatzbereit"

- [ ] Backup-PC hat identische Software-Installation
- [ ] Backup-PC kann per SSH auf den Primary zugreifen (Schlüsselauth)
- [ ] `sync_from_primary.sh` läuft täglich erfolgreich (siehe `~/sync.log`)
- [ ] DB-Stand auf dem Backup ist max. 24h alt
- [ ] Tailscale-Knoten `emslandring-backup` ist im Admin-Console eingetragen
- [ ] CUPS-Drucker auf Backup-PC eingerichtet
- [ ] Logo auf Backup-PC vorhanden
- [ ] Notfall-Anleitung (dieses Dokument) ausgedruckt + in der Kabine deponiert

---

## 8. Übung: Notfall simulieren

Einmal pro Quartal empfohlen:

1. Hauptserver vom LAN trennen (Stecker ziehen, NICHT herunterfahren — simuliert Hardware-Ausfall)
2. Backup-PC aktivieren laut Anleitung Abschnitt 3
3. Lauf am Backup-System testen (Test-Lauf scharf schalten, Test-Druck)
4. Danach Primary wieder anschließen, Backup-PC zurück auf `192.168.178.101`

Solche Übungen decken Lücken in der Doku auf und halten dich im Training für den
echten Fall.

---

*Nächstes Kapitel:* `08_PI_DASHBOARD.md` — Raspberry Pi für das Zuschauer-Dashboard
einrichten.
