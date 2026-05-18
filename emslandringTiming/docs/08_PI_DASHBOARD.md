# Raspberry Pi: Zuschauer-Dashboard einrichten

Der Raspberry Pi treibt einen großen Monitor am Wartebereich / an der Tribüne und
zeigt dort live das Ranking des aktiven Laufs.

**Was läuft auf dem Pi:**

- Raspberry Pi OS (Bookworm) Desktop
- Chromium im Kiosk-Modus (fullscreen, ohne Adressleiste)
- Lädt `http://192.168.178.100:8081/dashboard` automatisch beim Boot

**Was passiert nicht:**

- Keine eigene Software, kein Webserver, keine Datenbank
- Der Pi ist „dumm" — alles kommt vom Mini-PC

---

## 1. Hardware-Anschluss

```
                 HDMI
Raspberry Pi ─────────────▶ Monitor / TV
   │
   │ LAN-Kabel
   ▼
Switch / Router
   │
   │ DHCP-Reservierung
   ▼
192.168.178.200 (statische IP)
```

| Komponente | Empfehlung |
|---|---|
| Pi-Modell | Pi 4B 4 GB oder Pi 5 |
| Stromversorgung | offizielles USB-C-Netzteil (3 A, 5 V) |
| SD-Karte | 32 GB Class 10 / A1 |
| Monitor | beliebiger TV oder Monitor mit HDMI, ≥ 1080p |

---

## 2. Pi OS installieren

### 2.1 SD-Karte vorbereiten

Auf einem normalen PC:

1. **Raspberry Pi Imager** herunterladen: https://www.raspberrypi.com/software/
2. Imager starten:
   - OS wählen → **Raspberry Pi OS (64-bit, with Desktop)**
   - SD-Karte einlegen → Speichermedium wählen
   - Zahnrad-Symbol (Einstellungen):
     - Hostname: `pi-dashboard`
     - SSH aktivieren (mit Passwort)
     - Username: `pi`, Passwort: _<setzen>_
     - WLAN konfigurieren (falls ohne LAN)
     - Locale: Deutschland / Berlin
3. **Schreiben** klicken (10–15 Min)

### 2.2 Erster Boot

1. SD-Karte in Pi einlegen
2. HDMI + LAN-Kabel + Strom anschließen
3. Pi startet, Desktop erscheint nach ~1 Min
4. Bei Bedarf: Country/Sprache bestätigen, Updates aussetzen lassen

---

## 3. Statische IP setzen

Am einfachsten via Pi-Menü:

1. Rechtsklick auf das Netzwerk-Symbol oben rechts → Wireless & Wired Network Settings
2. Reiter „eth0" → IPv4 Method: **Manual**
3. Address: `192.168.178.200/24`
4. Router: `192.168.178.1`
5. DNS Servers: `192.168.178.1, 1.1.1.1`
6. **Save**, dann Pi neu starten

Alternativ per Terminal:

```bash
sudo nmcli con mod "Wired connection 1" \
    ipv4.addresses 192.168.178.200/24 \
    ipv4.gateway 192.168.178.1 \
    ipv4.dns "192.168.178.1 1.1.1.1" \
    ipv4.method manual
sudo systemctl restart NetworkManager
```

**Test:**

```bash
ping -c3 192.168.178.100   # Hauptserver erreichbar?
curl -s -o /dev/null -w "Server: %{http_code}\n" http://192.168.178.100:8081/dashboard
# Erwartet: 200
```

---

## 4. Browser-Kiosk einrichten

### 4.1 Notwendige Pakete

```bash
sudo apt update
sudo apt install -y chromium-browser unclutter
```

- **chromium-browser** ist meist schon vorinstalliert
- **unclutter** versteckt den Mauszeiger automatisch nach 1 s Inaktivität

### 4.2 Auto-Login

Damit der Pi nach Reboot automatisch in den Pi-Desktop kommt:

```bash
sudo raspi-config
```

→ `1 System Options` → `S5 Boot / Auto Login` → `B4 Desktop Autologin`. Bestätigen,
Reboot wird vorgeschlagen.

### 4.3 Bildschirmschoner deaktivieren

```bash
sudo apt install -y xscreensaver
```

Programme → Einstellungen → Bildschirmschoner → Mode: **Disable Screen Saver**.

Zusätzlich verhindern dass der Bildschirm in Standby geht:

```bash
sudo nano /etc/xdg/lxsession/LXDE-pi/autostart
```

Folgende Zeilen am Ende einfügen:

```bash
@xset s off
@xset -dpms
@xset s noblank
```

### 4.4 Chromium im Kiosk-Modus starten

Datei anlegen:

```bash
mkdir -p ~/.config/autostart
nano ~/.config/autostart/kiosk.desktop
```

Inhalt:

```ini
[Desktop Entry]
Type=Application
Name=Emslandring Dashboard Kiosk
Exec=/home/pi/start-kiosk.sh
X-GNOME-Autostart-enabled=true
```

Skript anlegen:

```bash
nano ~/start-kiosk.sh
```

Inhalt:

```bash
#!/bin/bash
# Wartet bis Netz da ist, dann Chromium fullscreen aufmachen.
sleep 10

# Mauszeiger nach 1s Inaktivität verstecken
unclutter -idle 1 -root &

# Chromium ohne Adressleiste, ohne Crash-Restore-Popup
chromium-browser \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --start-fullscreen \
    --kiosk \
    --check-for-update-interval=31536000 \
    http://192.168.178.100:8081/dashboard
```

Ausführbar machen:

```bash
chmod +x ~/start-kiosk.sh
```

### 4.5 Test

```bash
sudo reboot
```

Nach Neustart sollte der Pi automatisch in den Vollbild-Browser gehen und die
Dashboard-Seite zeigen.

---

## 5. Konfiguration der Server-URL

Falls die Server-IP oder der Port sich ändert (z.B. nach Server-Tausch):

```bash
nano ~/start-kiosk.sh
```

Die letzte Zeile `chromium-browser ... http://...` anpassen. Speichern. Reboot.

---

## 6. Bedien-Hinweise für die Kabine

### 6.1 Pi neu starten

Falls der Browser eingefroren scheint:

- **Komfort-Variante:** Bildschirm aus + an (HDMI-Reconnect) — der Pi merkt das oft
  und repaintet die Seite.
- **Mittlere Variante:** SSH vom Bürorechner: `ssh pi@192.168.178.200`, dann `sudo reboot`.
- **Holzhammer:** Stromstecker des Pi kurz ziehen.

### 6.2 Bildschirmgröße / Skalierung

Falls die Schrift zu klein/groß ist:

1. Auf dem Pi: rechte Maustaste auf Desktop → Display Settings
2. Resolution einstellen (Native = beste Bildqualität)
3. Im Browser: per Tastatur `Strg + +` (Pi-Tastatur am Service-Anschluss).

### 6.3 Bildschirm-Standby

Manche TVs/Monitore schalten sich nach 30 min Inaktivität ab — der Pi sendet
ständig Bilder, das verhindert eigentlich Standby. Falls trotzdem: im TV-Menü
Auto-Standby deaktivieren.

---

## 7. Optional: Bridge-Variante (alte Pi-Kiosk-Konfig)

Im Repo unter `pi-kiosk/` gibt es eine Alternative mit `kiosk.env`-Konfigdatei und
CEC-Steuerung (TV automatisch an/aus über HDMI-CEC). Vorteile:

- TV schaltet sich automatisch ein wenn der Server startet
- Wartung etwas komfortabler (Konfig in `.env`-Datei statt im Skript)

Aufbauend auf einem alten Setup mit `192.168.178.152:8080` — nicht mehr aktuell.
**Wenn du diese Variante nutzen willst, vorher in `pi-kiosk/kiosk.env`:**

```bash
SERVER_HOST=192.168.178.100
HTTP_PORT=8081
```

Genauere Anleitung in `pi-kiosk/INSTALL_PI_KIOSK.md`.

---

## 8. Mehrere Pis / Mehrere Bildschirme

Falls mehrere Bildschirme an verschiedenen Stellen der Halle hängen sollen, einfach
mehrere Pis aufsetzen mit:

- jeweils eigene statische IP (`192.168.178.201`, `.202`, ...)
- jeweils eigener Hostname (`pi-dashboard-1`, `pi-dashboard-2`, ...)
- alle zeigen auf dieselbe Server-URL

Die WebSocket-Verbindung verkraftet beliebig viele parallele Clients.

---

## 9. Troubleshooting

### 9.1 Pi zeigt nur weißen Bildschirm

```bash
# auf dem Pi (per SSH):
chromium-browser http://192.168.178.100:8081/dashboard
```

Wenn Chromium nicht startet: `sudo apt install --reinstall chromium-browser`.

Wenn Chromium startet aber leer bleibt: Browser-Console öffnen (F12) → Fehler lesen.
Typisch: Server unerreichbar (Netzwerk-Problem), oder JavaScript-Fehler.

### 9.2 Pi bootet nicht

- SD-Karte defekt: Imager neu schreiben
- HDMI-Kabel locker: anderes ausprobieren
- Netzteil zu schwach: nur offizielles Raspberry-Pi-Netzteil verwenden

### 9.3 Live-Daten kommen nicht

```bash
curl -s http://192.168.178.100:8081/api/runs?date=$(date +%Y-%m-%d)
```

Sollte JSON mit Läufen zurückgeben. Falls nicht:
- Server läuft nicht (siehe `04_OPERATIONS.md`)
- Netz zwischen Pi und Server tot (`ping 192.168.178.100`)

### 9.4 Pi friert nach Stunden ein

SD-Karten haben begrenzte Lebenszeit (~2 Jahre intensiver Nutzung). Bei häufigen
Aussetzern: SD-Karte tauschen.

Alternativ: USB-Stick statt SD-Karte verwenden (Pi 4+ kann von USB booten). Wesentlich
zuverlässiger.

---

## 10. Wartung

| Intervall | Aufgabe |
|---|---|
| Wöchentlich | Pi neu starten (über SSH oder Stromstecker) |
| Halbjährlich | `sudo apt update && sudo apt upgrade -y` |
| Jährlich | SD-Karte überprüfen / tauschen |

---

*Damit ist die Doku-Sammlung komplett. Bei Fragen / Erweiterungswünschen den
Entwickler kontaktieren.*
