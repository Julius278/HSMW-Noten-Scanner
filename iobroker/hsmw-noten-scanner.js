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
// Ablauf (basierend auf echten HTML-Exporten der Login- und Notenanzeige-
// Seite): Login läuft über den zentralen Shibboleth-SSO (SAML2 POST-Binding,
// separater IdP-Host). Man landet danach direkt auf der Notenanzeige-Seite,
// auf der einmalig eine Rechtsbehelfsbelehrung bestätigt werden muss
// (Formular mit verstecktem Feld "confirm_marks"). Die vollständige Liste
// aller Module (inkl. noch nicht bewerteter) zeigt erst die Ansicht
// "Alle Fächer anzeigen" (?view=full).
//
// Die Notentabelle hat die Spalten PNr, Vert, S, Modul, Credits/Wichtung,
// Art, Fach, Note, Versuch, Status/Vermerk, PDatum, Meldung. Gesucht wird in
// der "Fach"-Spalte (voller Modulname); eine leere "Note"-Zelle bedeutet
// "noch nicht eingetragen" (z.B. bei Status "AN" = angemeldet, aber offen).
// Schlägt ein Schritt fehl, wird eine Fehlermeldung geloggt; über
// CONFIG.debugDir kann zusätzlich ein HTML-Snapshot auf die Platte
// geschrieben werden, um die Selektoren unten anzupassen.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// Die ioBroker-Sandbox exponiert nicht alle Node.js-Globals - URL und
// URLSearchParams sind zwar in normalem Node.js global verfügbar, hier aber
// explizit aus dem "url"-Modul zu importieren.
const { URL, URLSearchParams } = require('url');

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

// Cookies werden pro Hostname getrennt gespeichert (jar[hostname][name] = value).
// Wichtig, da der Login über einen separaten Shibboleth-IdP-Host läuft, bevor
// man zurück zum QIS/POS-Host (qispos.hs-mittweida.de) gelangt - beide könnten
// z.B. denselben Cookie-Namen "JSESSIONID" verwenden, ein gemeinsamer Jar würde
// die Sessions durcheinanderbringen.
function cookieHeader(jar, hostname) {
    const store = jar[hostname];
    if (!store) return '';
    return Object.entries(store)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

function updateJar(jar, hostname, res) {
    let setCookieHeaders = [];
    if (typeof res.headers.getSetCookie === 'function') {
        setCookieHeaders = res.headers.getSetCookie();
    } else if (typeof res.headers.raw === 'function' && res.headers.raw()['set-cookie']) {
        setCookieHeaders = res.headers.raw()['set-cookie'];
    } else if (res.headers.get('set-cookie')) {
        setCookieHeaders = [res.headers.get('set-cookie')];
    }
    if (setCookieHeaders.length === 0) return;
    if (!jar[hostname]) jar[hostname] = {};
    for (const sc of setCookieHeaders) {
        const pair = sc.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        jar[hostname][pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
}

// Manche Uni-Systeme/WAFs blockieren oder liefern anderen Inhalt bei
// Anfragen ohne "normalen" Browser-User-Agent - deshalb wird hier bewusst
// ein üblicher Browser-Header mitgeschickt.
const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

async function fetchWithCookies(url, options, jar) {
    let currentUrl = url;
    let opts = Object.assign({}, options, { redirect: 'manual' });

    for (let redirects = 0; redirects < 10; redirects++) {
        const hostname = new URL(currentUrl).hostname;
        opts.headers = Object.assign({}, DEFAULT_HEADERS, opts.headers, { Cookie: cookieHeader(jar, hostname) });
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            opts.signal = AbortSignal.timeout(CONFIG.requestTimeoutMs);
        }

        const res = await fetchFn(currentUrl, opts);
        updateJar(jar, hostname, res);

        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            currentUrl = new URL(res.headers.get('location'), currentUrl).toString();
            opts = { method: 'GET', redirect: 'manual' };
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

    // <button> ohne explizites type-Attribut ist per HTML-Spezifikation ein
    // Submit-Button (siehe z.B. den Shibboleth-Login-Knopf
    // <button type="submit" name="_eventId_proceed">Anmelden</button>) - muss
    // also mitberücksichtigt werden, nicht nur <input type=submit>.
    form.find('input, select, textarea, button').each((i, el) => {
        const input = $(el);
        const name = input.attr('name');
        if (!name) return;
        const tag = el.tagName.toLowerCase();
        const type =
            tag === 'input' ? (input.attr('type') || 'text').toLowerCase()
            : tag === 'button' ? (input.attr('type') || 'submit').toLowerCase()
            : tag;

        if (type === 'submit' || type === 'image') {
            if (!submitAdded && overrides.preferredSubmit !== false) {
                params.set(name, input.attr('value') || '');
                submitAdded = true;
            }
            return;
        }
        if (type === 'button' || type === 'reset') {
            return; // nicht Teil der übermittelten Formulardaten
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
// Shibboleth/SAML-Zwischenseiten
// ---------------------------------------------------------------------------

// Nach einem erfolgreichen Login beim Shibboleth-IdP folgt meist keine direkte
// Weiterleitung, sondern eine Zwischenseite mit einem versteckten Formular
// (SAML POST-Binding: Felder "SAMLResponse"/"RelayState"), das sich per
// JavaScript selbst an den Service Provider (qispos.hs-mittweida.de) zurück-
// postet. Da wir kein JS ausführen, senden wir dieses Formular hier manuell ab.
async function followIntermediateForms(jar, page, maxSteps = 5) {
    let current = page;
    for (let i = 0; i < maxSteps; i++) {
        const $ = cheerio.load(current.body);
        if ($('input[type=password]').length > 0) return current;

        const relayForm = $('form')
            .filter(
                (idx, el) =>
                    $(el).find('input[name=SAMLResponse]').length > 0 ||
                    $(el).find('input[name=SAMLart]').length > 0,
            )
            .first();

        if (relayForm.length === 0) return current;

        log('Folge automatischem SSO-Weiterleitungsformular...');
        current = await submitForm($, relayForm, current.url, jar, {});
    }
    return current;
}

// Manche Shibboleth-IdP-Installationen zeigen vor dem eigentlichen
// Login-Formular technische Zwischenseiten ohne Passwortfeld, z.B. den
// "Client Storage Service" (prüft per JavaScript, ob im localStorage bereits
// eine Sitzung hinterlegt ist). Diese Seiten enthalten laut Shibboleth-
// Quellcode immer einen <noscript>-Fallback mit normalem Submit-Button für
// Clients ohne JavaScript - das Formular kann daher einfach mit seinen
// Standard-/Leerwerten abgeschickt werden, ohne dass echtes JavaScript nötig
// wäre oder die genauen Feldnamen bekannt sein müssen.
// Manche IdP-Konfigurationen versuchen vor dem Passwort-Formular zusätzlich
// eine SPNEGO/Kerberos-Anmeldung (Single-Sign-On per Windows-Domänenticket,
// Pfad "/idp/profile/Authn/SPNEGO/<conversation>"). Ohne Kerberos-Ticket
// (bzw. ohne Browser) schlägt das immer mit Status 401 fehl; laut echtem
// HAR-Mitschnitt bricht der Browser diesen Versuch dann selbst ab, indem er
// den zugehörigen "/error"-Endpunkt aufruft (gleiche Conversation-ID als
// Query-Parameter) - das führt zurück in den normalen Login-Flow, der
// schließlich auf der Seite mit dem Passwort-Formular landet.
const SPNEGO_PATH_RE = /\/idp\/profile\/Authn\/SPNEGO\/[^/?]+$/;

async function bypassIntermediateForms(jar, page, maxSteps = 8) {
    let current = page;
    for (let i = 0; i < maxSteps; i++) {
        const $ = cheerio.load(current.body);
        if ($('input[type=password]').length > 0) return current;

        const currentPath = new URL(current.url).pathname;
        if (SPNEGO_PATH_RE.test(currentPath)) {
            log(`SPNEGO/Kerberos-Anmeldeversuch erkannt (Status ${current.status}), erzwinge Fallback auf Formular-Login...`);
            const errorUrl = new URL(current.url);
            errorUrl.pathname += '/error';
            current = await fetchWithCookies(errorUrl.toString(), { method: 'GET' }, jar);
            continue;
        }

        // Nur POST-Formulare berücksichtigen: technische SSO-Zwischenschritte
        // (Client Storage, SAML-Relay) sind immer POST, während z.B. das
        // Such-Formular im Seitenkopf (GET) sonst fälschlich gegriffen würde.
        const form = $('form')
            .filter((idx, el) => (($(el).attr('method') || 'GET').toUpperCase() === 'POST'))
            .first();
        if (form.length === 0) return current;

        log(`Sende technische Zwischenseite automatisch ab (Titel: "${$('title').text().trim()}")...`);
        current = await submitForm($, form, current.url, jar, {});
    }
    return current;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(jar) {
    log('Öffne ' + CONFIG.url);
    let startPage = await fetchWithCookies(CONFIG.url, { method: 'GET' }, jar);
    startPage = await bypassIntermediateForms(jar, startPage);
    let $ = cheerio.load(startPage.body);

    if ($('input[type=password]').length === 0) {
        log(
            `Kein Login-Formular gefunden, vermutlich bereits eingeloggt. ` +
                `(Status ${startPage.status}, gelandet auf ${startPage.url}, Titel: "${$('title').text().trim()}")`,
        );
        dumpDebug('no-login-form-assumed-logged-in', startPage.body);
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

    let loginRes = await submitForm($, form, startPage.url, jar, {
        fields: { [usernameField]: CONFIG.username, [passwordField]: CONFIG.password },
    });

    loginRes = await followIntermediateForms(jar, loginRes);

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

// Direkt nach dem Login landet man bereits auf der Notenanzeige-Seite. Zwei
// Besonderheiten dieser konkreten Seite (laut echtem HTML-Export):
//   1. Die Standardansicht zeigt vermutlich nicht alle Module (nur bereits
//      benotete). Der Link "Alle Fächer anzeigen" (?view=full) zeigt die
//      vollständige Liste inkl. noch nicht bewerteter Module - das ist die
//      für uns relevante Ansicht.
//   2. Vor der eigentlichen Notenliste muss einmalig eine
//      Rechtsbehelfsbelehrung bestätigt werden: ein <form> ohne action mit
//      einem versteckten Feld "confirm_marks=true", das an die aktuelle
//      Seite zurückgesendet wird.
async function openGradesView(jar, page) {
    const $ = cheerio.load(page.body);

    let fullViewUrl;
    const fullViewLink = $('a')
        .filter((i, el) => /view=full/i.test($(el).attr('href') || ''))
        .first();
    if (fullViewLink.length > 0) {
        fullViewUrl = new URL(fullViewLink.attr('href'), page.url).toString();
    } else {
        // Laut echtem HTML-Export liegt der Link immer unter dem Root-Pfad
        // ("/?view=full"), unabhängig vom aktuellen Pfad - daher hier bewusst
        // nicht den aktuellen Pfad wiederverwenden.
        fullViewUrl = new URL('/?view=full', page.url).toString();
    }

    log('Öffne vollständige Notenübersicht (alle Fächer)...');
    let current = await fetchWithCookies(fullViewUrl, { method: 'GET' }, jar);

    let $$ = cheerio.load(current.body);
    const confirmForm = $$('form')
        .filter((i, el) => $$(el).find('input[name=confirm_marks]').length > 0)
        .first();
    if (confirmForm.length > 0) {
        log('Bestätige Rechtsbehelfsbelehrung...');
        current = await submitForm($$, confirmForm, current.url, jar, {});
    }

    return current;
}

// ---------------------------------------------------------------------------
// Notentabelle parsen
// ---------------------------------------------------------------------------

// Echte Tabellenstruktur (laut HTML-Export der Notenübersicht):
// Spalten sind PNr, Vert, S, Modul, Credits/Wichtung, Art, Fach, Note,
// Versuch, Status/Vermerk, PDatum, Meldung. Die Kopfzeile wird ausgelesen,
// um die Spalten "Fach" und "Note" unabhängig von ihrer Position zu finden
// (robuster als eine feste Spaltennummer). Eine leere "Note"-Zelle bedeutet
// "noch nicht bewertet" (z.B. Status "AN" = angemeldet, aber noch offen).
function parseGradesTable(html) {
    const $ = cheerio.load(html);
    const tables = [];
    $('table').each((i, table) => {
        const $table = $(table);
        const headers = $table
            .find('thead th')
            .map((k, th) => $(th).text().trim())
            .get();
        const rows = [];
        $table.find('tbody tr, tr').each((j, tr) => {
            if ($(tr).parents('thead').length > 0) return;
            const cells = $(tr)
                .find('td')
                .map((k, td) => $(td).text().replace(/\s+/g, ' ').trim())
                .get();
            if (cells.length === 0 || cells.every((c) => !c)) return;
            rows.push(cells);
        });
        if (rows.length > 0) tables.push({ headers, rows });
    });
    return tables;
}

function findTargetGrade(tables, targetModule) {
    const targetLower = targetModule.toLowerCase();
    for (const { headers, rows } of tables) {
        const noteIdx = headers.findIndex((h) => h.toLowerCase() === 'note');
        for (const cells of rows) {
            if (!cells.some((c) => c.toLowerCase().includes(targetLower))) continue;

            let grade;
            if (noteIdx >= 0 && noteIdx < cells.length) {
                grade = cells[noteIdx].trim() || null;
            } else {
                // Fallback, falls die Kopfzeile nicht erkannt wurde: letzte
                // nicht-leere Zelle, die nicht der gesuchte Text selbst ist.
                grade = null;
                for (let i = cells.length - 1; i >= 0; i--) {
                    const c = cells[i].trim();
                    if (c && c.toLowerCase() !== targetLower && c.length <= 30) {
                        grade = c;
                        break;
                    }
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

// Werte, die als "noch keine Note eingetragen" gewertet werden. Da die echte
// Notentabelle noch nicht eingesehen werden konnte, ist diese Liste eine
// Vermutung - bei Bedarf anhand von CONFIG.debugDir-Snapshots anpassen.
// Laut echtem HTML-Export ist die "Note"-Zelle schlicht leer, solange keine
// Note eingetragen ist (z.B. bei Status "AN" = angemeldet). Zusätzliche
// Platzhalter zur Sicherheit, falls ein Modultyp doch Text statt Leerzelle
// verwendet.
const UNGRADED_VALUES = ['-', '--', 'n.b.', 'offen'];

async function checkGrades() {
    const jar = {};
    try {
        const startPage = await login(jar);
        const gradesPage = await openGradesView(jar, startPage);
        const tables = parseGradesTable(gradesPage.body);
        const result = findTargetGrade(tables, CONFIG.targetModule);
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
