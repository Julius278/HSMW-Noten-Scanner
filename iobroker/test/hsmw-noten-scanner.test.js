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

// Vor der Notentabelle steht ein Dropdown zur Auswahl der Seminargruppe.
// Vorausgewählt ist die aktuelle Gruppe (hier "gr-2").
const SEMINAR_GROUPS = [
    { value: 'gr-1', label: 'BSP21w1' },
    { value: 'gr-2', label: 'BSP22w1' },
    { value: 'gr-3', label: 'BSP23w1' },
];
const DEFAULT_GROUP = 'gr-2';

// Die Note von "Beispielmodul 1" hängt von der Gruppe ab. Damit prüfen die
// Tests nicht bloß, dass ein Parameter gesendet wurde, sondern dass die Noten
// wirklich für die gewählte Gruppe ausgelesen werden.
const GRADE_BY_GROUP = { 'gr-1': '3,0', 'gr-2': '2,0', 'gr-3': '1,0' };

// Das Feld heißt im Portal "stgSelect"; die Gruppennamen hier sind frei
// erfunden (BSP = Beispiel).
function groupSelect(selected) {
    const options = SEMINAR_GROUPS.map(
        (g) => `<option value="${g.value}"${g.value === selected ? ' selected' : ''}>${g.label}</option>`,
    ).join('');
    return `<select name="stgSelect" id="stgSelect">${options}</select>`;
}

// Ein Dropdown, das nicht die Seminargruppe ist, aber dieselben Optionstexte
// anbietet - damit lässt sich prüfen, dass das als Seminargruppe erkennbare Feld
// ("stgSelect") bevorzugt wird und nicht einfach das erste im Dokument.
function decoySelect() {
    const options = SEMINAR_GROUPS.map((g) => `<option value="decoy-${g.value}">${g.label}</option>`).join('');
    return `<select name="semesterSelect" id="semesterSelect">${options}</select>`;
}

// Drei Layouts, weil das echte HTML nicht bekannt ist:
//   "combined"  - Dropdown und confirm_marks stecken im selben Formular, ein
//                 Submit erledigt beides (der wahrscheinliche Fall: das
//                 Dropdown steht direkt vor dem Button, der die Tabelle
//                 anzeigt),
//   "separate"  - Dropdown hat sein eigenes Formular, die Bestätigung ein
//                 zweites,
//   "forgetful" - wie "separate", aber die Bestätigungsseite enthält das
//                 Dropdown ebenfalls und rendert es immer mit der aktuellen
//                 Gruppe vorausgewählt, merkt sich die Auswahl also nicht.
//                 Deckt ab, dass die gewählte Gruppe beim Bestätigen erneut
//                 mitgeschickt wird und nicht verloren geht.
function confirmPage(selected, layout, decoy = false) {
    const lead = `<p>Rechtsbehelfsbelehrung</p>${decoy ? decoySelect() : ''}`;
    if (layout === 'separate' || layout === 'forgetful') {
        const confirmSelect = layout === 'forgetful' ? groupSelect(selected) : '';
        return `<html><body>
${lead}
<form method="post" action="/?view=full">
  ${groupSelect(selected)}
  <input type="submit" value="Anzeigen" />
</form>
<form method="post">
  ${confirmSelect}
  <input type="hidden" name="confirm_marks" value="true" />
  <input type="submit" value="Kenntnis genommen" />
</form></body></html>`;
    }
    return `<html><body>
${lead}
<form method="post">
  ${groupSelect(selected)}
  <input type="hidden" name="confirm_marks" value="true" />
  <input type="submit" value="Noten anzeigen" />
</form></body></html>`;
}

// Spaltenstruktur wie im echten HTML-Export, mit generischen Beispieldaten.
// "Kurs A" und "Kurs-A" werden beim Bereinigen zur gleichen State-ID ("Kurs_A")
// - damit deckt die Tabelle die Kollisionsbehandlung ab. Beide sind bewusst so
// benannt, dass keiner ein Teilstring des anderen ist.
function gradesTablePage(secondGrade, gradeGroup, selectGroup = gradeGroup) {
    // Das Dropdown bleibt neben der Tabelle stehen, sonst wäre nach der
    // einmaligen Bestätigung kein Wechsel der Gruppe mehr möglich.
    return `<html><body>
<form method="post" action="/?view=full">
  ${groupSelect(selectGroup)}
  <input type="submit" value="Anzeigen" />
</form>
<table>
  <thead><tr>
    <th>PNr</th><th>Vert</th><th>S</th><th>Modul</th><th>Credits/Wichtung</th>
    <th>Art</th><th>Fach</th><th>Note</th><th>Versuch</th>
    <th>Status/Vermerk</th><th>PDatum</th><th>Meldung</th>
  </tr></thead>
  <tbody>
    <tr><td>1234</td><td>1</td><td>1</td><td>1234(M)</td><td>5.0</td>
        <td>PL</td><td>Beispielmodul 1</td><td>${GRADE_BY_GROUP[gradeGroup]}</td><td>1</td>
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

function startPortal({ layout = 'combined', decoy = false } = {}) {
    const seen = {
        spnego: false,
        spnegoError: false,
        confirmed: false,
        clientStorageBody: null,
        loginBody: null,
        // Welche Gruppen im Laufe des Tests abgeschickt wurden.
        submittedGroups: [],
    };
    let secondGrade = '';
    let currentGroup = DEFAULT_GROUP;
    // Bei Layout "forgetful" merkt sich das Portal die Gruppe nicht: es zählt
    // nur, was der jeweilige Request mitschickt.
    const forgetful = layout === 'forgetful';
    let requestGroup = DEFAULT_GROUP;

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
                const group = new URLSearchParams(body).get('stgSelect');
                if (group !== null) {
                    seen.submittedGroups.push(group);
                    // Unbekannte Gruppe würde das Portal nicht akzeptieren.
                    if (SEMINAR_GROUPS.some((g) => g.value === group)) {
                        if (forgetful) requestGroup = group;
                        else currentGroup = group;
                    }
                }
                if (body.includes('confirm_marks=true')) seen.confirmed = true;
                const selectGroup = forgetful ? DEFAULT_GROUP : currentGroup;
                const gradeGroup = forgetful ? requestGroup : currentGroup;
                send(
                    seen.confirmed
                        ? gradesTablePage(secondGrade, gradeGroup, selectGroup)
                        : confirmPage(selectGroup, layout, decoy),
                );
            });
            return;
        }

        if (urlPath === '/' && query === 'view=full') {
            return send(
                seen.confirmed
                    ? gradesTablePage(secondGrade, forgetful ? requestGroup : currentGroup, forgetful ? DEFAULT_GROUP : currentGroup)
                    : confirmPage(forgetful ? DEFAULT_GROUP : currentGroup, layout, decoy),
            );
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
        get currentGroup() {
            return currentGroup;
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

function patchScript(source, port, configLine, seminarGroup) {
    let src = source
        .replace("url: 'https://qispos.hs-mittweida.de/noten?intranet&m'", `url: 'http://127.0.0.1:${port}/noten'`)
        .replace("username: 'dein_benutzername'", `username: '${USERNAME}'`)
        .replace("password: 'dein_kennwort'", `password: '${PASSWORD}'`)
        .replace("targetModules: ['dein_modulname'],", configLine);

    const needed = [`127.0.0.1:${port}`, USERNAME, configLine];

    // Muss über die eigene Zeile laufen: seminarGroup steht in CONFIG hinter
    // targetModules, ein Anhängen an configLine würde von der originalen Zeile
    // wieder überschrieben.
    if (seminarGroup !== undefined) {
        const line = `seminarGroup: '${seminarGroup}',`;
        src = src.replace("seminarGroup: '',", line);
        needed.push(line);
    }

    // Verhindert stille Fehlschläge, falls sich die betroffenen Zeilen im
    // Script ändern und ein replace() nicht mehr greift.
    for (const value of needed) {
        assert.ok(src.includes(value), `Patch griff nicht: ${value}`);
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
async function runScanner({ port, configLine, seminarGroup, state = {}, until, timeoutMs = 10000, transform }) {
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

    let source = patchScript(fs.readFileSync(SCRIPT_PATH, 'utf-8'), port, configLine, seminarGroup);
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

// ---------------------------------------------------------------------------
// Seminargruppe
// ---------------------------------------------------------------------------

// Die Note von "Beispielmodul 1" unterscheidet sich je Gruppe (siehe
// GRADE_BY_GROUP). Die Tests prüfen darüber, dass wirklich die Noten der
// gewählten Gruppe gelesen werden - nicht nur, dass ein Parameter mitging.
const groupGradeOf = (result) => result.state[P + 'modules.Beispielmodul_1.grade']?.val;

test('ohne Konfiguration bleibt die vorausgewählte Seminargruppe unangetastet', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(portal.currentGroup, DEFAULT_GROUP, 'die Gruppe darf nicht gewechselt werden');
    assert.deepStrictEqual(
        [...new Set(portal.seen.submittedGroups)],
        [DEFAULT_GROUP],
        'gesendet werden darf nur die Vorauswahl',
    );
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP[DEFAULT_GROUP]);
    // Ohne Konfiguration darf auch nichts über eine Gruppenauswahl geloggt werden.
    assert.ok(!result.logs.some((l) => /Seminargruppe/i.test(l.message)));
});

test('"default" verhält sich wie leer', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'Default',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(portal.currentGroup, DEFAULT_GROUP);
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP[DEFAULT_GROUP]);
});

test('konfigurierte Seminargruppe wird über den Anzeigetext gewählt', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'BSP21w1',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(portal.currentGroup, 'gr-1', 'Portal hat die Gruppe nicht übernommen');
    assert.ok(portal.seen.submittedGroups.includes('gr-1'));
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-1'], 'Noten der falschen Gruppe gelesen');
    assert.ok(result.logs.some((l) => l.message.includes('Wähle Seminargruppe "BSP21w1"')));
});

test('Seminargruppe kann auch über den option-value gewählt werden', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'gr-3',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(portal.currentGroup, 'gr-3');
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-3']);
});

test('Seminargruppe matcht case-insensitiv und als Teilstring', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'bsp23',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.strictEqual(portal.currentGroup, 'gr-3');
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-3']);
});

test('unbekannte Seminargruppe bricht ab und nennt die verfügbaren', async (t) => {
    const portal = startPortal();
    await portal.listen();
    t.after(() => portal.close());

    // Lieber ein klarer Fehler als stillschweigend die Noten der falschen
    // Gruppe zu melden.
    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'BSP99w9',
        until: (r) => errors(r).length > 0,
    });

    assert.strictEqual(errors(result).length, 1);
    const message = errors(result)[0].message;
    assert.match(message, /BSP99w9/);
    assert.match(message, /steht nicht zur Auswahl/);
    for (const group of SEMINAR_GROUPS) {
        assert.match(message, new RegExp(group.label), `verfügbare Gruppe ${group.label} fehlt in der Meldung`);
    }

    assert.strictEqual(portal.currentGroup, DEFAULT_GROUP, 'die Gruppe darf nicht gewechselt worden sein');
    assert.strictEqual(result.notifications.length, 0, 'bei unklarer Gruppe darf nichts gemeldet werden');
    assert.strictEqual(groupGradeOf(result), '', 'es darf keine Note geschrieben werden');
});

test('Seminargruppe funktioniert auch mit eigenem Formular für das Dropdown', async (t) => {
    // Das echte HTML ist nicht bekannt: hier liegt das Dropdown in einem
    // eigenen Formular, die Rechtsbehelfsbelehrung in einem zweiten - der
    // Ablauf braucht dann zwei Submits.
    const portal = startPortal({ layout: 'separate' });
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'BSP21w1',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.ok(portal.seen.confirmed, 'Rechtsbehelfsbelehrung wurde nicht bestätigt');
    assert.strictEqual(portal.currentGroup, 'gr-1');
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-1']);
});

test('Auswahl bleibt erhalten, wenn die Bestätigungsseite sie vergisst', async (t) => {
    // Hier rendert das Portal das Dropdown auf der Bestätigungsseite immer mit
    // der aktuellen Gruppe vorausgewählt. Würde beim Bestätigen nur diese
    // Vorauswahl mitgeschickt, käme am Ende die Tabelle der falschen Gruppe.
    const portal = startPortal({ layout: 'forgetful' });
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'BSP21w1',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.ok(portal.seen.confirmed, 'Rechtsbehelfsbelehrung wurde nicht bestätigt');
    assert.deepStrictEqual(
        [...new Set(portal.seen.submittedGroups)],
        ['gr-1'],
        `es darf nur die gewählte Gruppe gesendet werden, gesendet wurde: ${portal.seen.submittedGroups.join(', ')}`,
    );
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-1'], 'Noten der falschen Gruppe gelesen');
});

test('erkennbares Gruppen-Feld gewinnt gegen andere Dropdowns', async (t) => {
    // Auf der Seite steht ein weiteres Dropdown mit denselben Optionstexten,
    // und zwar vor dem echten. Gesetzt werden muss trotzdem das als
    // Seminargruppe erkennbare Feld ("stgSelect").
    const portal = startPortal({ decoy: true });
    await portal.listen();
    t.after(() => portal.close());

    const result = await runScanner({
        port: portal.port,
        configLine: "targetModules: ['Beispielmodul 1'],",
        seminarGroup: 'BSP21w1',
    });

    assert.deepStrictEqual(errors(result), []);
    assert.deepStrictEqual(portal.seen.submittedGroups, ['gr-1'], 'es wurde das falsche Dropdown gesetzt');
    assert.strictEqual(portal.currentGroup, 'gr-1');
    assert.strictEqual(groupGradeOf(result), GRADE_BY_GROUP['gr-1']);
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
