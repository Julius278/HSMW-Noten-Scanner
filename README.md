# HSMW Noten-Scanner (ioBroker)

Ein ioBroker-Script (javascript-Adapter), das sich in das QIS/POS-Notenportal
der Hochschule Mittweida einloggt, die Notenübersicht öffnet und prüft, ob
für ein bestimmtes Modul bereits eine Note eingetragen ist. Bei einer neu
eingetragenen Note wird per Pushover-Adapter benachrichtigt.

Ablauf:

1. Öffnet `https://qispos.hs-mittweida.de/noten?intranet&m`
2. Loggt sich mit Benutzername/Kennwort ein (klassisches Formular + Session-Cookie)
3. Folgt dem Link/Knopf zur Notenübersicht (z.B. "Notenspiegel")
4. Sucht die Zeile des konfigurierten Moduls in der Ergebnistabelle
5. Meldet per `log()` und speichert den Stand in ioBroker-States; bei einer
   **neuen** Note wird zusätzlich eine Pushover-Nachricht verschickt

Das Script nutzt bewusst keinen Headless-Browser (kein Playwright/Puppeteer),
sondern einfache HTTP-Requests (`fetch`) + HTML-Parsing (`cheerio`) mit
manueller Cookie-Verwaltung — das ist deutlich leichtgewichtiger und läuft
problemlos auch auf einem Raspberry Pi.

Login-Formular- und Button-Erkennung sind generisch gehalten (erstes
Passwortfeld im ersten `<form>` mit Passwortfeld = Login-Formular, erstes
Textfeld darin = Benutzername), da die genaue Portal-Struktur ohne gültige
Zugangsdaten nicht live geprüft werden konnte. Schlägt ein Schritt fehl, wird
das im ioBroker-Log gemeldet; über `CONFIG.debugDir` kann zusätzlich ein
HTML-Snapshot der zuletzt geladenen Seite auf die Platte geschrieben werden,
um die Selektoren in `iobroker/hsmw-noten-scanner.js` bei Bedarf anzupassen.

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
   - `buttonCandidates` — Text des Knopfes zur Notenübersicht (mehrere Kandidaten möglich)
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
