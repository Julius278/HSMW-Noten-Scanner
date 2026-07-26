# HSMW Noten-Scanner

[![Tests](https://github.com/Julius278/HSMW-Noten-Scanner/actions/workflows/tests.yml/badge.svg)](https://github.com/Julius278/HSMW-Noten-Scanner/actions/workflows/tests.yml)

Loggt sich in das QIS/POS-Notenportal der Hochschule Mittweida ein, öffnet die
Notenübersicht und prüft für ein oder mehrere Module, ob bereits eine Note
eingetragen ist. Es gibt zwei Umsetzungen mit identischem Ablauf:

- **[`iobroker/hsmw-noten-scanner.js`](iobroker/hsmw-noten-scanner.js)** —
  ioBroker-Script (javascript-Adapter), benachrichtigt per Pushover-Adapter.
  Beschrieben im Rest dieser Datei.
- **[`python/`](python/)** — eigenständige Python-Variante mit
  `config.toml`/Umgebungsvariablen, Zustand in einer JSON-Datei und Betrieb per
  cron oder `--loop`. Die Benachrichtigung wird dort derzeit nur geloggt.
  Details in [`python/README.md`](python/README.md).

Ablauf (identisch in beiden Varianten):

1. Öffnet `https://qispos.hs-mittweida.de/noten?intranet&m`
2. Loggt sich per Shibboleth-SSO (SAML2) mit Benutzername/Kennwort ein
3. Landet auf der Notenanzeige-Seite und öffnet die Ansicht "Alle Fächer
   anzeigen" (`?view=full`), die auch noch nicht bewertete Module zeigt
4. Bestätigt bei Bedarf einmalig die Rechtsbehelfsbelehrung (Formular
   `confirm_marks`)
5. Sucht die Zeilen der konfigurierten Module in der Ergebnistabelle
6. Loggt den Stand und speichert ihn (ioBroker-States bzw. `state.json`); nur
   beim Übergang von "nicht eingetragen" zu "eingetragen" wird zusätzlich
   benachrichtigt

Beide Varianten nutzen bewusst keinen Headless-Browser (kein
Playwright/Puppeteer), sondern einfache HTTP-Requests + HTML-Parsing
(`fetch`/`cheerio` bzw. `requests`/`beautifulsoup4`) — das ist deutlich
leichtgewichtiger und läuft problemlos auch auf einem Raspberry Pi.

Der Login läuft über den zentralen **Shibboleth-SSO** der Hochschule
Mittweida (separater IdP-Host, SAML2-POST-Binding). Beide Varianten:

- erkennen das Login-Formular (Felder `j_username`/`j_password`) generisch,
- halten Cookies **pro Hostname getrennt** (eigenes Jar im ioBroker-Script,
  `requests.Session` in der Python-Variante), da IdP und QIS/POS-Portal
  unterschiedliche Hosts sind und ggf. gleich benannte Session-Cookies
  verwenden,
- senden vor dem eigentlichen Login-Formular automatisch die technische
  "Client Storage Service"-Zwischenseite ab (JS-loses `<noscript>`-Formular)
  und überspringen danach einen erfolglosen **SPNEGO/Kerberos**-Anmeldeversuch
  (`/idp/profile/Authn/SPNEGO/...`, endet ohne Domänen-Ticket immer mit
  Status 401) über dessen `/error`-Endpunkt, genau wie es ein Browser ohne
  Kerberos-Ticket ebenfalls tut — erst danach erscheint das echte
  Passwort-Formular,
- folgen nach erfolgreichem Login automatisch der SAML-Zwischenseite
  (verstecktes Formular mit `SAMLResponse`/`RelayState`), die sich im echten
  Browser per JavaScript selbst zurück zum QIS/POS-Portal postet.

Die Notentabelle hat die Spalten `PNr, Vert, S, Modul, Credits/Wichtung, Art,
Fach, Note, Versuch, Status/Vermerk, PDatum, Meldung`. Gesucht wird in der
Spalte **Fach** (voller Modulname, z.B. "Beispielmodul 1"); eine leere
**Note**-Zelle bedeutet "noch nicht eingetragen" (z.B. bei Status `AN` =
angemeldet, aber noch offen). `targetModule` sollte also der volle oder
eindeutige Teilstring des Fach-Namens sein, nicht die kurze Modul-Kennung
(Spalte "Modul", z.B. "1234(M)").

Schlägt ein Schritt fehl, wird das im ioBroker-Log gemeldet; über
`CONFIG.debugDir` kann zusätzlich ein HTML-Snapshot der zuletzt geladenen
Seite auf die Platte geschrieben werden, um die Selektoren in
`iobroker/hsmw-noten-scanner.js` bei Bedarf anzupassen.

## Setup in ioBroker

1. **Adapter-Instanz vorbereiten:** In den Einstellungen der `javascript`-Adapter-Instanz
   unter "Zusätzliche NPM-Module" das Modul **`cheerio`** eintragen und die
   Instanz neu starten.

   Zur Node-Version: Das Script selbst braucht **Node.js ≥ 18** (liefert
   globales `fetch()`; bei älterem Node zusätzlich `node-fetch` eintragen).
   Das aktuelle `cheerio` (1.x) setzt allerdings **Node.js ≥ 20.18.1** voraus
   — es lädt `undici`, das den erst ab Node 20 globalen `File`-Konstruktor
   benötigt, sonst scheitert schon das Laden mit `File is not defined`. In der
   Praxis also **Node 20 oder neuer**. Wer auf Node 18 festsitzt, trägt
   stattdessen `cheerio@1.0.0-rc.12` ein — damit läuft das Script unverändert,
   die verwendeten cheerio-Funktionen sind in beiden Versionslinien gleich.
   Beide Kombinationen laufen in der CI (siehe [Tests / CI](#tests--ci)).
2. **Pushover-Adapter** installieren/einrichten (Instanz z.B. `pushover.0`),
   falls noch nicht vorhanden.
3. Neues **JavaScript-Script** (Typ „Javascript/js“) in der ioBroker-Scripts-Oberfläche
   anlegen und den Inhalt von [`iobroker/hsmw-noten-scanner.js`](iobroker/hsmw-noten-scanner.js)
   hineinkopieren.
4. Im `CONFIG`-Block am Anfang des Scripts anpassen:
   - `username` / `password` — deine QIS-Zugangsdaten
   - `targetModules` — Liste der zu überwachenden Module, z.B.
     `['Beispielmodul 1', 'Beispielmodul 2']`. Ein einzelner String ist
     ebenfalls erlaubt (`targetModules: 'Beispielmodul 1'`).
   - `pushoverInstance` / `pushoverSound` — z.B. `pushover.0`
   - `cronSchedule` — wie oft geprüft werden soll, Standard alle 15 Minuten
5. Script aktivieren/starten.

Alle Module werden in **einem** Durchlauf geprüft: einmal einloggen, einmal die
Notenübersicht laden, dann jede konfigurierte Modulzeile darin suchen. Pro neu
eingetragener Note geht genau eine Pushover-Nachricht raus.

### States

Der aktuelle Stand liegt unter `0_userdata.0.hsmwNotenScanner.*`, damit er sich
auch in VIS o.ä. anzeigen lässt:

| State | Bedeutung |
|---|---|
| `lastCheck` | Zeitstempel des letzten Durchlaufs |
| `modules.<Modul>.name` | Modulname wie konfiguriert |
| `modules.<Modul>.grade` | eingetragene Note, leer solange offen |
| `modules.<Modul>.graded` | `true`, sobald eine Note steht |
| `modules.<Modul>.lastCheck` | Zeitstempel für dieses Modul |

`<Modul>` ist der Modulname, reduziert auf `A–Z`, `a–z`, `0–9` und `_` (ioBroker
erlaubt in State-IDs keine Punkte); fallen zwei Namen dabei auf dieselbe ID,
wird durchnummeriert. Der Originalname steht darum zusätzlich im State `name`.

Eine Pushover-Benachrichtigung wird nur beim Übergang von "nicht eingetragen"
zu "eingetragen" verschickt, nicht bei jedem Lauf erneut.

Die früheren Einzel-States `lastGrade` und `lastGraded` gibt es weiterhin; sie
spiegeln das erste konfigurierte Modul, sodass bestehende VIS-Widgets aus
älteren Versionen unverändert funktionieren. Auch eine alte Konfiguration mit
`targetModule` (Einzahl) läuft ohne Änderung weiter.

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

## Tests / CI

Der Workflow [`.github/workflows/tests.yml`](.github/workflows/tests.yml) läuft
bei jedem Push und Pull Request:

- **Python** — die Testsuite aus `python/` auf Python 3.11, 3.12 und 3.13
  (`python -m unittest discover -s python`). Die Tests starten einen lokalen
  HTTP-Server, der den per HAR-Mitschnitt verifizierten Login-Ablauf nachbildet;
  es wird bewusst keine Verbindung zum echten Hochschulportal aufgebaut und es
  sind keine Zugangsdaten nötig.
- **ioBroker-Script** — die Testsuite aus `iobroker/test/` (`npm test`,
  Node-eigener Test-Runner). Die Globals der Adapter-Sandbox (`log`, `schedule`,
  `sendTo`, `createStateAsync`, ...) werden gestubbt und das Script gegen
  denselben nachgebildeten Login-Ablauf laufen gelassen. Dazu `node --check` als
  Syntax-Prüfung. Getestet werden vier Kombinationen:

  | Node.js | cheerio |
  |---|---|
  | 20, 22, 24 | aktuelles 1.x (aus `package-lock.json`) |
  | 18 | `1.0.0-rc.12` |

  Damit ist auch der oben beschriebene Weg für ältere Installationen dauerhaft
  abgedeckt und nicht nur einmalig geprüft.

Lokal ausführen:

```bash
pip install -r python/requirements.txt
python -m unittest discover -s python -v

cd iobroker && npm install && npm test
```

## Sicherheitshinweis

Das Script enthält dein Passwort im Klartext im `CONFIG`-Block. Zugriff auf
die ioBroker-Scripts-Oberfläche entsprechend einschränken und das Script
nicht ungeschützt weitergeben/veröffentlichen.

In der Python-Variante lassen sich die Zugangsdaten stattdessen über
Umgebungsvariablen setzen (`HSMW_USERNAME`/`HSMW_PASSWORD`), sodass sie nicht
in einer Datei liegen müssen. `config.toml` und `state.json` sind per
`.gitignore` ausgenommen.

## Entstehung des Codes

Große Teile dieses Repositories sind mit **Claude Code** generiert — in der
Commit-Historie ist das ohnehin nachvollziehbar. Der Ablauf war iterativ: das
Grundgerüst wurde generiert und anschließend anhand echter HTML-Exporte und
eines HAR-Mitschnitts des Login-Vorgangs korrigiert, bis der Shibboleth-Flow
(inkl. Client-Storage-Zwischenseite und SPNEGO-Sackgasse) und die
Tabellenauswertung wirklich passten.

Das ioBroker-Script läuft im echten Betrieb, die Python-Variante ist gegen den
nachgebildeten Ablauf getestet, aber nicht über Wochen erprobt. Wer das
übernimmt, sollte den Code entsprechend selbst prüfen — insbesondere die
Selektoren, die sich mit jeder Änderung am Portal verschieben können.
