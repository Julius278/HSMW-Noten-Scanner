#!/usr/bin/env python3
"""Tests für den HSMW Noten-Scanner (Python-Variante).

Startet einen lokalen HTTP-Server, der den echten Login-Ablauf nachbildet
(Client-Storage-Zwischenseite -> SPNEGO-401-Sackgasse -> Login-Formular ->
SAML-Relay -> Notenübersicht mit Rechtsbehelfsbelehrung), und prüft den
kompletten Durchlauf sowie die Tabellen-Auswertung.

Ausführen:  python3 -m unittest discover -s python
"""

from __future__ import annotations

import logging
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlparse

import hsmw_noten_scanner as scanner
from hsmw_noten_scanner import Config, check_grades, find_target_grade, parse_grades_table

USERNAME = "MeinBenutzer"
PASSWORD = "geheim"

CLIENT_STORAGE_PAGE = """<html><head><title>Client Storage Service</title></head><body>
<form action="/idp/profile/SAML2/Redirect/SSO?execution=e1s1" method="POST">
  <input type="hidden" name="csrf_token" value="_tok1" />
  <input type="hidden" name="shib_idp_ls_supported" value="true" />
  <input type="submit" name="_eventId_proceed" value="" />
</form>
<form action="https://www.hs-mittweida.de/suche/" name="Search" method="get">
  <input type="search" name="q" />
</form>
</body></html>"""

LOGIN_PAGE = """<html><head><title>Anmelden</title></head><body>
<form action="/idp/profile/SAML2/Redirect/SSO?execution=e1s3" method="post">
  <input type="hidden" name="csrf_token" value="_tok3" />
  <input type="text" name="j_username" value="" />
  <input type="password" name="j_password" value="" />
  <button type="submit" name="_eventId_proceed">Anmelden</button>
</form>
</body></html>"""

SAML_RELAY_PAGE = """<html><body onload="document.forms[0].submit()">
<form action="/Shibboleth.sso/SAML2/POST" method="post">
  <input type="hidden" name="RelayState" value="ss:mem:abc" />
  <input type="hidden" name="SAMLResponse" value="PHNhbWw+" />
  <input type="submit" value="Continue" />
</form>
</body></html>"""

GRADES_LANDING_PAGE = """<html><body>
<p>Notenanzeige</p>
<a href="/?view=full">Alle F&auml;cher anzeigen</a>
</body></html>"""

CONFIRM_PAGE = """<html><body>
<p>Rechtsbehelfsbelehrung</p>
<form method="post">
  <input type="hidden" name="confirm_marks" value="true" />
  <input type="submit" value="Kenntnis genommen" />
</form>
</body></html>"""

# Spaltenstruktur wie im echten HTML-Export: Blockchain 1 ist benotet,
# Blockchain 4 ist angemeldet ("AN") mit leerer Note-Zelle.
GRADES_TABLE_PAGE = """<html><body>
<table>
  <thead>
    <tr>
      <th>PNr</th><th>Vert</th><th>S</th><th>Modul</th><th>Credits/Wichtung</th>
      <th>Art</th><th>Fach</th><th>Note</th><th>Versuch</th>
      <th>Status/Vermerk</th><th>PDatum</th><th>Meldung</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>8101</td><td>1</td><td>5</td><td>8101(M)</td><td>5.0</td>
      <td>PL</td><td>Blockchain 1</td><td>1,7</td><td>1</td>
      <td>BE</td><td>12.02.2026</td><td></td>
    </tr>
    <tr>
      <td>8104</td><td>1</td><td>6</td><td>8104(M)</td><td>5.0</td>
      <td>PL</td><td>Blockchain 4</td><td></td><td>1</td>
      <td>AN</td><td></td><td></td>
    </tr>
  </tbody>
</table>
</body></html>"""


class PortalHandler(BaseHTTPRequestHandler):
    """Bildet den in der HAR-Aufzeichnung beobachteten Ablauf nach."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # Test-Ausgabe ruhig halten
        pass

    # -- Hilfen ---------------------------------------------------------

    def _send(self, body: str, status: int = 200) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> dict[str, list[str]]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        return parse_qs(raw)

    # -- Routen ---------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path, query = parsed.path, parsed.query
        state = self.server.portal_state

        if path == "/noten":
            self._send(CLIENT_STORAGE_PAGE)
        elif path == "/idp/profile/Authn/SPNEGO/e1s2":
            # Ohne Kerberos-Ticket endet der Versuch immer mit 401.
            state["spnego_seen"] = True
            self._send("<html><body>Negotiate authentication failed</body></html>", status=401)
        elif path == "/idp/profile/Authn/SPNEGO/e1s2/error":
            state["spnego_error_seen"] = True
            self._redirect("/idp/profile/SAML2/Redirect/SSO?execution=e1s3")
        elif path == "/idp/profile/SAML2/Redirect/SSO" and "execution=e1s3" in query:
            self._send(LOGIN_PAGE)
        elif path == "/":
            if query == "view=full":
                if state["confirmed"]:
                    self._send(GRADES_TABLE_PAGE)
                else:
                    self._send(CONFIRM_PAGE)
            else:
                self._send(GRADES_LANDING_PAGE)
        else:
            self._send("<html><body>not found</body></html>", status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path, query = parsed.path, parsed.query
        fields = self._read_body()
        state = self.server.portal_state

        if path == "/idp/profile/SAML2/Redirect/SSO" and "execution=e1s1" in query:
            state["client_storage_fields"] = fields
            self._redirect("/idp/profile/Authn/SPNEGO/e1s2?conversation=e1s2")
        elif path == "/idp/profile/SAML2/Redirect/SSO" and "execution=e1s3" in query:
            state["login_fields"] = fields
            good = (
                fields.get("j_username") == [USERNAME]
                and fields.get("j_password") == [PASSWORD]
                and fields.get("csrf_token") == ["_tok3"]
            )
            self._send(SAML_RELAY_PAGE if good else LOGIN_PAGE)
        elif path == "/Shibboleth.sso/SAML2/POST":
            state["saml_fields"] = fields
            self._redirect("/")
        elif path == "/":
            if fields.get("confirm_marks") == ["true"]:
                state["confirmed"] = True
                self._send(GRADES_TABLE_PAGE)
            else:
                self._send(CONFIRM_PAGE)
        else:
            self._send("<html><body>not found</body></html>", status=404)


class ParsingTests(unittest.TestCase):
    def test_parses_columns_by_header(self):
        tables = parse_grades_table(GRADES_TABLE_PAGE)
        self.assertEqual(len(tables), 1)
        self.assertIn("Note", tables[0].headers)
        self.assertEqual(len(tables[0].rows), 2)

    def test_graded_module(self):
        result = find_target_grade(parse_grades_table(GRADES_TABLE_PAGE), "Blockchain 1")
        self.assertIsNotNone(result)
        self.assertEqual(result.grade, "1,7")
        self.assertTrue(result.is_graded)

    def test_ungraded_module_has_empty_note_cell(self):
        result = find_target_grade(parse_grades_table(GRADES_TABLE_PAGE), "Blockchain 4")
        self.assertIsNotNone(result)
        self.assertIsNone(result.grade)
        self.assertFalse(result.is_graded)

    def test_module_search_is_case_insensitive(self):
        result = find_target_grade(parse_grades_table(GRADES_TABLE_PAGE), "blockchain 1")
        self.assertIsNotNone(result)
        self.assertEqual(result.grade, "1,7")

    def test_unknown_module(self):
        self.assertIsNone(find_target_grade(parse_grades_table(GRADES_TABLE_PAGE), "Analysis 1"))

    def test_placeholder_counts_as_ungraded(self):
        html = GRADES_TABLE_PAGE.replace("<td>1,7</td>", "<td>-</td>")
        result = find_target_grade(parse_grades_table(html), "Blockchain 1")
        self.assertEqual(result.grade, "-")
        self.assertFalse(result.is_graded)


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), PortalHandler)
        self.server.portal_state = {
            "spnego_seen": False,
            "spnego_error_seen": False,
            "confirmed": False,
        }
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

        self.tmpdir = TemporaryDirectory()
        self.state_file = Path(self.tmpdir.name) / "state.json"

        self.notifications: list[str] = []
        self._real_notify = scanner.notify
        scanner.notify = self.notifications.append

        logging.disable(logging.CRITICAL)

    def tearDown(self):
        logging.disable(logging.NOTSET)
        scanner.notify = self._real_notify
        self.server.shutdown()
        self.server.server_close()
        self.tmpdir.cleanup()

    def _config(self, modules: list[str]) -> Config:
        return Config(
            username=USERNAME,
            password=PASSWORD,
            url=f"{self.base_url}/noten",
            target_modules=modules,
            state_file=self.state_file,
        )

    def test_full_flow_bypasses_spnego_and_reads_grade(self):
        cfg = self._config(["Blockchain 1"])
        self.assertEqual(check_grades(cfg), 0)

        state = self.server.portal_state
        self.assertTrue(state["spnego_seen"], "SPNEGO-Versuch wurde nicht durchlaufen")
        self.assertTrue(state["spnego_error_seen"], "SPNEGO-/error-Fallback wurde nicht aufgerufen")
        self.assertEqual(state["login_fields"]["j_username"], [USERNAME])
        self.assertIn("SAMLResponse", state["saml_fields"])
        self.assertTrue(state["confirmed"], "Rechtsbehelfsbelehrung wurde nicht bestätigt")

        # Client-Storage-Zwischenseite: nur das POST-Formular, nicht die Suche.
        self.assertIn("shib_idp_ls_supported", state["client_storage_fields"])
        self.assertNotIn("q", state["client_storage_fields"])

    def test_notification_only_on_transition_to_graded(self):
        cfg = self._config(["Blockchain 1"])

        self.assertEqual(check_grades(cfg), 0)
        self.assertEqual(len(self.notifications), 1)
        self.assertIn("1,7", self.notifications[0])

        # Zweiter Lauf: Note unverändert -> keine erneute Benachrichtigung.
        self.assertEqual(check_grades(cfg), 0)
        self.assertEqual(len(self.notifications), 1)

    def test_no_notification_while_ungraded(self):
        cfg = self._config(["Blockchain 4"])
        self.assertEqual(check_grades(cfg), 0)
        self.assertEqual(self.notifications, [])

        saved = scanner.load_state(self.state_file)
        self.assertFalse(saved["modules"]["Blockchain 4"]["graded"])

    def test_multiple_modules_in_one_run(self):
        cfg = self._config(["Blockchain 1", "Blockchain 4"])
        self.assertEqual(check_grades(cfg), 0)

        saved = scanner.load_state(self.state_file)
        self.assertEqual(saved["modules"]["Blockchain 1"]["grade"], "1,7")
        self.assertEqual(saved["modules"]["Blockchain 4"]["grade"], "")
        self.assertEqual(len(self.notifications), 1)

    def test_wrong_credentials_fail(self):
        cfg = self._config(["Blockchain 1"])
        cfg.password = "falsch"
        self.assertEqual(check_grades(cfg), 1)
        self.assertEqual(self.notifications, [])

    def test_missing_credentials_are_reported(self):
        cfg = self._config(["Blockchain 1"])
        cfg.username = ""
        self.assertEqual(check_grades(cfg), 2)

    def test_unknown_module_does_not_fail_run(self):
        cfg = self._config(["Analysis 1"])
        self.assertEqual(check_grades(cfg), 0)
        self.assertEqual(self.notifications, [])


if __name__ == "__main__":
    unittest.main()
