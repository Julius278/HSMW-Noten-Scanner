#!/usr/bin/env python3
"""HSMW Noten-Scanner (Python-Variante).

Loggt sich in das QIS/POS-Notenportal der Hochschule Mittweida ein, öffnet die
Notenübersicht und prüft, ob für ein bestimmtes Modul bereits eine Note
eingetragen ist.

Portierung des ioBroker-Scripts (`iobroker/hsmw-noten-scanner.js`) auf Python.
Gleicher Login-Flow (Shibboleth-SSO, SAML2-POST-Binding, SPNEGO-Bypass) und
gleiche Tabellen-Auswertung, aber:

  * Konfiguration über TOML-Datei und/oder Umgebungsvariablen statt inline
    im Quelltext (siehe `config.example.toml`),
  * Zustand wird in einer JSON-Datei gehalten statt in ioBroker-States,
  * Benachrichtigung wird derzeit **nur geloggt** (siehe `notify()`) - der
    tatsächliche Versandweg (Pushover, Mail, Matrix, ...) ist noch offen und
    kann dort ergänzt werden.

Aufruf:

    python3 hsmw_noten_scanner.py                 # einmalig prüfen (für cron)
    python3 hsmw_noten_scanner.py --loop          # dauerhaft im Intervall
    python3 hsmw_noten_scanner.py --module "Beispielmodul 1"
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

LOG = logging.getLogger("hsmw-noten-scanner")

# Manche Uni-Systeme/WAFs blockieren oder liefern anderen Inhalt bei Anfragen
# ohne "normalen" Browser-User-Agent - deshalb wird hier bewusst ein üblicher
# Browser-Header mitgeschickt.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
}

# Werte, die als "noch keine Note eingetragen" gewertet werden. Laut echtem
# HTML-Export ist die "Note"-Zelle schlicht leer, solange keine Note
# eingetragen ist (z.B. bei Status "AN" = angemeldet); die Platzhalter hier
# sind zusätzliche Absicherung, falls ein Modultyp Text statt Leerzelle nutzt.
UNGRADED_VALUES = {"-", "--", "n.b.", "offen"}

# Der Shibboleth-IdP versucht vor dem Passwort-Formular zusätzlich eine
# SPNEGO/Kerberos-Anmeldung (SSO per Windows-Domänenticket). Ohne Ticket - und
# ohne Browser - schlägt das immer mit Status 401 fehl; ein Browser bricht den
# Versuch dann selbst ab, indem er den zugehörigen "/error"-Endpunkt mit
# derselben Conversation-ID aufruft. Das führt zurück in den normalen
# Login-Flow, der schließlich auf der Seite mit dem Passwort-Formular landet.
SPNEGO_PATH_MARKER = "/idp/profile/Authn/SPNEGO/"


# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------


@dataclass
class Config:
    username: str = ""
    password: str = ""
    url: str = "https://qispos.hs-mittweida.de/noten?intranet&m"
    target_modules: list[str] = field(default_factory=list)
    interval_minutes: int = 15
    request_timeout_s: float = 20.0
    state_file: Path = Path("state.json")
    debug_dir: Path | None = None


def _env_override(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else None


def load_config(config_path: Path | None) -> Config:
    """Liest die Konfiguration aus TOML-Datei und Umgebungsvariablen.

    Umgebungsvariablen (`HSMW_USERNAME`, `HSMW_PASSWORD`, `HSMW_URL`,
    `HSMW_TARGET_MODULES`, `HSMW_INTERVAL_MINUTES`, `HSMW_STATE_FILE`,
    `HSMW_DEBUG_DIR`) haben Vorrang, damit Zugangsdaten nicht in einer Datei
    liegen müssen. `HSMW_TARGET_MODULES` ist eine kommaseparierte Liste.
    """
    cfg = Config()
    raw: dict[str, Any] = {}

    if config_path is not None:
        if not config_path.is_file():
            raise SystemExit(f"Konfigurationsdatei nicht gefunden: {config_path}")
        with config_path.open("rb") as fh:
            raw = tomllib.load(fh)

    cfg.username = str(raw.get("username", cfg.username))
    cfg.password = str(raw.get("password", cfg.password))
    cfg.url = str(raw.get("url", cfg.url))

    modules = raw.get("target_modules")
    if modules is None and raw.get("target_module"):
        modules = [raw["target_module"]]
    if modules:
        cfg.target_modules = [str(m) for m in modules]

    cfg.interval_minutes = int(raw.get("interval_minutes", cfg.interval_minutes))
    cfg.request_timeout_s = float(raw.get("request_timeout_s", cfg.request_timeout_s))

    base_dir = config_path.parent if config_path is not None else Path.cwd()
    cfg.state_file = (base_dir / str(raw.get("state_file", cfg.state_file))).resolve()
    if raw.get("debug_dir"):
        cfg.debug_dir = (base_dir / str(raw["debug_dir"])).resolve()

    if (value := _env_override("HSMW_USERNAME")) is not None:
        cfg.username = value
    if (value := _env_override("HSMW_PASSWORD")) is not None:
        cfg.password = value
    if (value := _env_override("HSMW_URL")) is not None:
        cfg.url = value
    if (value := _env_override("HSMW_TARGET_MODULES")) is not None:
        cfg.target_modules = [m.strip() for m in value.split(",") if m.strip()]
    if (value := _env_override("HSMW_INTERVAL_MINUTES")) is not None:
        cfg.interval_minutes = int(value)
    if (value := _env_override("HSMW_STATE_FILE")) is not None:
        cfg.state_file = Path(value).expanduser().resolve()
    if (value := _env_override("HSMW_DEBUG_DIR")) is not None:
        cfg.debug_dir = Path(value).expanduser().resolve()

    return cfg


# ---------------------------------------------------------------------------
# HTTP-Client
# ---------------------------------------------------------------------------


@dataclass
class Page:
    """Eine geladene Seite: Endstand nach allen Redirects."""

    url: str
    status: int
    body: str

    @property
    def soup(self) -> BeautifulSoup:
        return BeautifulSoup(self.body, "html.parser")


class PortalError(RuntimeError):
    """Fehler im Login-/Scraping-Ablauf."""


class Scanner:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        # requests.Session verwaltet Cookies bereits korrekt pro Domain -
        # wichtig, da der Login über einen separaten Shibboleth-IdP-Host läuft
        # und beide Hosts z.B. denselben Cookie-Namen "JSESSIONID" verwenden
        # können.
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)

    # -- Basis-Requests ---------------------------------------------------

    def get(self, url: str) -> Page:
        return self._request("GET", url)

    def post(self, url: str, data: dict[str, str]) -> Page:
        return self._request("POST", url, data=data)

    def _request(self, method: str, url: str, data: dict[str, str] | None = None) -> Page:
        res = self.session.request(
            method,
            url,
            data=data,
            timeout=self.cfg.request_timeout_s,
            allow_redirects=True,
        )
        return Page(url=res.url, status=res.status_code, body=res.text)

    # -- Formular-Hilfsfunktionen -----------------------------------------

    @staticmethod
    def collect_form_params(form: Any, overrides: dict[str, str] | None = None) -> dict[str, str]:
        """Sammelt die abzusendenden Felder eines Formulars.

        `<button>` ohne explizites type-Attribut ist laut HTML-Spezifikation
        ein Submit-Button (so ist z.B. der Shibboleth-Anmeldeknopf
        `<button type="submit" name="_eventId_proceed">` aufgebaut) - muss also
        mitberücksichtigt werden, nicht nur `<input type=submit>`. Von mehreren
        Submit-Buttons wird wie im Browser nur der erste übertragen.
        """
        params: dict[str, str] = {}
        submit_added = False

        for el in form.find_all(["input", "select", "textarea", "button"]):
            name = el.get("name")
            if not name:
                continue

            tag = el.name.lower()
            if tag == "input":
                el_type = (el.get("type") or "text").lower()
            elif tag == "button":
                el_type = (el.get("type") or "submit").lower()
            else:
                el_type = tag

            if el_type in ("submit", "image"):
                if not submit_added:
                    params[name] = el.get("value") or ""
                    submit_added = True
                continue
            if el_type in ("button", "reset"):
                continue  # nicht Teil der übermittelten Formulardaten
            if el_type in ("checkbox", "radio"):
                if el.has_attr("checked"):
                    params[name] = el.get("value") or "on"
                continue
            if el_type == "select":
                selected = el.find("option", selected=True) or el.find("option")
                if selected is not None:
                    params[name] = selected.get("value", selected.get_text(strip=True))
                else:
                    params[name] = ""
                continue
            if el_type == "textarea":
                params[name] = el.get_text()
                continue

            params[name] = el.get("value") or ""

        params.update(overrides or {})
        return params

    def submit_form(self, form: Any, page_url: str, overrides: dict[str, str] | None = None) -> Page:
        action = form.get("action") or ""
        method = (form.get("method") or "GET").upper()
        action_url = urljoin(page_url, action) if action else page_url
        params = self.collect_form_params(form, overrides)

        if method == "POST":
            return self.post(action_url, params)

        prepared = requests.Request("GET", action_url, params=params).prepare()
        return self.get(prepared.url)

    # -- SSO-Zwischenseiten ------------------------------------------------

    def bypass_intermediate_forms(self, page: Page, max_steps: int = 8) -> Page:
        """Arbeitet die technischen Zwischenschritte vor dem Login-Formular ab.

        Der Shibboleth-IdP zeigt vor dem eigentlichen Login zwei Stationen, die
        im Browser nur durch JavaScript bzw. Kerberos funktionieren:

        1. den "Client Storage Service" (prüft per JS, ob im localStorage schon
           eine Sitzung liegt) - dessen `<noscript>`-Fallback ist ein normales
           POST-Formular, das mit seinen Standardwerten abgeschickt werden kann,
        2. den SPNEGO/Kerberos-Versuch, der ohne Domänenticket mit 401 endet und
           über seinen `/error`-Endpunkt abgebrochen werden muss.
        """
        current = page
        for _ in range(max_steps):
            if current.soup.select_one("input[type=password]"):
                return current

            parsed = urlparse(current.url)
            if SPNEGO_PATH_MARKER in parsed.path and not parsed.path.endswith("/error"):
                LOG.info(
                    "SPNEGO/Kerberos-Anmeldeversuch erkannt (Status %s), "
                    "erzwinge Fallback auf Formular-Login...",
                    current.status,
                )
                error_url = urlunparse(parsed._replace(path=parsed.path + "/error"))
                current = self.get(error_url)
                continue

            # Nur POST-Formulare berücksichtigen: technische SSO-Zwischenschritte
            # (Client Storage, SAML-Relay) sind immer POST, während z.B. das
            # Suchformular im Seitenkopf (GET) sonst fälschlich gegriffen würde.
            form = next(
                (
                    f
                    for f in current.soup.find_all("form")
                    if (f.get("method") or "GET").upper() == "POST"
                ),
                None,
            )
            if form is None:
                return current

            title = current.soup.title.get_text(strip=True) if current.soup.title else ""
            LOG.info('Sende technische Zwischenseite automatisch ab (Titel: "%s")...', title)
            current = self.submit_form(form, current.url)

        return current

    def follow_intermediate_forms(self, page: Page, max_steps: int = 5) -> Page:
        """Folgt der SAML-Zwischenseite nach erfolgreichem Login.

        Nach dem Login liefert der IdP keine direkte Weiterleitung, sondern eine
        Seite mit einem versteckten Formular (SAML2-POST-Binding: Felder
        `SAMLResponse`/`RelayState`), das sich im Browser per JavaScript selbst
        an den Service Provider zurückpostet. Da hier kein JS läuft, wird es
        manuell abgeschickt.
        """
        current = page
        for _ in range(max_steps):
            soup = current.soup
            if soup.select_one("input[type=password]"):
                return current

            form = next(
                (
                    f
                    for f in soup.find_all("form")
                    if f.select_one("input[name=SAMLResponse]") or f.select_one("input[name=SAMLart]")
                ),
                None,
            )
            if form is None:
                return current

            LOG.info("Folge automatischem SSO-Weiterleitungsformular...")
            current = self.submit_form(form, current.url)

        return current

    # -- Login -------------------------------------------------------------

    def login(self) -> Page:
        LOG.info("Öffne %s", self.cfg.url)
        page = self.bypass_intermediate_forms(self.get(self.cfg.url))
        soup = page.soup

        if not soup.select_one("input[type=password]"):
            title = soup.title.get_text(strip=True) if soup.title else ""
            LOG.info(
                'Kein Login-Formular gefunden, vermutlich bereits eingeloggt. '
                '(Status %s, gelandet auf %s, Titel: "%s")',
                page.status,
                page.url,
                title,
            )
            self.dump_debug("no-login-form-assumed-logged-in", page.body)
            return page

        form = next(
            (f for f in soup.find_all("form") if f.select_one("input[type=password]")),
            None,
        )
        if form is None:
            self.dump_debug("login-no-form", page.body)
            raise PortalError("Login-Seite enthält ein Passwortfeld, aber kein umschließendes <form>.")

        username_field = None
        for el in form.find_all("input"):
            if (el.get("type") or "text").lower() in ("text", "email") and el.get("name"):
                username_field = el["name"]
                break
        if username_field is None:
            self.dump_debug("login-no-username-field", page.body)
            raise PortalError("Konnte kein Benutzername-Feld im Login-Formular finden.")

        password_field = form.select_one("input[type=password]").get("name")
        if not password_field:
            self.dump_debug("login-no-password-name", page.body)
            raise PortalError("Passwortfeld im Login-Formular hat kein name-Attribut.")

        result = self.submit_form(
            form,
            page.url,
            {username_field: self.cfg.username, password_field: self.cfg.password},
        )
        result = self.follow_intermediate_forms(result)

        if result.soup.select_one("input[type=password]"):
            self.dump_debug("login-failed", result.body)
            raise PortalError("Login fehlgeschlagen (Passwortfeld weiterhin sichtbar). Zugangsdaten prüfen.")

        LOG.info("Login erfolgreich.")
        return result

    # -- Notenübersicht ----------------------------------------------------

    def open_grades_view(self, page: Page) -> Page:
        """Öffnet die Ansicht "Alle Fächer anzeigen" (`?view=full`).

        Die Standardansicht zeigt nur bereits benotete Module; erst `?view=full`
        listet auch noch offene Prüfungen. Davor muss ggf. einmalig die
        Rechtsbehelfsbelehrung bestätigt werden (Formular mit versteckem Feld
        `confirm_marks`).
        """
        link = next(
            (a for a in page.soup.find_all("a") if "view=full" in (a.get("href") or "").lower()),
            None,
        )
        if link is not None:
            full_view_url = urljoin(page.url, link["href"])
        else:
            # Laut echtem HTML-Export liegt der Link immer unter dem Root-Pfad
            # ("/?view=full"), unabhängig vom aktuellen Pfad.
            full_view_url = urljoin(page.url, "/?view=full")

        LOG.info("Öffne vollständige Notenübersicht (alle Fächer)...")
        current = self.get(full_view_url)

        confirm_form = next(
            (
                f
                for f in current.soup.find_all("form")
                if f.select_one("input[name=confirm_marks]")
            ),
            None,
        )
        if confirm_form is not None:
            LOG.info("Bestätige Rechtsbehelfsbelehrung...")
            current = self.submit_form(confirm_form, current.url)

        return current

    # -- Debug -------------------------------------------------------------

    def dump_debug(self, name: str, html: str) -> None:
        if self.cfg.debug_dir is None:
            return
        try:
            self.cfg.debug_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
            target = self.cfg.debug_dir / f"{stamp}-{name}.html"
            target.write_text(html, encoding="utf-8")
            LOG.info("Debug-Snapshot gespeichert: %s", target)
        except OSError as err:
            LOG.warning("Konnte Debug-Snapshot nicht schreiben: %s", err)


# ---------------------------------------------------------------------------
# Notentabelle parsen
# ---------------------------------------------------------------------------


@dataclass
class Table:
    headers: list[str]
    rows: list[list[str]]


def parse_grades_table(html: str) -> list[Table]:
    """Liest alle Tabellen mit Datenzeilen aus der Notenübersicht.

    Echte Spalten laut HTML-Export: PNr, Vert, S, Modul, Credits/Wichtung, Art,
    Fach, Note, Versuch, Status/Vermerk, PDatum, Meldung. Die Kopfzeile wird
    mit ausgelesen, damit "Fach" und "Note" unabhängig von ihrer Position
    gefunden werden können.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables: list[Table] = []

    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True) for th in table.select("thead th")]
        rows: list[list[str]] = []
        for tr in table.find_all("tr"):
            if tr.find_parent("thead") is not None:
                continue
            cells = [" ".join(td.get_text().split()) for td in tr.find_all("td")]
            if not cells or not any(cells):
                continue
            rows.append(cells)
        if rows:
            tables.append(Table(headers=headers, rows=rows))

    return tables


@dataclass
class GradeResult:
    row_text: str
    grade: str | None

    @property
    def is_graded(self) -> bool:
        return bool(self.grade) and self.grade.strip().lower() not in UNGRADED_VALUES


def find_target_grade(tables: Iterable[Table], target_module: str) -> GradeResult | None:
    """Sucht die Zeile des Moduls und liest deren "Note"-Spalte aus.

    Eine leere Note-Zelle bedeutet "noch nicht eingetragen" (z.B. bei Status
    "AN" = angemeldet, aber noch offen).
    """
    target_lower = target_module.lower()

    for table in tables:
        note_idx = next(
            (i for i, h in enumerate(table.headers) if h.lower() == "note"),
            -1,
        )
        for cells in table.rows:
            if not any(target_lower in c.lower() for c in cells):
                continue

            if 0 <= note_idx < len(cells):
                grade = cells[note_idx].strip() or None
            else:
                # Fallback, falls die Kopfzeile nicht erkannt wurde: letzte
                # nicht-leere Zelle, die nicht der gesuchte Text selbst ist.
                grade = None
                for cell in reversed(cells):
                    value = cell.strip()
                    if value and value.lower() != target_lower and len(value) <= 30:
                        grade = value
                        break

            return GradeResult(row_text=" | ".join(cells), grade=grade)

    return None


# ---------------------------------------------------------------------------
# Zustand & Benachrichtigung
# ---------------------------------------------------------------------------


def load_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        LOG.warning("Konnte Zustandsdatei %s nicht lesen (%s), beginne mit leerem Zustand.", path, err)
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError as err:
        LOG.error("Konnte Zustandsdatei %s nicht schreiben: %s", path, err)


def notify(message: str) -> None:
    """Benachrichtigung über eine neu eingetragene Note.

    Wird derzeit bewusst nur geloggt - der Versandweg steht noch nicht fest.
    Zum Aktivieren hier den gewünschten Kanal ergänzen, z.B.:

        requests.post(
            "https://api.pushover.net/1/messages.json",
            data={"token": ..., "user": ..., "message": message},
            timeout=10,
        )
    """
    LOG.info("BENACHRICHTIGUNG: %s", message)


# ---------------------------------------------------------------------------
# Hauptlogik
# ---------------------------------------------------------------------------


def check_grades(cfg: Config) -> int:
    """Ein Prüflauf. Rückgabewert ist der Exit-Code (0 = ok)."""
    if not cfg.username or not cfg.password:
        LOG.error("Benutzername/Kennwort fehlen - config.toml oder HSMW_USERNAME/HSMW_PASSWORD setzen.")
        return 2
    if not cfg.target_modules:
        LOG.error("Keine zu überwachenden Module konfiguriert (target_modules).")
        return 2

    state = load_state(cfg.state_file)
    modules_state: dict[str, Any] = state.setdefault("modules", {})

    scanner = Scanner(cfg)
    try:
        start_page = scanner.login()
        grades_page = scanner.open_grades_view(start_page)
    except (PortalError, requests.RequestException) as err:
        LOG.error("Fehler beim Prüfen der Noten: %s", err)
        return 1

    tables = parse_grades_table(grades_page.body)
    now = datetime.now(timezone.utc).isoformat()
    state["last_check"] = now

    if not tables:
        LOG.error("Keine Notentabelle auf der Seite gefunden.")
        scanner.dump_debug("no-tables", grades_page.body)
        save_state(cfg.state_file, state)
        return 1

    for module in cfg.target_modules:
        result = find_target_grade(tables, module)
        entry = modules_state.setdefault(module, {})

        if result is None:
            LOG.warning('Modul "%s" wurde in der Notenübersicht nicht gefunden.', module)
            scanner.dump_debug("module-not-found", grades_page.body)
            entry["last_check"] = now
            continue

        if result.is_graded:
            LOG.info('Note für "%s" ist eingetragen: %s', module, result.grade)
        else:
            LOG.info('Note für "%s" ist noch nicht eingetragen.', module)

        was_graded_before = bool(entry.get("graded"))
        if result.is_graded and not was_graded_before:
            LOG.info("Neuer Notenstand erkannt -> löse Benachrichtigung aus.")
            notify(f"Note für {module} wurde eingetragen: {result.grade}")

        entry["grade"] = result.grade or ""
        entry["graded"] = result.is_graded
        entry["row"] = result.row_text
        entry["last_check"] = now

    save_state(cfg.state_file, state)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HSMW Noten-Scanner (Python)")
    parser.add_argument(
        "-c",
        "--config",
        type=Path,
        default=None,
        help="Pfad zur TOML-Konfiguration (Standard: config.toml neben diesem Script, falls vorhanden)",
    )
    parser.add_argument(
        "-m",
        "--module",
        action="append",
        dest="modules",
        help="Zu überwachendes Modul (mehrfach angebbar, überschreibt die Konfiguration)",
    )
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Dauerhaft laufen und im konfigurierten Intervall prüfen (statt einmalig)",
    )
    parser.add_argument(
        "--interval-minutes",
        type=int,
        default=None,
        help="Intervall für --loop in Minuten (überschreibt die Konfiguration)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug-Logging aktivieren")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    config_path = args.config
    if config_path is None:
        default_config = Path(__file__).resolve().parent / "config.toml"
        config_path = default_config if default_config.is_file() else None

    cfg = load_config(config_path)
    if args.modules:
        cfg.target_modules = args.modules
    if args.interval_minutes is not None:
        cfg.interval_minutes = args.interval_minutes

    if not args.loop:
        return check_grades(cfg)

    interval_s = max(1, cfg.interval_minutes) * 60
    LOG.info("HSMW Noten-Scanner gestartet, prüfe alle %s Minuten.", cfg.interval_minutes)
    while True:
        check_grades(cfg)
        try:
            time.sleep(interval_s)
        except KeyboardInterrupt:
            LOG.info("Beende auf Benutzerwunsch.")
            return 0


if __name__ == "__main__":
    sys.exit(main())
