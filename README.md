# HSMW Noten-Scanner (ioBroker)

Ein ioBroker-Script (javascript-Adapter), das sich in das QIS/POS-Notenportal
der Hochschule Mittweida einloggt, die Notenübersicht öffnet und prüft, ob
für ein bestimmtes Modul bereits eine Note eingetragen ist. Bei einer neu
eingetragenen Note wird per Pushover-Adapter benachrichtigt.

Ablauf:

1. Öffnet `https://qispos.hs-mittweida.de/noten?intranet&m`
2. Loggt sich per Shibboleth-SSO (SAML2) mit Benutzername/Kennwort ein
3. Landet auf der Notenanzeige-Seite und öffnet die Ansicht "Alle Fächer
   anzeigen" (`?view=full`), die auch noch nicht bewertete Module zeigt
4. Bestätigt bei Bedarf einmalig die Rechtsbehelfsbelehrung (Formular
   `confirm_marks`)
5. Sucht die Zeile des konfigurierten Moduls in der Ergebnistabelle
6. Meldet per `log()` und speichert den Stand in ioBroker-States; bei einer
   **neuen** Note wird zusätzlich eine Pushover-Nachricht verschickt

Das Script nutzt bewusst keinen Headless-Browser (kein Playwright/Puppeteer),
sondern einfache HTTP-Requests (`fetch`) + HTML-Parsing (`cheerio`) mit
manueller Cookie-Verwaltung — das ist deutlich leichtgewichtiger und läuft
problemlos auch auf einem Raspberry Pi.

Der Login läuft über den zentralen **Shibboleth-SSO** der Hochschule
Mittweida (separater IdP-Host, SAML2-POST-Binding). Das Script:

- erkennt das Login-Formular (Felder `j_username`/`j_password`) generisch,
- übermittelt Cookies **pro Hostname getrennt**, da IdP und QIS/POS-Portal
  unterschiedliche Hosts sind und ggf. gleich benannte Session-Cookies
  verwenden,
- folgt nach erfolgreichem Login automatisch der SAML-Zwischenseite
  (verstecktes Formular mit `SAMLResponse`/`RelayState`), die sich im echten
  Browser per JavaScript selbst zurück zum QIS/POS-Portal postet.

Die Notentabelle hat die Spalten `PNr, Vert, S, Modul, Credits/Wichtung, Art,
Fach, Note, Versuch, Status/Vermerk, PDatum, Meldung`. Gesucht wird in der
Spalte **Fach** (voller Modulname, z.B. "Blockchain 1"); eine leere **Note**-
Zelle bedeutet "noch nicht eingetragen" (z.B. bei Status `AN` = angemeldet,
aber noch offen). `TARGET_MODULE` sollte also der volle oder eindeutige
Teilstring des Fach-Namens sein, nicht die kurze Modul-Kennung (Spalte
"Modul", z.B. "8102(M)").

Schlägt ein Schritt fehl, wird das im ioBroker-Log gemeldet; über
`CONFIG.debugDir` kann zusätzlich ein HTML-Snapshot der zuletzt geladenen
Seite auf die Platte geschrieben werden, um die Selektoren in
`iobroker/hsmw-noten-scanner.js` bei Bedarf anzupassen.

## Setup in ioBroker

1. **Adapter-Instanz vorbereiten:** In den Einstellungen der `javascript`-Adapter-Instanz
   unter "Zusätzliche NPM-Module" das Modul **`cheerio`** eintragen und die
   Instanz neu starten. (Node.js ≥ 18 wird vorausgesetzt, liefert dann
   globales `fetch()`. Bei älterem Node zusätzlich `node-fetch` eintragen.)
2. **Pushover-Adapter** installieren/einrichten (Instanz z.B. `pushover.0`),
   falls noch nicht vorhanden.
3. Neues **JavaScript-Script** (Typ „Javascript/js“) in der ioBroker-Scripts-Oberfläche
   anlegen und den Inhalt von [`iobroker/hsmw-noten-scanner.js`](iobroker/hsmw-noten-scanner.js)
   hineinkopieren.
4. Im `CONFIG`-Block am Anfang des Scripts anpassen:
   - `username` / `password` — deine QIS-Zugangsdaten
   - `targetModule` — Name/Teilstring des zu überwachenden Moduls, z.B. `Analysis 1`
   - `pushoverInstance` / `pushoverSound` — z.B. `pushover.0`
   - `cronSchedule` — wie oft geprüft werden soll, Standard alle 30 Minuten
5. Script aktivieren/starten.

Der aktuelle Stand wird unter `0_userdata.0.hsmwNotenScanner.*` als States
abgelegt (`lastGrade`, `lastGraded`, `lastCheck`) — darüber lässt sich der
Status auch in VIS o.ä. anzeigen. Eine Pushover-Benachrichtigung wird nur
beim Übergang von "nicht eingetragen" zu "eingetragen" verschickt, nicht bei
jedem Lauf erneut.

## Anpassung bei Problemen

Falls Login-Formular, Notenspiegel-Knopf oder Tabellen-Layout nicht erkannt
werden:

1. `CONFIG.debugDir` auf einen beschreibbaren Pfad setzen (z.B.
   `/opt/iobroker/hsmw-noten-scanner-debug`) — bei Fehlern wird dort ein
   HTML-Snapshot der zuletzt geladenen Seite abgelegt.
2. Snapshot ansehen und die Selektoren in `iobroker/hsmw-noten-scanner.js`
   (Funktionen `login`, `openGradesView`, `parseGradesTable`) entsprechend
   der tatsächlichen Seitenstruktur anpassen.
3. Im ioBroker-Log (`log()`-Ausgaben) nachvollziehen, an welchem Schritt es
   scheitert.

## Sicherheitshinweis

Das Script enthält dein Passwort im Klartext im `CONFIG`-Block. Zugriff auf
die ioBroker-Scripts-Oberfläche entsprechend einschränken und das Script
nicht ungeschützt weitergeben/veröffentlichen.
