#!/usr/bin/env python3
"""
HSMW Noten-Scanner
==================

Loggt sich in das QIS/POS-Notenportal der Hochschule Mittweida ein, öffnet die
Notenübersicht und prüft, ob für ein bestimmtes Modul bereits eine Note
eingetragen ist.

Da das Portal nur mit gültigen Zugangsdaten erreichbar ist, sind die
CSS-Selektoren für Login-Formular und den Knopf zur Notenübersicht bewusst
tolerant gehalten (mehrere Fallback-Strategien). Passe TARGET_MODULE,
GRADES_BUTTON_TEXT und ggf. die Selektoren in diesem Skript an, falls sich die
Portal-Struktur anders verhält als erwartet (siehe README.md).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import smtplib
import sys
from dataclasses import dataclass
from datetime import datetime
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DEBUG_DIR = BASE_DIR / "debug"
STATUS_FILE = DATA_DIR / "status.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(BASE_DIR / "scraper.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("hsmw-noten-scanner")


@dataclass
class Config:
    url: str
    username: str
    password: str
    target_module: str
    button_candidates: list[str]
    headless: bool
    smtp_host: str | None
    smtp_port: int
    smtp_user: str | None
    smtp_password: str | None
    smtp_from: str | None
    smtp_to: str | None

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv(BASE_DIR / ".env")

        def require(name: str) -> str:
            value = os.environ.get(name, "").strip()
            if not value:
                raise SystemExit(f"Fehlende Umgebungsvariable: {name} (siehe .env.example)")
            return value

        button_text = os.environ.get(
            "GRADES_BUTTON_TEXT",
            "Notenspiegel|Leistungsspiegel|Prüfungsergebnisse|Notenübersicht",
        )
        return cls(
            url=os.environ.get("QIS_URL", "https://qispos.hs-mittweida.de/noten?intranet&m"),
            username=require("QIS_USERNAME"),
            password=require("QIS_PASSWORD"),
            target_module=require("TARGET_MODULE"),
            button_candidates=[c.strip() for c in button_text.split("|") if c.strip()],
            headless=os.environ.get("HEADLESS", "true").strip().lower() not in ("0", "false", "no"),
            smtp_host=os.environ.get("SMTP_HOST") or None,
            smtp_port=int(os.environ.get("SMTP_PORT", "587") or "587"),
            smtp_user=os.environ.get("SMTP_USER") or None,
            smtp_password=os.environ.get("SMTP_PASSWORD") or None,
            smtp_from=os.environ.get("SMTP_FROM") or None,
            smtp_to=os.environ.get("SMTP_TO") or None,
        )


def dump_debug(page: Page, name: str) -> None:
    """Speichert Screenshot + HTML der aktuellen Seite zur Fehlersuche."""
    DEBUG_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        page.screenshot(path=str(DEBUG_DIR / f"{stamp}-{name}.png"), full_page=True)
        (DEBUG_DIR / f"{stamp}-{name}.html").write_text(page.content(), encoding="utf-8")
        log.info("Debug-Snapshot gespeichert: debug/%s-%s.(png|html)", stamp, name)
    except Exception:
        log.exception("Konnte Debug-Snapshot nicht speichern")


def login(page: Page, cfg: Config) -> None:
    log.info("Öffne %s", cfg.url)
    page.goto(cfg.url, wait_until="networkidle")

    # Falls bereits eingeloggt (z.B. bestehende Session), keine weiteren Schritte nötig.
    if not page.locator('input[type="password"]').first.is_visible(timeout=2000):
        log.info("Kein Login-Formular sichtbar, vermutlich bereits eingeloggt.")
        return

    log.info("Login-Formular gefunden, fülle Zugangsdaten aus.")

    password_field = page.locator('input[type="password"]').first

    # Übliche QIS/POS-Feldnamen zuerst versuchen, sonst generisch per Typ suchen.
    username_field = None
    for selector in (
        'input[name="asdf"]',
        'input[name="username"]',
        'input[name="user"]',
        'input[id*="user" i]',
        'input[type="text"]',
        'input[type="email"]',
    ):
        candidate = page.locator(selector).first
        if candidate.count() > 0 and candidate.is_visible():
            username_field = candidate
            break

    if username_field is None:
        dump_debug(page, "login-no-username-field")
        raise RuntimeError(
            "Konnte kein Benutzername-Feld auf der Login-Seite finden. "
            "Siehe debug/ für einen Snapshot der Seite und passe scraper.py an."
        )

    username_field.fill(cfg.username)
    password_field.fill(cfg.password)

    submit_button = page.locator('button[type="submit"], input[type="submit"]').first
    if submit_button.count() > 0:
        submit_button.click()
    else:
        password_field.press("Enter")

    page.wait_for_load_state("networkidle")

    if page.locator('input[type="password"]').first.is_visible(timeout=2000):
        dump_debug(page, "login-failed")
        raise RuntimeError(
            "Login fehlgeschlagen (Passwortfeld weiterhin sichtbar). "
            "Zugangsdaten prüfen oder debug/-Snapshot ansehen."
        )

    log.info("Login erfolgreich.")


def open_grades_view(page: Page, cfg: Config) -> None:
    for text in cfg.button_candidates:
        locator = page.get_by_role("link", name=text, exact=False)
        if locator.count() == 0:
            locator = page.get_by_role("button", name=text, exact=False)
        if locator.count() == 0:
            locator = page.locator(f'text="{text}"')
        if locator.count() > 0 and locator.first.is_visible():
            log.info('Klicke auf Knopf/Link "%s"', text)
            locator.first.click()
            page.wait_for_load_state("networkidle")
            return

    dump_debug(page, "grades-button-not-found")
    raise RuntimeError(
        f"Keiner der konfigurierten Knöpfe {cfg.button_candidates} wurde auf der Seite gefunden. "
        "Passe GRADES_BUTTON_TEXT in der .env an (siehe debug/ für einen Snapshot)."
    )


def parse_grades_table(page: Page) -> list[dict[str, str]]:
    """Liest alle Tabellenzeilen der Notenübersicht aus.

    Erwartet eine oder mehrere HTML-Tabellen mit Zeilen, deren erste Spalte(n)
    den Modul-/Prüfungsnamen enthalten und eine spätere Spalte die Note. Da der
    exakte Aufbau je nach QIS-Konfiguration variiert, wird pro Zeile einfach
    der komplette Text sowie die einzelnen Zellen gespeichert.
    """
    rows_out: list[dict[str, str]] = []
    tables = page.locator("table")
    table_count = tables.count()
    if table_count == 0:
        dump_debug(page, "no-tables-found")

    for t in range(table_count):
        table = tables.nth(t)
        rows = table.locator("tr")
        for r in range(rows.count()):
            row = rows.nth(r)
            cells = row.locator("td")
            cell_count = cells.count()
            if cell_count == 0:
                continue
            cell_texts = [cells.nth(c).inner_text().strip() for c in range(cell_count)]
            if not any(cell_texts):
                continue
            rows_out.append(
                {
                    "row_text": " | ".join(cell_texts),
                    "cells": cell_texts,
                }
            )
    return rows_out


def find_target_grade(rows: list[dict[str, str]], target_module: str) -> dict | None:
    target_lower = target_module.lower()
    for row in rows:
        cells = row["cells"]
        if any(target_lower in cell.lower() for cell in cells):
            # Note ist meist die letzte nicht-leere Zelle oder eine Spalte mit
            # kurzem numerischem/alphanumerischem Inhalt (z.B. "2,3", "1.0", "b").
            grade_value = None
            for cell in reversed(cells):
                cell_clean = cell.strip()
                if cell_clean and cell_clean.lower() not in (target_lower,) and len(cell_clean) <= 6:
                    grade_value = cell_clean
                    break
            return {"row": row["row_text"], "grade": grade_value}
    return None


def load_previous_status() -> dict:
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_status(status: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    STATUS_FILE.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")


def send_email_notification(cfg: Config, subject: str, body: str) -> None:
    if not (cfg.smtp_host and cfg.smtp_user and cfg.smtp_password and cfg.smtp_from and cfg.smtp_to):
        log.info("SMTP nicht vollständig konfiguriert, überspringe E-Mail-Benachrichtigung.")
        return
    msg = MIMEText(body, _charset="utf-8")
    msg["Subject"] = subject
    msg["From"] = cfg.smtp_from
    msg["To"] = cfg.smtp_to
    try:
        with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port) as server:
            server.starttls()
            server.login(cfg.smtp_user, cfg.smtp_password)
            server.sendmail(cfg.smtp_from, [cfg.smtp_to], msg.as_string())
        log.info("Benachrichtigungs-E-Mail an %s gesendet.", cfg.smtp_to)
    except Exception:
        log.exception("Versand der Benachrichtigungs-E-Mail fehlgeschlagen.")


def run(cfg: Config) -> int:
    previous = load_previous_status()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=cfg.headless)
        page = browser.new_page()
        try:
            login(page, cfg)
            open_grades_view(page, cfg)
            rows = parse_grades_table(page)
            result = find_target_grade(rows, cfg.target_module)
        finally:
            browser.close()

    now = datetime.now().isoformat(timespec="seconds")

    if result is None:
        log.warning('Modul "%s" wurde in der Notenübersicht nicht gefunden.', cfg.target_module)
        save_status({"module": cfg.target_module, "found": False, "checked_at": now})
        return 1

    grade = result["grade"]
    is_graded = bool(grade) and grade not in ("-", "--", "n.b.", "offen")

    if is_graded:
        log.info('Note für "%s" ist eingetragen: %s', cfg.target_module, grade)
    else:
        log.info('Note für "%s" ist noch NICHT eingetragen.', cfg.target_module)

    status = {
        "module": cfg.target_module,
        "found": True,
        "graded": is_graded,
        "grade": grade,
        "row_text": result["row"],
        "checked_at": now,
    }

    was_graded_before = bool(previous.get("graded"))
    if is_graded and not was_graded_before:
        subject = f"Neue Note eingetragen: {cfg.target_module}"
        body = f"Die Note für '{cfg.target_module}' wurde eingetragen: {grade}\n\n{result['row']}"
        log.info("Neuer Notenstand erkannt -> sende Benachrichtigung.")
        send_email_notification(cfg, subject, body)

    save_status(status)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="HSMW QIS/POS Noten-Scanner")
    parser.add_argument("--target-module", help="Überschreibt TARGET_MODULE aus der .env für diesen Lauf")
    parser.add_argument("--headed", action="store_true", help="Browser sichtbar starten (überschreibt HEADLESS)")
    args = parser.parse_args()

    cfg = Config.from_env()
    if args.target_module:
        cfg.target_module = args.target_module
    if args.headed:
        cfg.headless = False

    try:
        return run(cfg)
    except PlaywrightTimeoutError as exc:
        log.error("Timeout während der Browser-Interaktion: %s", exc)
        return 2
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
