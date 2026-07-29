# Drucker-Setup: einmalige Berechtigungen

Damit der Operator die Drucker **komplett aus der Web-UI** verwalten kann
(Reaktivieren, Jobs löschen, Drucker entfernen, cups-browsed neu starten),
braucht der `server`-User zwei Berechtigungen. Beide werden **einmalig**
eingerichtet und sind danach dauerhaft aktiv.

Ohne dieses Setup funktionieren die Buttons in Settings → Drucker nicht
(die API antwortet mit HTTP 500 „lpadmin-Gruppe fehlt" bzw. „sudoers-Regel
fehlt").

---

## Schritt 1: `server`-User in `lpadmin`-Gruppe

CUPS erlaubt Drucker-Verwaltung (`cupsenable`, `cupsaccept`, `cancel -a`,
`lpadmin -x`, `lpadmin -d`) nur Mitgliedern der `lpadmin`-Gruppe.

```bash
sudo usermod -a -G lpadmin server
```

**Wichtig:** Die Gruppen-Mitgliedschaft wird erst nach neuem Login wirksam.
Für den systemd-Service reicht ein Restart:

```bash
sudo systemctl restart emslandring-timing
```

Prüfen:
```bash
groups server
# Erwartet: server ... lpadmin ...
```

---

## Schritt 2: sudoers-Regel für `cups-browsed`-Restart

Der Button „🔄 Neu starten" in Settings → cups-browsed führt intern
`systemctl restart cups-browsed` aus. Das braucht sudo, aber ohne
Passwort-Abfrage (die Web-UI kann kein Passwort eingeben).

Eine minimale sudoers-Regel erlaubt genau **diese eine Aktion** ohne
Passwort — keine Erweiterung auf andere Kommandos möglich, sicher.

```bash
sudo tee /etc/sudoers.d/emslandring-cups > /dev/null <<'EOF'
# emslandringTiming: Drucker-Manager erlaubt cups-browsed
# Neustart/Stopp aus der Web-UI ohne Passwort-Prompt.
# Nur diese exakten Kommandos, kein Wildcard.
server ALL=(root) NOPASSWD: /usr/bin/systemctl restart cups-browsed
server ALL=(root) NOPASSWD: /usr/bin/systemctl stop cups-browsed
server ALL=(root) NOPASSWD: /usr/bin/systemctl disable cups-browsed
server ALL=(root) NOPASSWD: /usr/bin/systemctl start cups-browsed
server ALL=(root) NOPASSWD: /usr/bin/systemctl enable cups-browsed
EOF
sudo chmod 440 /etc/sudoers.d/emslandring-cups
```

Prüfen (muss ohne Fehler durchgehen):
```bash
sudo -n systemctl status cups-browsed --no-pager | head -3
```

Falls es fragt „Passwort für server:" → sudoers-Regel greift nicht,
oder der Pfad zu systemctl ist ein anderer. Prüfen mit `which systemctl` und
ggf. den Pfad in `/etc/sudoers.d/emslandring-cups` anpassen.

---

## Schritt 3: Verifikation aus der Web-UI

1. Browser hart neu laden (**Strg+Shift+R**).
2. Einstellungen → Drucker.
3. Unten sollte der Block „cups-browsed" den Status zeigen (🟢 läuft).
4. Klick auf „🔄 Neu starten" → Toast „OK", Status bleibt 🟢.
5. Ein disabled Drucker sollte einen roten Status-Badge zeigen und einen
   „🔄 Reaktivieren"-Button daneben.
6. Klick auf Reaktivieren → Drucker springt auf „bereit" (🟢).

Falls einer der Buttons Fehler zeigt: den Text im Toast (oder die
Antwort in DevTools → Network → `/api/printers/...`) hier kopieren und
ich helfe.

---

## Was die Web-UI jetzt kann (nach dem Setup)

| Situation | Aktion in der Web-UI |
|---|---|
| Drucker ist deaktiviert („disappeared") | Reaktivieren-Button |
| Alte Jobs stauen sich | Jobs-löschen-Button |
| Alter Drucker nicht mehr existent | Entfernen-Button |
| cups-browsed spielt verrückt | Neu-starten-Button |
| Drucker fest per IP eingerichtet | Deaktivieren-Button (dauerhaft cups-browsed aus) |

Kein SSH mehr nötig für Standard-Druckerprobleme.

---

## Nur wenn du „Weg B" (feste IP-Einbindung, cups-browsed aus) willst

Diese Doku bezieht sich auf die aktuelle Situation (cups-browsed nutzt
Auto-Discovery). Wenn du die Drucker fest per IP einbinden willst, ist
der zusätzliche Schritt in der Settings-UI:

1. Alle alten Auto-Discovery-Einträge über die „❌ Entfernen"-Buttons löschen
2. cups-browsed über „⏹ Dauerhaft deaktivieren" abschalten
3. Drucker manuell einrichten (über CUPS Web-UI unter
   `http://192.168.178.100:631/admin` oder per SSH mit `lpadmin -p ... -v ipp://<IP>`)

Danach hat der Server einen stabilen Drucker der nicht mehr durch
cups-browsed-Ausfälle deaktiviert werden kann.
