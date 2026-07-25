# HSMW Noten-Scanner

Ein Web-Scraper, der sich in das QIS/POS-Notenportal der Hochschule Mittweida
einloggt, die Notenübersicht öffnet und prüft, ob für ein bestimmtes Modul
bereits eine Note eingetragen ist.

Ablauf:

1. Öffnet `https://qispos.hs-mittweida.de/noten?intranet&m`
2. Loggt sich mit Benutzername/Kennwort ein
3. Klickt auf den Knopf zur Notenübersicht (z.B. "Notenspiegel")
4. Sucht die Zeile des konfigurierten Moduls in der Ergebnistabelle
5. Meldet, ob das Notenfeld leer oder bereits befüllt ist

Der Login-Formular- und Button-Erkennung sind bewusst tolerant/generisch
gehalten (mehrere Fallback-Selektoren), da die genaue Portal-Struktur ohne
gültige Zugangsdaten nicht live geprüft werden konnte. Falls ein Schritt
fehlschlägt, wird automatisch ein Screenshot + HTML-Snapshot in `debug/`
abgelegt, mit dessen Hilfe sich die Selektoren in `scraper.py` leicht
anpassen lassen.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

Konfiguration anlegen:

```bash
cp .env.example .env
```

Dann in `.env` eintragen:

- `QIS_USERNAME` / `QIS_PASSWORD` — deine Zugangsdaten
- `TARGET_MODULE` — Name/Teilstring des zu überwachenden Moduls, z.B. `Analysis 1`
- `GRADES_BUTTON_TEXT` — Text des Knopfes zur Notenübersicht (mehrere Kandidaten
  mit `|` trennen), Standard: `Notenspiegel|Leistungsspiegel|Prüfungsergebnisse|Notenübersicht`
- optional `SMTP_*` — falls eine E-Mail-Benachrichtigung gewünscht ist, sobald
  die Note eingetragen wurde. Ohne diese Angaben wird nur auf Konsole/Logfile
  ausgegeben.

Die `.env` wird nicht ins Git-Repo übernommen (`.gitignore`).

## Ausführen

```bash
python3 scraper.py
```

Optionen:

- `--target-module "Analysis 1"` — Modul für diesen Lauf überschreiben
- `--headed` — Browser sichtbar starten (zum Debuggen der Selektoren)

Exit-Codes: `0` = erfolgreich geprüft, `1` = Modul nicht gefunden,
`2` = Fehler (z.B. Login fehlgeschlagen, siehe `scraper.log` und `debug/`).

Ergebnis wird zusätzlich in `data/status.json` gespeichert (letzter geprüfter
Stand), damit bei wiederholten Läufen (z.B. per Cron) nur bei einer **neuen**
Note eine Benachrichtigung ausgelöst wird.

## Automatischer Lauf per Cron

Beispiel: alle 30 Minuten prüfen (crontab -e):

```
*/30 * * * * cd /pfad/zu/HSMW-Noten-Scanner && /pfad/zu/.venv/bin/python scraper.py >> cron.log 2>&1
```

## Anpassung bei Problemen

Falls das Login-Formular oder der Notenspiegel-Knopf nicht erkannt werden:

1. Lauf mit `--headed` starten und den Ablauf im Browser beobachten
2. Snapshots in `debug/` ansehen (Screenshot + HTML der Seite im Fehlerfall)
3. Selektoren in `scraper.py` (Funktionen `login`, `open_grades_view`,
   `parse_grades_table`) entsprechend der tatsächlichen Seitenstruktur anpassen

## Sicherheitshinweis

Die `.env`-Datei enthält dein Passwort im Klartext lokal auf deinem Rechner —
nicht committen, nicht weitergeben, Zugriffsrechte entsprechend einschränken.
