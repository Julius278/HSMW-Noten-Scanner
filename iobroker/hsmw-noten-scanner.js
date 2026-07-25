// HSMW Noten-Scanner für ioBroker (javascript-Adapter)
//
// Loggt sich in das QIS/POS-Notenportal der Hochschule Mittweida ein, öffnet
// die Notenübersicht und prüft, ob für ein bestimmtes Modul bereits eine Note
// eingetragen ist. Benachrichtigung erfolgt per Pushover-Adapter.
//
// Voraussetzungen (Instanz-Einstellungen des javascript-Adapters):
//   - Node.js >= 18 (liefert globales fetch()). Falls älter: Modul
//     "node-fetch" unter "Zusätzliche NPM-Module" eintragen.
//   - Zusätzliches NPM-Modul "cheerio" eintragen (zum HTML-Parsen).
//
// Da das Portal nur mit gültigen Zugangsdaten erreichbar ist, konnten Login-
// Formular und Notenspiegel-Knopf nicht live geprüft werden. Die Erkennung
// ist deshalb bewusst generisch gehalten (erstes Passwortfeld = Login-
// Formular, erstes Textfeld darin = Benutzername, Link/Button-Text
// konfigurierbar). Schlägt ein Schritt fehl, wird eine Fehlermeldung geloggt;
// über CONFIG.debugDir kann zusätzlich ein HTML-Snapshot auf die Platte
// geschrieben werden, um die Selektoren unten anzupassen.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
const CONFIG = {
    // Zugangsdaten für das QIS/POS-Portal
    username: 'dein_benutzername',
    password: 'dein_kennwort',

    // Startseite (Login -> Notenanzeige)
    url: 'https://qispos.hs-mittweida.de/noten?intranet&m',

    // Name/Teilstring des Moduls bzw. der Prüfung, dessen Note überwacht
    // werden soll (Groß-/Kleinschreibung wird ignoriert)
    targetModule: 'Analysis 1',

    // Text des Knopfes/Links zur Notenübersicht. Mehrere Kandidaten möglich,
    // der erste gefundene Treffer wird verwendet.
    buttonCandidates: ['Notenspiegel', 'Leistungsspiegel', 'Prüfungsergebnisse', 'Notenübersicht'],

    // Pushover-Adapterinstanz und optionaler Sound
    pushoverInstance: 'pushover.0',
    pushoverSound: '',

    // Wie oft geprüft werden soll (Cron-Ausdruck für die schedule()-Funktion
    // des javascript-Adapters)
    cronSchedule: '*/30 * * * *',

    // Beim Start des Scripts direkt einmal prüfen (zusätzlich zum Zeitplan)
    runOnScriptStart: true,

    // Request-Timeout in ms
    requestTimeoutMs: 20000,

    // Optional: absoluter Pfad, in den bei Fehlern ein HTML-Snapshot der
    // zuletzt geladenen Seite geschrieben wird (zum Debuggen der Selektoren).
    // Leer lassen, um das zu deaktivieren.
    debugDir: '',
};

const STATE_PREFIX = '0_userdata.0.hsmwNotenScanner.';

// ---------------------------------------------------------------------------
// HTTP-Hilfsfunktionen (fetch + manuelles Cookie-Handling, da diese Portale
// klassische serverseitig gerenderte Java/JSP-Formulare mit Session-Cookie
// verwenden)
// ---------------------------------------------------------------------------

const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

function cookieHeader(jar) {
    return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

function updateJar(jar, res) {
    let setCookieHeaders = [];
    if (typeof res.headers.getSetCookie === 'function') {
        setCookieHeaders = res.headers.getSetCookie();
    } else if (typeof res.headers.raw === 'function' && res.headers.raw()['set-cookie']) {
        setCookieHeaders = res.headers.raw()['set-cookie'];
    } else if (res.headers.get('set-cookie')) {
        setCookieHeaders = [res.headers.get('set-cookie')];
    }
    for (const sc of setCookieHeaders) {
        const pair = sc.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
}

async function fetchWithCookies(url, options, jar) {
    let currentUrl = url;
    let opts = Object.assign({}, options, { redirect: 'manual' });

    for (let redirects = 0; redirects < 10; redirects++) {
        opts.headers = Object.assign({}, opts.headers, { Cookie: cookieHeader(jar) });
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            opts.signal = AbortSignal.timeout(CONFIG.requestTimeoutMs);
        }

        const res = await fetchFn(currentUrl, opts);
        updateJar(jar, res);

        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            currentUrl = new URL(res.headers.get('location'), currentUrl).toString();
            opts = { method: 'GET', headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' };
            continue;
        }

        const body = await res.text();
        return { url: currentUrl, status: res.status, body };
    }
    throw new Error('Zu viele Redirects bei ' + url);
}

function dumpDebug(name, html) {
    if (!CONFIG.debugDir) return;
    try {
        fs.mkdirSync(CONFIG.debugDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(CONFIG.debugDir, `${stamp}-${name}.html`);
        fs.writeFileSync(file, html, 'utf-8');
        log(`Debug-Snapshot gespeichert: ${file}`);
    } catch (err) {
        log('Konnte Debug-Snapshot nicht schreiben: ' + err.message, 'warn');
    }
}

// ---------------------------------------------------------------------------
// Formular-Hilfsfunktionen
// ---------------------------------------------------------------------------

function collectFormParams($, form, overrides) {
    const params = new URLSearchParams();
    let submitAdded = false;

    form.find('input, select, textarea').each((i, el) => {
        const input = $(el);
        const name = input.attr('name');
        if (!name) return;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? (input.attr('type') || 'text').toLowerCase() : tag;

        if (type === 'submit' || type === 'image' || type === 'button') {
            if (!submitAdded && overrides.preferredSubmit !== false) {
                params.set(name, input.attr('value') || '');
                submitAdded = true;
            }
            return;
        }
        if (type === 'checkbox' || type === 'radio') {
            if (input.is(':checked') || input.attr('checked') !== undefined) {
                params.set(name, input.attr('value') || 'on');
            }
            return;
        }
        params.set(name, input.val() || input.attr('value') || '');
    });

    for (const [name, value] of Object.entries(overrides.fields || {})) {
        params.set(name, value);
    }

    return params;
}

async function submitForm($, form, pageUrl, jar, overrides) {
    const actionAttr = form.attr('action') || '';
    const method = (form.attr('method') || 'GET').toUpperCase();
    const actionUrl = new URL(actionAttr || pageUrl, pageUrl).toString();
    const params = collectFormParams($, form, overrides);

    if (method === 'POST') {
        return fetchWithCookies(
            actionUrl,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
            },
            jar,
        );
    }
    const getUrl = actionUrl + (actionUrl.includes('?') ? '&' : '?') + params.toString();
    return fetchWithCookies(getUrl, { method: 'GET' }, jar);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(jar) {
    log('Öffne ' + CONFIG.url);
    const startPage = await fetchWithCookies(CONFIG.url, { method: 'GET' }, jar);
    let $ = cheerio.load(startPage.body);

    if ($('input[type=password]').length === 0) {
        log('Kein Login-Formular gefunden, vermutlich bereits eingeloggt.');
        return startPage;
    }

    const form = $('form')
        .filter((i, el) => $(el).find('input[type=password]').length > 0)
        .first();

    if (form.length === 0) {
        dumpDebug('login-no-form', startPage.body);
        throw new Error('Login-Seite enthält ein Passwortfeld, aber kein umschließendes <form>.');
    }

    let usernameField = null;
    form.find('input').each((i, el) => {
        if (usernameField) return;
        const input = $(el);
        const type = (input.attr('type') || 'text').toLowerCase();
        if (['text', 'email'].includes(type)) usernameField = input.attr('name');
    });

    if (!usernameField) {
        dumpDebug('login-no-username-field', startPage.body);
        throw new Error('Konnte kein Benutzername-Feld im Login-Formular finden. Siehe debugDir-Snapshot.');
    }

    const passwordField = form.find('input[type=password]').first().attr('name');

    const loginRes = await submitForm($, form, startPage.url, jar, {
        fields: { [usernameField]: CONFIG.username, [passwordField]: CONFIG.password },
    });

    const $$ = cheerio.load(loginRes.body);
    if ($$('input[type=password]').length > 0) {
        dumpDebug('login-failed', loginRes.body);
        throw new Error('Login fehlgeschlagen (Passwortfeld weiterhin sichtbar). Zugangsdaten prüfen.');
    }

    log('Login erfolgreich.');
    return loginRes;
}

// ---------------------------------------------------------------------------
// Notenübersicht öffnen
// ---------------------------------------------------------------------------

async function openGradesView(jar, page) {
    const $ = cheerio.load(page.body);

    for (const text of CONFIG.buttonCandidates) {
        const lower = text.toLowerCase();

        const link = $('a')
            .filter((i, el) => $(el).text().trim().toLowerCase().includes(lower) && $(el).attr('href'))
            .first();
        if (link.length > 0) {
            const url = new URL(link.attr('href'), page.url).toString();
            log(`Öffne Link "${text}"`);
            return fetchWithCookies(url, { method: 'GET' }, jar);
        }

        const btn = $('input[type=submit], button')
            .filter((i, el) => {
                const val = ($(el).attr('value') || $(el).text() || '').trim().toLowerCase();
                return val.includes(lower);
            })
            .first();
        if (btn.length > 0) {
            const form = btn.closest('form');
            if (form.length === 0) continue;
            log(`Sende Formular für Knopf "${text}"`);
            return submitForm($, form, page.url, jar, {});
        }
    }

    dumpDebug('grades-button-not-found', page.body);
    throw new Error(
        `Keiner der konfigurierten Knöpfe [${CONFIG.buttonCandidates.join(', ')}] wurde gefunden. Siehe debugDir-Snapshot.`,
    );
}

// ---------------------------------------------------------------------------
// Notentabelle parsen
// ---------------------------------------------------------------------------

function parseGradesTable(html) {
    const $ = cheerio.load(html);
    const rows = [];
    $('table').each((i, table) => {
        $(table)
            .find('tr')
            .each((j, tr) => {
                const cells = $(tr)
                    .find('td')
                    .map((k, td) => $(td).text().trim())
                    .get();
                if (cells.length === 0 || cells.every((c) => !c)) return;
                rows.push(cells);
            });
    });
    return rows;
}

function findTargetGrade(rows, targetModule) {
    const targetLower = targetModule.toLowerCase();
    for (const cells of rows) {
        if (cells.some((c) => c.toLowerCase().includes(targetLower))) {
            let grade = null;
            for (let i = cells.length - 1; i >= 0; i--) {
                const c = cells[i].trim();
                if (c && c.toLowerCase() !== targetLower && c.length <= 6) {
                    grade = c;
                    break;
                }
            }
            return { rowText: cells.join(' | '), grade };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Benachrichtigung
// ---------------------------------------------------------------------------

function notify(message) {
    sendTo(CONFIG.pushoverInstance, 'send', {
        message,
        title: 'HSMW Noten-Scanner',
        sound: CONFIG.pushoverSound || undefined,
    });
}

// ---------------------------------------------------------------------------
// Hauptlogik
// ---------------------------------------------------------------------------

async function ensureStates() {
    await createStateAsync(STATE_PREFIX + 'lastGrade', '');
    await createStateAsync(STATE_PREFIX + 'lastGraded', false);
    await createStateAsync(STATE_PREFIX + 'lastCheck', '');
}

const UNGRADED_VALUES = ['-', '--', 'n.b.', 'offen'];

async function checkGrades() {
    const jar = {};
    try {
        const startPage = await login(jar);
        const gradesPage = await openGradesView(jar, startPage);
        const rows = parseGradesTable(gradesPage.body);
        const result = findTargetGrade(rows, CONFIG.targetModule);
        const now = new Date().toISOString();

        if (!result) {
            log(`Modul "${CONFIG.targetModule}" wurde in der Notenübersicht nicht gefunden.`, 'warn');
            dumpDebug('module-not-found', gradesPage.body);
            await setStateAsync(STATE_PREFIX + 'lastCheck', now, true);
            return;
        }

        const grade = result.grade;
        const isGraded = !!grade && !UNGRADED_VALUES.includes(grade.toLowerCase());

        if (isGraded) {
            log(`Note für "${CONFIG.targetModule}" ist eingetragen: ${grade}`);
        } else {
            log(`Note für "${CONFIG.targetModule}" ist noch nicht eingetragen.`);
        }

        const prevState = await getStateAsync(STATE_PREFIX + 'lastGraded');
        const wasGradedBefore = prevState ? prevState.val === true : false;

        if (isGraded && !wasGradedBefore) {
            log('Neuer Notenstand erkannt -> sende Pushover-Benachrichtigung.');
            notify(`Note für ${CONFIG.targetModule} wurde eingetragen: ${grade}`);
        }

        await setStateAsync(STATE_PREFIX + 'lastGrade', grade || '', true);
        await setStateAsync(STATE_PREFIX + 'lastGraded', isGraded, true);
        await setStateAsync(STATE_PREFIX + 'lastCheck', now, true);
    } catch (err) {
        log('Fehler beim Prüfen der Noten: ' + err.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Einstiegspunkt
// ---------------------------------------------------------------------------

(async () => {
    await ensureStates();
    schedule(CONFIG.cronSchedule, () => checkGrades());
    log(`HSMW Noten-Scanner gestartet, Zeitplan: ${CONFIG.cronSchedule}`);
    if (CONFIG.runOnScriptStart) {
        checkGrades();
    }
})();
