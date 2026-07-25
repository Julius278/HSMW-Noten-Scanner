# HSMW Noten-Scanner — Python-Variante

Eigenständige Python-Portierung des ioBroker-Scripts aus
[`../iobroker/hsmw-noten-scanner.js`](../iobroker/hsmw-noten-scanner.js).
Gleicher Ablauf — Shibboleth-SSO-Login (inkl. SPNEGO-Bypass), Notenübersicht
öffnen, "Note"-Spalte des gesuchten Moduls auswerten — nur ohne ioBroker:

| | ioBroker-Script | Python-Variante |
|---|---|---|
| Konfiguration | `CONFIG`-Block im Quelltext | `config.toml` + Umgebungsvariablen |
| HTML-Parsing | `cheerio` | `beautifulsoup4` |
| HTTP | `fetch` + eigenes Cookie-Handling | `requests.Session` |
| Zustand | ioBroker-States | JSON-Datei (`state.json`) |
| Zeitplan | `schedule()` des Adapters | `--loop` oder cron/systemd-Timer |
| Benachrichtigung | Pushover-Adapter | **derzeit nur Log** (siehe unten) |

## Installation

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Benötigt Python ≥ 3.11 (wegen `tomllib` in der Standardbibliothek).

## Konfiguration

```bash
cp config.example.toml config.toml
$EDITOR config.toml          # username, password, target_modules
```

`config.toml` ist per `.gitignore` ausgenommen, damit die Zugangsdaten nicht
im Repository landen. Alternativ (und mit Vorrang) gehen alle Werte auch über
Umgebungsvariablen — praktisch für systemd oder Container, damit das Passwort
nicht in einer Datei steht:

| Variable | Bedeutung |
|---|---|
| `HSMW_USERNAME` | QIS-Benutzername (ohne `@hs-mittweida.de`) |
| `HSMW_PASSWORD` | QIS-Kennwort |
| `HSMW_URL` | Startseite, Standard `https://qispos.hs-mittweida.de/noten?intranet&m` |
| `HSMW_TARGET_MODULES` | kommaseparierte Modulliste, z.B. `Blockchain 4,Analysis 2` |
| `HSMW_INTERVAL_MINUTES` | Intervall für `--loop` |
| `HSMW_STATE_FILE` | Pfad der Zustandsdatei |
| `HSMW_DEBUG_DIR` | Verzeichnis für HTML-Snapshots bei Fehlern |

Gesucht wird in der Spalte **Fach**, also der volle bzw. eindeutige Modulname
("Blockchain 4"), nicht die kurze Kennung aus der Spalte "Modul" (`8104(M)`).
Groß-/Kleinschreibung ist unerheblich.

## Aufruf

```bash
python3 hsmw_noten_scanner.py                        # einmalig prüfen
python3 hsmw_noten_scanner.py --module "Blockchain 4"  # Modul ad hoc überschreiben
python3 hsmw_noten_scanner.py --loop                 # dauerhaft, alle 15 min
python3 hsmw_noten_scanner.py -v                     # mit Debug-Logging
```

Beispielausgabe:

```
2026-07-25 12:00:01 INFO    Öffne https://qispos.hs-mittweida.de/noten?intranet&m
2026-07-25 12:00:02 INFO    Sende technische Zwischenseite automatisch ab (Titel: "Client Storage Service")...
2026-07-25 12:00:02 INFO    SPNEGO/Kerberos-Anmeldeversuch erkannt (Status 401), erzwinge Fallback auf Formular-Login...
2026-07-25 12:00:03 INFO    Login erfolgreich.
2026-07-25 12:00:03 INFO    Öffne vollständige Notenübersicht (alle Fächer)...
2026-07-25 12:00:04 INFO    Note für "Blockchain 4" ist noch nicht eingetragen.
```

Exit-Codes: `0` = Lauf ok, `1` = Fehler beim Abrufen/Parsen, `2` = Konfiguration
unvollständig.

### Als cron-Job (alle 15 Minuten)

```cron
*/15 * * * * cd /pfad/zu/HSMW-Noten-Scanner/python && .venv/bin/python hsmw_noten_scanner.py >> scanner.log 2>&1
```

Für den Dauerbetrieb per systemd stattdessen `--loop` verwenden und die
Zugangsdaten über `Environment=`/`EnvironmentFile=` setzen.

## Benachrichtigung

Der Versandweg steht noch nicht fest, daher wird eine neu eingetragene Note
vorerst **nur geloggt**:

```
2026-07-25 12:15:04 INFO    BENACHRICHTIGUNG: Note für Blockchain 4 wurde eingetragen: 1,7
```

Zum Aktivieren eines echten Kanals genügt es, `notify()` in
[`hsmw_noten_scanner.py`](hsmw_noten_scanner.py) zu erweitern — die Funktion
bekommt die fertige Nachricht als String. Beispiel für Pushover:

```python
def notify(message: str) -> None:
    LOG.info("BENACHRICHTIGUNG: %s", message)
    requests.post(
        "https://api.pushover.net/1/messages.json",
        data={
            "token": os.environ["PUSHOVER_TOKEN"],
            "user": os.environ["PUSHOVER_USER"],
            "title": "HSMW Noten-Scanner",
            "message": message,
        },
        timeout=10,
    )
```

Wie beim ioBroker-Script wird nur beim Übergang von "nicht eingetragen" zu
"eingetragen" benachrichtigt, nicht bei jedem Lauf erneut — dafür merkt sich
`state.json` den letzten Stand pro Modul:

```json
{
  "last_check": "2026-07-25T12:15:04+00:00",
  "modules": {
    "Blockchain 4": {
      "grade": "1,7",
      "graded": true,
      "row": "8104 | 1 | 6 | 8104(M) | 5.0 | PL | Blockchain 4 | 1,7 | 1 | BE | 20.07.2026 | ",
      "last_check": "2026-07-25T12:15:04+00:00"
    }
  }
}
```

Zum erneuten Auslösen (z.B. beim Testen) einfach `state.json` löschen.

## Tests

```bash
cd python && python3 -m unittest test_hsmw_noten_scanner -v
```

Die Tests starten einen lokalen HTTP-Server, der den per HAR-Mitschnitt
verifizierten Ablauf nachbildet (Client-Storage-Zwischenseite → SPNEGO-401 →
`/error`-Fallback → Login-Formular → SAML-Relay → Rechtsbehelfsbelehrung →
Notentabelle) und prüfen zusätzlich die Spaltenauswertung sowie dass die
Benachrichtigung nur beim Statuswechsel ausgelöst wird. Es wird nichts nach
außen verbunden.

## Fehlersuche

`debug_dir` in `config.toml` (bzw. `HSMW_DEBUG_DIR`) setzen — bei
Login-Fehlern, unbekanntem Modul oder fehlender Tabelle landet dort ein
HTML-Snapshot der zuletzt geladenen Seite. Damit lassen sich die Selektoren in
`login()`, `open_grades_view()` und `parse_grades_table()` an geänderte
Seitenstrukturen anpassen.
