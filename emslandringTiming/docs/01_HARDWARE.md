# Hardware-Referenz

Diese Datei beschreibt die komplette Hardware-Ausstattung, die für den Betrieb von
**emslandringTiming** benötigt wird. Wer eine neue Kartbahn ausstattet oder einen
Backup-Server aufbaut, kann anhand dieser Liste exakt nachkaufen.

---

## 1. Übersicht

```
                                            ┌─────────────────────┐
                                            │   Internet (DSL)    │
                                            └──────────┬──────────┘
                                                       │
                                            ┌──────────┴──────────┐
                                            │      Router         │
                                            │  192.168.178.1      │
                                            └──────────┬──────────┘
                                                       │
                          ┌──────────────────┬─────────┴─────┬──────────────────┐
                          │                  │               │                  │
                ┌─────────┴───────┐  ┌──────┴──────┐  ┌─────┴─────┐  ┌────────┴────────┐
                │  Ubuntu Mini PC │  │ MyLaps RC4  │  │  Ampel    │  │ Raspberry Pi    │
                │  emslandring-   │  │  Decoder    │  │  Devantech│  │ (Zuschauer-     │
                │  Timing         │  │             │  │  ETH008   │  │  Dashboard)     │
                │ 192.168.178.100 │  │ .193:5403   │  │ .128:80   │  │ 192.168.178.200 │
                │      :8081      │  └─────────────┘  └───────────┘  └─────────────────┘
                └────────┬────────┘
                         │
                         │ USB / Netzwerk
                         │
                ┌────────┴────────┐         ┌─────────────────────┐
                │     Drucker     │         │ Kloft-Anzeige       │
                │  Kyocera P2235  │         │ via Windows PC      │
                │     (oder CUPS) │         │ + RS485-Bridge      │
                └─────────────────┘         └─────────────────────┘
```

---

## 2. Komponenten-Liste

### 2.1 Hauptserver (Ubuntu Mini PC)

Auf diesem Rechner läuft die komplette `emslandringTiming`-Software 24/7.

| Eigenschaft | Anforderung | Begründung |
|---|---|---|
| **CPU** | x86_64, ≥ 4 Kerne, ≥ 2.0 GHz | PDF-Rendering parallelisiert über `ProcessPoolExecutor` |
| **RAM** | ≥ 4 GB (8 GB empfohlen) | WeasyPrint + Firebase + asyncio benötigen ~500 MB Resident |
| **Festplatte** | ≥ 64 GB SSD | SQLite-DB wächst pro Jahr um ~1 GB |
| **Netzwerk** | Gigabit Ethernet (RJ-45) | WLAN funktioniert, ist aber für 24/7 Betrieb nicht ideal |
| **OS** | Ubuntu 24.04 LTS Desktop oder Server | Python 3.12 ist mitgeliefert |
| **USB** | ≥ 2 freie Ports | Für Drucker, Tastatur, Backup-Stick |

**Konkrete Empfehlung:**

- Intel NUC (NUC 11/12, ~400 €) — bewährt, klein, leise
- Beelink S12 / S13 Mini-PC (~250 €) — günstige Alternative
- Lenovo ThinkCentre M75q / M90q gebraucht (~200 €) — sehr zuverlässig

**Aktuelle Installation:**

- Modell: _<vom Besitzer einzutragen>_
- IP-Adresse: `192.168.178.100`
- Benutzername: `server`
- SSH-Zugang: Port 22 (Standard)

---

### 2.2 MyLaps RC4 Decoder

Liest die Transponder-Signale aus den Karts beim Überqueren der Lichtschranke.

| Eigenschaft | Wert |
|---|---|
| **Modell** | MyLaps RC4 Race Control Decoder |
| **Protokoll** | AMB P3 (Binärprotokoll, TCP) |
| **IP-Adresse** | `192.168.178.193` |
| **TCP-Port** | `5403` |
| **Stromversorgung** | 12 V DC, ca. 1 A |

**Wichtig:**

- Der Decoder muss eine **statische IP** haben (in seiner eigenen Web-UI konfigurieren).
- Die Lichtschrankenschleife muss ordnungsgemäß in der Bahn eingelassen sein.
- Heartbeat-Signal (alle ~5 s) wird vom Server geloggt — siehe `decoder_health` in der DB.

**Web-UI des Decoders:** http://192.168.178.193 (vom MyLaps-Service eingerichtet).

---

### 2.3 Ampel-Steuerung (Devantech ETH008)

Steuert die rote/grüne Ampel an der Strecke über zwei Relais.

| Eigenschaft | Wert |
|---|---|
| **Modell** | Devantech ETH008 (8-Kanal Ethernet Relay Board) |
| **IP-Adresse** | `192.168.178.128` |
| **HTTP-Port** | `80` |
| **Login** | Standard: `admin` / `password` (in der Settings-UI anpassbar) |
| **Relais Rot** | Kanal 4 (Default — in Settings anpassbar) |
| **Relais Grün** | Kanal 6 (Default — in Settings anpassbar) |

**Hardware-Anschluss:**

```
ETH008 Relais 4 ── NC/COM ── Ampel ROT ──── 230V-Netz
ETH008 Relais 6 ── NC/COM ── Ampel GRÜN ─── 230V-Netz
```

Die Ampel selbst ist eine handelsübliche LED-Verkehrsampel mit getrennten Rot- und Grün-Stromkreisen.

**Steuerung erfolgt über HTTP-API** des ETH008 (siehe `server/ampel.py`):
- `GET /io.cgi?DOA=4` schaltet Relais 4 ein
- `GET /io.cgi?DOI=4` schaltet Relais 4 aus

---

### 2.4 Drucker

Druckt die Ergebniszettel nach jedem Lauf.

| Eigenschaft | Empfehlung |
|---|---|
| **Typ** | Laser-S/W oder Tinten-Farb |
| **Anschluss** | USB **oder** Netzwerk (IPP/JetDirect Port 9100) |
| **Format** | A4, einseitig |
| **Geschwindigkeit** | ≥ 20 Seiten/Min |

**Empfohlene Modelle:**

- **Kyocera ECOSYS P2235dn** — robust, günstig, USB+LAN
- **Brother HL-L2370DN** — preiswert, USB+LAN, Duplex
- **HP LaserJet Pro M404dn** — schnell, gut wartbar

**Aktuelle Installation:**

- Modell: _<vom Besitzer einzutragen>_
- Verbindung: USB / Netzwerk-IP _<eintragen>_
- CUPS-Druckername: _<eintragen>_

**Treiber-Hinweis:** Die meisten Kyocera/Brother/HP-Drucker funktionieren mit dem
generischen `Generic PCL` oder `Generic PostScript` Treiber, der bei Ubuntu mitgeliefert wird.

---

### 2.5 Raspberry Pi (Zuschauer-Dashboard)

Zeigt den Live-Stand des aktiven Laufs auf einem Bildschirm am Wartebereich / Tribüne.

| Eigenschaft | Wert |
|---|---|
| **Modell** | Raspberry Pi 4B (4 GB) oder Pi 5 |
| **OS** | Raspberry Pi OS (Bookworm) Desktop |
| **IP-Adresse** | `192.168.178.200` (statisch) |
| **Display** | HDMI an TV/Monitor, 1080p+ |
| **Modus** | Kiosk (Chromium fullscreen) |

Details siehe `docs/08_PI_DASHBOARD.md`.

---

### 2.6 Netzwerk

| Komponente | Empfehlung |
|---|---|
| **Router** | beliebig — muss DHCP-Reservierungen können |
| **Switch** | Gigabit, ≥ 8 Ports (falls Router nicht reicht) |
| **Kabel** | CAT5e oder CAT6, abgeschirmt für Industrie-Umgebung |
| **WLAN** | Optional — nur falls Decoder/Ampel WLAN nutzen (i.d.R. nicht) |

**IP-Plan (Empfehlung):**

```
192.168.178.1     Router
192.168.178.100   Ubuntu Mini PC (emslandringTiming)
192.168.178.128   Devantech ETH008 (Ampel)
192.168.178.193   MyLaps RC4 Decoder
192.168.178.200   Raspberry Pi (Dashboard)
192.168.178.50–99 reserviert für Smartphones/Laptops der Mitarbeiter (DHCP)
```

Im Router DHCP-Reservierungen anlegen für die Geräte mit fester IP (Mini PC, ETH008,
Decoder, Pi) — verhindert IP-Konflikte nach Stromausfall.

---

### 2.7 Optional: Internet-Tunnel (Tailscale)

Für das QR-Code-Feature (Kunden tragen ihren Namen in die Bestenliste ein) ist eine
**öffentlich erreichbare URL** notwendig. Es wird **kein eigener Server / keine eigene
Domain** benötigt — Tailscale stellt das kostenlos zur Verfügung.

| Eigenschaft | Wert |
|---|---|
| **Anbieter** | Tailscale (https://tailscale.com) — Free-Plan reicht |
| **Verfahren** | Tailscale Funnel (eingebauter Reverse-Tunnel) |
| **Aktuelle URL** | `https://emslandring.tail2c13dd.ts.net` |
| **Hostname auf Ubuntu** | `emslandring` |

Setup-Anleitung siehe `docs/02_INSTALL.md` Abschnitt „Tailscale Funnel".

---

### 2.8 Optional: Kloft-Anzeigetafel-Bridge

Falls die alte Kloft-Großanzeige mit Sieben-Segment-Anzeige weiter genutzt wird, läuft
auf einem **Windows-PC** eine Bridge-Software, die per RS485 mit der Anzeige
kommuniziert.

| Eigenschaft | Wert |
|---|---|
| **Hardware** | Beliebiger Windows-PC mit USB-RS485-Adapter |
| **Anschluss zum Server** | TCP, verbindet sich auf `192.168.178.100:50000` |
| **Protokoll** | MyLaps ASCII (Komma + Quotes) |

Die Server-seitige Emulation wird vom `emulator.py`-Modul übernommen — die Bridge auf
dem Windows-PC bleibt unverändert.

---

## 3. Stückliste (Beispiel-Konfiguration)

| Pos | Komponente | Modell | Stück | Preis ca. |
|---|---|---|---|---|
| 1 | Mini-PC | Beelink S12 Pro N100 16/500 | 1 | 300 € |
| 2 | Decoder | MyLaps RC4 (i.d.R. vorhanden) | 1 | (vorhanden) |
| 3 | Ampel-Steuerung | Devantech ETH008 | 1 | 90 € |
| 4 | Ampel | LED-Verkehrsampel 200 mm Linsen | 1 | 250 € |
| 5 | Drucker | Kyocera ECOSYS P2235dn | 1 | 220 € |
| 6 | Raspberry Pi | Pi 4B 4GB Set inkl. NT + SD | 1 | 90 € |
| 7 | Monitor 32" | Wandhalterung TV mit HDMI | 1 | 200 € |
| 8 | Netzwerk | Switch 8-Port Gigabit + Kabel | 1 | 50 € |
| | | **Gesamt** | | **ca. 1200 €** |

(Preise Stand 2026, ohne Bestand wie Decoder, Ampel-Verkabelung, Strom-Anschlüsse.)

---

## 4. Verbindungsschema

### 4.1 Datenflüsse

```
┌─────────────┐  AMB P3 binär       ┌───────────────┐
│ MyLaps RC4  │ ───TCP 5403────────▶│ emslandring-  │
│  Decoder    │                     │ Timing        │
└─────────────┘                     │ (Mini PC)     │
                                    │               │
                  HTTP/WS◀──────────┤  Port 8081    │
┌─────────────┐                     │               │
│ Kabinen-PC  │ ◀──────────────────▶│  Port 50000   │── Kloft
│ (Browser)   │   /ws ?client=app   │               │   ASCII
└─────────────┘                     │  CUPS lp ─────┼─▶ Drucker
                                    │               │
┌─────────────┐                     │  HTTP-Calls──┼─▶ ETH008
│ Pi-Dashboard│ ◀───/dashboard──────┤               │   (Ampel)
│ (Browser)   │   /ws?client=...    │               │
└─────────────┘                     │  Tailscale────┼─▶ Internet
                                    │  Funnel       │   (QR-Scans)
                                    └───────────────┘
```

### 4.2 Ports (TCP) am Mini PC

| Port | Dienst | Quelle | Notiz |
|---|---|---|---|
| 22 | SSH | LAN | Wartung |
| 8081 | emslandringTiming HTTP | LAN | Operator-UI + Dashboard |
| 8081 | emslandringTiming WS | LAN | dieselbe Verbindung wie HTTP, `Upgrade: websocket` |
| 50000 | MyLaps Emulator | LAN | Für Kloft-Bridge |
| 631 | CUPS | localhost | Drucker-Admin |
| 443 | Tailscale Funnel | Internet | extern via Tunnel |

### 4.3 Ports (TCP) der Peripherie

| Gerät | Port | Verwendung |
|---|---|---|
| MyLaps Decoder | 5403 | Server initiiert Verbindung |
| Devantech ETH008 | 80 | Server schickt HTTP-Requests |

---

## 5. Stromversorgung & USV

**Empfehlung:**

- Mini PC, Switch, Decoder, ETH008, Router gemeinsam an einer **USV mit ≥ 600 VA**
  (z.B. APC Back-UPS BX700U-GR). Hält bei Stromausfall ~15 min — genug um den
  laufenden Lauf zu beenden und sauber herunterzufahren.
- Drucker NICHT an die USV (zieht beim Druck kurzzeitig 600 W → würde USV überlasten).

**Auto-Shutdown bei USV-Alarm:**

```bash
sudo apt install apcupsd
sudo nano /etc/apcupsd/apcupsd.conf
# UPSCABLE usb
# UPSTYPE usb
# DEVICE
sudo systemctl enable --now apcupsd
```

---

## 6. Wartungs-Hinweise

| Komponente | Wartungsintervall | Tätigkeit |
|---|---|---|
| Mini PC | jährlich | Lüfter entstauben, SSD-SMART prüfen |
| MyLaps Decoder | nach Bedarf | Lichtschranken-Spule auf Schäden prüfen |
| ETH008 | keine | wartungsfrei |
| Drucker | monatlich | Toner/Tinte prüfen, Walzen reinigen |
| Raspberry Pi | jährlich | SD-Karte tauschen (Wear-Out nach ~2 Jahren) |

---

*Nächstes Kapitel:* `02_INSTALL.md` — Komplette Installation von Grund auf.
