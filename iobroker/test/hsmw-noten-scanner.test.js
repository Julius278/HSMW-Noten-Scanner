// Tests für das ioBroker-Script hsmw-noten-scanner.js.
//
// Das Script ist für die ioBroker-Sandbox geschrieben und erwartet dort globale
// Funktionen (log, schedule, createStateAsync, setStateAsync, getStateAsync,
// sendTo). Für den Test werden diese Globals gestubbt und ein lokaler
// HTTP-Server gestartet, der den per HAR-Mitschnitt verifizierten Login-Ablauf
// nachbildet: Client-Storage-Zwischenseite -> SPNEGO-401-Sackgasse ->
// /error-Fallback -> Login-Formular -> Notenübersicht.
//
// Ausführen:  cd iobroker && npm install && npm test
//
// Das Script startet beim Laden von selbst (IIFE am Dateiende). Pro Szenario
// wird es daher mit gepatchter CONFIG neu ausgewertet, gekapselt in eine
// Funktion, die die gestubbten Globals als Parameter erhält.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'hsmw-noten-scanner.js');
const USERNAME = 'MeinBenutzer';
const PASSWORD = 'geheim';
const P = '0_userdata.0.hsmwNotenScanner.';

// ---------------------------------------------------------------------------
// Mock-Portal
// ---------------------------------------------------------------------------

const CLIENT_STORAGE_PAGE = `<html><head><title>Client Storage Service</title></head><body>
<form action="/sso?execution=e1s1" method="POST">
  <input type="hidden" name="shib_idp_ls_supported" value="true" />
  <input type="submit" name="_eventId_proceed" value="" />
</form>
<form action="https://www.hs-mittweida.de/suche/" name="Search" method="get">
  <input type="search" name="q" />
</form>
</body></html>`;

const LOGIN_PAGE = `<html><head><title>Anmelden</title></head><body>
<form action="/login" method="post">
  <input type="hidden" name="csrf_token" value="tok" />
  <input type="text" name="j_username" value="" />
  <input type="password" name="j_password" value="" />
  <button type="submit" name="_eventId_proceed">Anmelden</button>
</form></body></html>`;

const LANDING_PAGE = '<html><body><a href="/?view=full">Alle F&auml;cher anzeigen</a></body></html>';

// Vor der Notenliste steht einmalig die Rechtsbehelfsbelehrung, die per
// verstecktem Feld confirm_marks bestätigt werden muss.
const CONFIRM_PAGE = `<html><body>
<p>Rechtsbehelfsbelehrung</p>
<form method="post">
  <input type="hidden" name="confirm_marks" value="true" />
  <input type="submit" value="Kenntnis genommen" />
</form></body></html>`;

// Spaltenstruktur wie im echten HTML-Export, mit generischen Beispieldaten.
// "Kurs A" und "Kurs-A" werden beim Bereinigen zur gleichen State-ID ("Kurs_A")
// - damit deckt die Tabelle die Kollisionsbehandlung ab. Beide sind bewusst so
// benannt, dass keiner ein Teilstring des anderen ist.
function gradesTablePage(secondGrade) {
    return `<html><body><table>
  <thead><tr>
    <th>PNr</th><th>Vert</th><th>S</th><th>Modul</th><th>Credits/Wichtung</th>
    <th>Art</th><th>Fach</th><th>Note</th><th>Versuch</th>
    <th>Status/Vermerk</th><th>PDatum</th><th>Meldung</th>
  </tr></thead>
  <tbody>
    <tr><td>1234</td><td>1</td><td>1</td><td>1234(M)</td><td>5.0</td>
        <td>PL</td><td>Beispielmodul 1</td><td>2,0</td><td>1</td>
        <td>BE</td><td>01.01.2026</td><td></td></tr>
    <tr><td>5678</td><td>1</td><td>2</td><td>5678(M)</td><td>5.0</td>
        <td>PL</td><td>Beispielmodul 2</td><td>${secondGrade}</td><td>1</td>
        <td>AN</td><td></td><td></td></tr>
    <tr><td>9012</td><td>1</td><td>3</td><td>9012(M)</td><td>5.0</td>
        <td>PL</td><td>Modul-1</td><td>3,0</td><td>1</td>
        <td>BE</td><td>01.01.2026</td><td></td></tr>
    <tr><td>3456</td><td>1</td><td>4</td><td>3456(M)</td><td>5.0</td>
        <td>PL</td><td>Kurs A</td><td>1,0</td><td>1</td>
        <td>BE</td><td>01.01.2026</td><td></td></tr>
    <tr><td>7890</td><td>1</td><td>5</td><td>7890(M)</td><td>5.0</td>
        <td>PL</td><td>Kurs-A</td><td>4,0</td><td>1</td>
        <td>BE</td><td>01.01.2026</td><td></td></tr>
  </tbody>
</table></body></html>`;
}

function startPortal() {
    const seen = {
        spnego: false,
        spnegoError: false,
        confirmed: false,
        clientStorageBody: null,
        loginBody: null,
    };
    let secondGrade = '';

    const server = http.createServer((req, res) => {
        const [urlPath, query] = req.url.split('?');
        const send = (body, status = 200) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(body);
        };
        const redirect = (location) => {
            res.statusCode = 302;
            res.setHeader('Location', location);
            res.end();
        };

        if (urlPath === '/noten') return send(CLIENT_STORAGE_PAGE);

        if (urlPath === '/sso' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                seen.clientStorageBody = body;
                redirect('/idp/profile/Authn/SPNEGO/e1s2?conversation=e1s2');
            });
            return;
        }

        // Ohne Kerberos-Ticket endet der SPNEGO-Versuch immer mit 401.
        if (urlPath === '/idp/profile/Authn/SPNEGO/e1s2') {
            seen.spnego = true;
            return send('<html><body>Negotiate authentication failed</body></html>', 401);
        }
        if (urlPath === '/idp/profile/Authn/SPNEGO/e1s2/error') {
            seen.spnegoError = true;
            return redirect('/final');
        }
        if (urlPath === '/final') return send(LOGIN_PAGE);

        if (urlPath === '/login' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                seen.loginBody = body;
                const ok =
                    body.includes(`j_username=${USERNAME}`) &&
                    body.includes(`j_password=${PASSWORD}`) &&
                    body.includes('csrf_token=tok');
                send(ok ? LANDING_PAGE : LOGIN_PAGE);
            });
            return;
        }

        if (urlPath === '/' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                if (body.includes('confirm_marks=true')) {
                    seen.confirmed = true;
                    return send(gradesTablePage(secondGrade));
                }
                send(CONFIRM_PAGE);
            });
            return;
        }

        if (urlPath === '/' && query === 'view=full') {
            return send(seen.confirmed ? gradesTablePage(secondGrade) : CONFIRM_PAGE);
        }
        if (urlPath === '/') return send(LANDING_PAGE);
        return send('<html><body>not found</body></html>', 404);
    });

    return {
        server,
        seen,
        setSecondGrade: (value) => {
            secondGrade = value;
        },
        listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
        close: () => new Promise((resolve) => server.close(resolve)),
        get port() {
            return server.address().port;
        },
    };
}

// ---------------------------------------------------------------------------
// Script mit gestubbten ioBroker-Globals laufen lassen
// ---------------------------------------------------------------------------

function patchScript(source, port, configLine) {
    const src = source
        .replace("url: 'https://qispos.hs-mittweida.de/noten?intranet&m'", `url: 'http://127.0.0.1:${port}/noten'`)
        .replace("username: 'dein_benutzername'", `username: '${USERNAME}'`)
        .replace("password: 'dein_kennwort'", `password: '${PASSWORD}'`)
        .replace("targetModules: ['dein_modulname'],", configLine);

    // Verhindert stille Fehlschläge, falls sich die betroffenen Zeilen im
    // Script ändern und ein replace() nicht mehr greift.
    for (const needed of [`127.0.0.1:${port}`, USERNAME, configLine]) {
        assert.ok(src.includes(needed), `Patch griff nicht: ${needed}`);
    }
    return src;
}

// Lädt das Script mit gepatchter CONFIG und wartet, bis `until` erfüllt ist
// (oder das Timeout greift). Das Warten auf eine Bedingung statt auf eine feste
// Zeitspanne hält den Test auch auf langsamen CI-Runnern stabil.
//
// Das Script wird dazu in eine Funktion gekapselt, die die ioBroker-Globals als
// Parameter bekommt. Wichtig: nur so hat jeder Lauf seine eigenen Stubs. Würde
// man global.log & Co. setzen, könnte ein noch laufender Durchlauf aus einem
// früheren Szenario in die Aufzeichnungen des nächsten schreiben - das Script
// startet beim Laden von selbst und wird hier nicht bis zum Ende abgewartet.
async function runScanner({ port, configLine, state = {}, until, timeoutMs = 10000, transform }) {
    const notifications = [];
    const logs = [];
    const progress = { finished: false };
    // States, die beschrieben wurden, ohne vorher angelegt worden zu sein.
    // ioBroker warnt in diesem Fall ("State does not exist"), der Stub hier
    // sammelt sie, damit ein fehlendes createState im Script auffällt.
    const undeclaredWrites = [];

    const sandbox = {
        log: (message, level) => logs.push({ level: level || 'info', message: String(message) }),
        schedule: () => {},
        createStateAsync: async (id, initial) => {
            if (!(id in state)) state[id] = { val: initial };
        },
        getStateAsync: async (id) => state[id] || null,
        setStateAsync: async (id, val) => {
            if (!(id in state) && !undeclaredWrites.includes(id)) undeclaredWrites.push(id);
            state[id] = { val };
            // Der globale lastCheck wird als letzter Schritt eines Durchlaufs
            // geschrieben - das ist damit das Ende-Signal dieses Laufs.
            if (id === P + 'lastCheck' && val) progress.finished = true;
        },
        sendTo: (instance, command, message) => notifications.push({ instance, command, ...message }),
    };

    let source = patchScript(fs.readFileSync(SCRIPT_PATH, 'utf-8'), port, configLine);
    if (transform) source = transform(source);

    const names = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, 'require', source);
    factory(...names.map((n) => sandbox[n]), require);

    const result = { state, notifications, logs, progress, undeclaredWrites };

    // Standardmäßig wird abgewartet, bis dieser Lauf selbst fertig ist. Das ist
    // wichtig, wenn mehrere Läufe hintereinander denselben state teilen: würde
    // der nächste Lauf starten, während dieser noch Requests offen hat, würden
    // beide in dieselben States schreiben und das Ergebnis wäre zufällig.
    const done = until || ((r) => r.progress.finished);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !done(result)) {
        await new Promise((r) => setTimeout(r, 20));
    }

    // Gilt für jedes Szenario: das Script darf keinen State beschreiben, den es
    // nicht in ensureStates() angelegt hat.
    assert.deepStrictEqual(undeclaredWrites, [], 'States wurden ohne createState beschrieben');
    return result;
}

const errors = (result) => result.logs.filter((l) => l.level === 'error');
const warnings = (result) => result.logs.filter((l) => l.level === 'warn');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('mehrere Module in einem Durchlauf', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1', 'Beispielmodul 2', 'Modul-1'],"
    });

    assert.deepStrictEqual(errors(result), [], 'keine Fehler erwartet');

    // Login-Kette inkl. SPNEGO-Umleitung wurde durchlaufen.
    assert.ok(portal.seen.spnego, 'SPNEGO-Versuch wurde nicht durchlaufen');
    assert.ok(portal.seen.spnegoError, '/error-Fallback wurde nicht aufgerufen');
    assert.match(portal.seen.loginBody, /j_username=MeinBenutzer/);
    // Von der Client-Storage-Seite darf nur das POST-Formular gesendet werden,
    // nicht das Suchformular im Seitenkopf.
    assert.match(portal.seen.clientStorageBody, /shib_idp_ls_supported/);
    assert.doesNotMatch(portal.seen.clientStorageBody, /(^|&)q=/);
    assert.ok(portal.seen.confirmed, 'Rechtsbehelfsbelehrung wurde nicht bestätigt');

    // Benotetes Modul.
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.grade'].val, '2,0');
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.graded'].val, true);
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.name'].val, 'Beispielmodul 1');

    // Offenes Modul: leere Note-Zelle.
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_2.grade'].val, '');
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_2.graded'].val, false);

    // Sonderzeichen im Namen ergeben eine eigene, bereinigte State-ID.
    assert.strictEqual(result.state[P + 'modules.Modul_1.grade'].val, '3,0');
    assert.strictEqual(result.state[P + 'modules.Modul_1.name'].val, 'Modul-1');

    // Genau die beiden benoteten Module lösen eine Meldung aus.
    assert.strictEqual(result.notifications.length, 2);
    const texts = result.notifications.map((n) => n.message).join('\n');
    assert.match(texts, /Beispielmodul 1 wurde eingetragen: 2,0/);
    assert.match(texts, /Modul-1 wurde eingetragen: 3,0/);
    assert.doesNotMatch(texts, /Beispielmodul 2/);
});

test('Benachrichtigung nur beim Übergang zu "eingetragen"', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const configLine = "targetModules: ['Beispielmodul 1', 'Beispielmodul 2'],";
    const state = {};

    const first = await runScanner({ port: portal.port, configLine, state });
    assert.strictEqual(first.notifications.length, 1, 'erster Lauf: nur das benotete Modul');

    // Zweiter Lauf mit unverändertem Stand -> keine erneute Meldung.
    const second = await runScanner({ port: portal.port, configLine, state });
    assert.strictEqual(second.notifications.length, 0, 'zweiter Lauf darf nicht erneut melden');

    // Jetzt erscheint die Note für das zweite Modul -> genau eine Meldung.
    portal.setSecondGrade('1,3');
    const third = await runScanner({ port: portal.port, configLine, state });
    assert.strictEqual(third.notifications.length, 1);
    assert.match(third.notifications[0].message, /Beispielmodul 2 wurde eingetragen: 1,3/);
    assert.strictEqual(state[P + 'modules.Beispielmodul_2.grade'].val, '1,3');
    assert.strictEqual(state[P + 'modules.Beispielmodul_2.graded'].val, true);
});

test('Platzhalter in der Note-Spalte gelten als "nicht eingetragen"', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    // Normalerweise ist die Note-Zelle leer, solange nichts eingetragen ist.
    // Manche Modulformen zeigen stattdessen einen Platzhalter - der darf keine
    // Benachrichtigung auslösen.
    portal.setSecondGrade('-');
    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 2'],",
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_2.grade'].val, '-');
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_2.graded'].val, false);
    assert.strictEqual(result.notifications.length, 0);
});

test('targetModules akzeptiert auch einen einzelnen String', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: 'Beispielmodul 1',",
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.grade'].val, '2,0');
    assert.strictEqual(result.notifications.length, 1);
});

test('alte Konfiguration mit targetModule läuft weiter', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    // Konfigurationen aus früheren Script-Versionen hatten nur dieses Feld -
    // ein Update darf sie nicht still stillegen.
    const result = await runScanner({
        port: portal.port,
        configLine: "targetModule: 'Beispielmodul 1',",
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.grade'].val, '2,0');
    assert.strictEqual(result.notifications.length, 1);
});

test('alte Einzel-States spiegeln das erste Modul', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1', 'Beispielmodul 2'],",
    });

    assert.strictEqual(result.state[P + 'lastGrade'].val, '2,0');
    assert.strictEqual(result.state[P + 'lastGraded'].val, true);
    assert.ok(result.state[P + 'lastCheck'].val, 'globaler lastCheck fehlt');
});

test('Modulnamen mit gleicher bereinigter State-ID bleiben getrennt', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    // "Kurs A" und "Kurs-A" ergeben beide "Kurs_A" - der zweite muss eine
    // eigene ID bekommen, sonst würden sich die States gegenseitig überschreiben.
    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Kurs A', 'Kurs-A'],",
    });

    assert.deepStrictEqual(errors(result), []);

    const ids = Object.keys(result.state)
        .filter((id) => id.endsWith('.name'))
        .map((id) => [id, result.state[id].val]);
    assert.strictEqual(ids.length, 2, `zwei getrennte Zweige erwartet, gefunden: ${JSON.stringify(ids)}`);

    const byName = new Map(ids.map(([id, name]) => [name, id.replace(/\.name$/, '')]));
    assert.notStrictEqual(byName.get('Kurs A'), byName.get('Kurs-A'), 'State-IDs müssen sich unterscheiden');
    assert.strictEqual(result.state[byName.get('Kurs A') + '.grade'].val, '1,0');
    assert.strictEqual(result.state[byName.get('Kurs-A') + '.grade'].val, '4,0');
    assert.strictEqual(result.notifications.length, 2);
});

test('doppelte Einträge werden entfernt', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1', 'beispielmodul 1', '  Beispielmodul 1  '],",
    });

    assert.strictEqual(result.notifications.length, 1, 'Modul darf nur einmal gemeldet werden');
});

test('unbekanntes Modul warnt, ohne den Lauf abzubrechen', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Gibt Es Nicht', 'Beispielmodul 1'],",
    });

    assert.ok(
        warnings(result).some((l) => l.message.includes('Gibt Es Nicht')),
        'Warnung für unbekanntes Modul fehlt',
    );
    // Das nachfolgende Modul wird trotzdem noch ausgewertet.
    assert.strictEqual(result.state[P + 'modules.Beispielmodul_1.grade'].val, '2,0');
    assert.strictEqual(result.notifications.length, 1);
    assert.deepStrictEqual(errors(result), []);
});

test('leere Modulliste wird als Fehler gemeldet', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: 'targetModules: [],',
        until: (r) => errors(r).length > 0,
        timeoutMs: 3000,
    });

    assert.strictEqual(errors(result).length, 1);
    assert.match(errors(result)[0].message, /targetModules/);
    assert.strictEqual(result.notifications.length, 0);
    assert.strictEqual(result.state[P + 'lastCheck'], undefined, 'es darf kein Lauf stattfinden');
});

test('falsche Zugangsdaten führen zu einer Fehlermeldung', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        transform: (src) => src.replace(`password: '${PASSWORD}'`, "password: 'FALSCH'"),
        until: (r) => errors(r).length > 0,
    });

    assert.strictEqual(errors(result).length, 1);
    assert.match(errors(result)[0].message, /Login fehlgeschlagen/);
    assert.strictEqual(result.notifications.length, 0, 'bei Login-Fehler darf nichts gemeldet werden');
    assert.strictEqual(
        result.state[P + 'modules.Beispielmodul_1.grade'].val,
        '',
        'ohne Login darf keine Note geschrieben werden',
    );
});
