// HSMW Noten-Scanner für ioBroker (javascript-Adapter)
//
// Loggt sich in das QIS/POS-Notenportal der Hochschule Mittweida ein, öffnet
// die Notenübersicht und prüft für ein oder mehrere Module, ob bereits eine
// Note eingetragen ist. Benachrichtigung erfolgt per Pushover-Adapter, einmal
// pro neu eingetragener Note.
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

    // Namen/Teilstrings der Module bzw. Prüfungen, deren Noten überwacht
    // werden sollen (Groß-/Kleinschreibung wird ignoriert). Ein einzelner
    // String ist ebenfalls erlaubt:  targetModules: 'dein_modulname'
    targetModules: ['dein_modulname'],

    // Optional: Seminargruppe, für die die Noten abgefragt werden. Vor der
    // Notentabelle steht im Portal ein Dropdown zur Auswahl der Seminargruppe;
    // vorausgewählt ist die aktuelle. Leer lassen oder 'default' eintragen, um
    // die Vorauswahl unangetastet zu lassen - das ist der Normalfall. Nur wenn
    // hier etwas steht (z.B. nach einem Gruppenwechsel eine frühere Gruppe),
    // wird umgeschaltet; steht der Wert nicht zur Auswahl, bricht der Lauf mit
    // einer Fehlermeldung ab, die die verfügbaren Gruppen nennt.
    seminarGroup: '',

    // Pushover-Adapterinstanz und optionaler Sound
    pushoverInstance: 'pushover.0',
    pushoverSound: '',

    // Wie oft geprüft werden soll (Cron-Ausdruck für die schedule()-Funktion
    // des javascript-Adapters)
    cronSchedule: '*/15 * * * *',

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
// Zu überwachende Module
// ---------------------------------------------------------------------------

// Wird beim Scriptstart einmal aus CONFIG abgeleitet: die bereinigte Modulliste
// und die Zuordnung Modulname -> State-ID.
let TARGET_MODULES = [];
const STATE_IDS = new Map();

// Akzeptiert ein Array, einen einzelnen String und - damit ältere
// Konfigurationen weiterlaufen - auch das frühere Einzelfeld
// CONFIG.targetModule. Doppelte Einträge werden entfernt (ohne Rücksicht auf
// Groß-/Kleinschreibung), damit ein Modul nicht mehrfach gemeldet wird.
function resolveTargetModules() {
    const normalize = (value) => {
        const list = Array.isArray(value) ? value : [value];
        return list
            .filter((m) => typeof m === 'string')
            .map((m) => m.trim())
            .filter((m) => m.length > 0);
    };

    const configured = normalize(CONFIG.targetModules);
    const modules = configured.length > 0 ? configured : normalize(CONFIG.targetModule);

    const seen = new Set();
    return modules.filter((m) => {
        const key = m.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ioBroker-State-IDs dürfen keinen Punkt (das ist das Trennzeichen im
// Objektbaum) und möglichst keine Sonderzeichen/Leerzeichen enthalten - der
// Modulname wird daher auf [A-Za-z0-9_] reduziert. Falls zwei Modulnamen dabei
// auf dieselbe ID fallen (z.B. "Modul 1" und "Modul-1"), wird durchnummeriert.
function buildStateIds(modules) {
    const ids = new Map();
    const used = new Set();
    for (const moduleName of modules) {
        const base =
            moduleName
                .replace(/[^A-Za-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '') || 'modul';
        let id = base;
        for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
        used.add(id);
        ids.set(moduleName, id);
    }
    return ids;
}

function moduleStatePrefix(moduleName) {
    return `${STATE_PREFIX}modules.${STATE_IDS.get(moduleName)}.`;
}

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
// Seminargruppe
// ---------------------------------------------------------------------------

// Leer oder "default": die vom Portal vorausgewählte Seminargruppe beibehalten.
function wantedSeminarGroup() {
    const value = String(CONFIG.seminarGroup || '').trim();
    if (!value || value.toLowerCase() === 'default') return null;
    return value;
}

const normalizeLabel = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

function selectOptions($, select) {
    return $(select)
        .find('option')
        .map((i, opt) => {
            const $opt = $(opt);
            const label = String($opt.text() || '').replace(/\s+/g, ' ').trim();
            const value = $opt.attr('value');
            return { label, value: value === undefined ? label : value };
        })
        .get();
}

// Sucht das Dropdown, das die gewünschte Seminargruppe anbietet.
//
// Der Feldname des Dropdowns im Portal ist nicht dokumentiert, deshalb wird
// bewusst nicht darauf abgestellt: gesucht wird das <select>, in dessen
// Optionen der konfigurierte Wert vorkommt - verglichen wird sowohl der
// Anzeigetext als auch das value-Attribut, erst exakt, dann als Teilstring.
// Selects, deren name/id auf eine Seminargruppe hindeutet, werden bevorzugt
// (im Portal heißt das Feld "stgSelect"); so greift die Suche auch dann nicht
// auf ein unbeteiligtes Dropdown, wenn mehrere auf der Seite stehen.
function findSeminarGroupSelect($, wanted, scope) {
    const selects = (scope && scope.length ? scope.find('select') : $('select'))
        .map((i, el) => el)
        .get()
        .filter((el) => $(el).attr('name'));

    const looksLikeGroup = (el) =>
        /stg|seminar|gruppe|group/i.test(`${$(el).attr('name') || ''} ${$(el).attr('id') || ''}`);

    // Bevorzugt die als Seminargruppe erkennbaren Dropdowns durchsuchen.
    const ordered = [...selects.filter(looksLikeGroup), ...selects.filter((el) => !looksLikeGroup(el))];
    const target = normalizeLabel(wanted);

    for (const matcher of [
        (o) => normalizeLabel(o.label) === target || normalizeLabel(o.value) === target,
        (o) => normalizeLabel(o.label).includes(target) || normalizeLabel(o.value).includes(target),
    ]) {
        for (const el of ordered) {
            const option = selectOptions($, el).find(matcher);
            if (option) {
                return { select: el, name: $(el).attr('name'), value: option.value, label: option.label || option.value };
            }
        }
    }
    return null;
}

// Für die Fehlermeldung: welche Gruppen stünden zur Auswahl?
function describeSeminarGroupOptions($) {
    const selects = $('select')
        .map((i, el) => el)
        .get()
        .filter((el) => $(el).attr('name'));
    const preferred = selects.filter((el) =>
        /stg|seminar|gruppe|group/i.test(`${$(el).attr('name') || ''} ${$(el).attr('id') || ''}`),
    );
    const relevant = preferred.length > 0 ? preferred : selects;
    if (relevant.length === 0) return 'kein Auswahlfeld auf der Seite gefunden';

    return relevant
        .map((el) => {
            const labels = selectOptions($, el)
                .map((o) => o.label || o.value)
                .filter((l) => l);
            return `${$(el).attr('name')}: ${labels.join(', ') || '(keine Optionen)'}`;
        })
        .join(' | ');
}

// Liefert die Feld-Überschreibung, falls das Dropdown in diesem Formular steht.
function seminarGroupOverride($, form, wanted) {
    if (!wanted) return {};
    const match = findSeminarGroupSelect($, wanted, form);
    return match ? { [match.name]: match.value } : {};
}

// Stellt das Dropdown auf die konfigurierte Seminargruppe und schickt dessen
// Formular ab. Steht die Gruppe nicht zur Auswahl, wird abgebrochen - lieber
// ein klarer Fehler als stillschweigend die Noten der falschen Gruppe zu
// melden.
async function selectSeminarGroup(jar, page, wanted) {
    const $ = cheerio.load(page.body);
    const match = findSeminarGroupSelect($, wanted);

    if (!match) {
        dumpDebug('seminar-group-not-found', page.body);
        throw new Error(
            `Seminargruppe "${wanted}" steht nicht zur Auswahl. Verfügbar: ${describeSeminarGroupOptions($)}`,
        );
    }

    const form = $(match.select).closest('form');
    if (form.length === 0) {
        dumpDebug('seminar-group-no-form', page.body);
        throw new Error(
            `Das Dropdown der Seminargruppe (Feld "${match.name}") liegt außerhalb eines <form>, ` +
                'die Auswahl kann nicht abgeschickt werden.',
        );
    }

    log(`Wähle Seminargruppe "${match.label}" (Feld "${match.name}")...`);
    return submitForm($, form, page.url, jar, { fields: { [match.name]: match.value } });
}

// ---------------------------------------------------------------------------
// Notenübersicht öffnen
// ---------------------------------------------------------------------------

// Direkt nach dem Login landet man bereits auf der Notenanzeige-Seite. Drei
// Besonderheiten dieser konkreten Seite:
//   1. Die Standardansicht zeigt vermutlich nicht alle Module (nur bereits
//      benotete). Der Link "Alle Fächer anzeigen" (?view=full) zeigt die
//      vollständige Liste inkl. noch nicht bewerteter Module - das ist die
//      für uns relevante Ansicht.
//   2. Vor der Notentabelle steht ein Dropdown zur Auswahl der Seminargruppe.
//      Ohne Konfiguration wird die Vorauswahl des Portals einfach mitgesendet;
//      nur wenn CONFIG.seminarGroup gesetzt ist, wird umgeschaltet.
//   3. Vor der eigentlichen Notenliste muss einmalig eine
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

    // Nur bei konfigurierter Seminargruppe eingreifen. Ohne Konfiguration
    // bleibt der Ablauf unverändert: die Vorauswahl des Dropdowns wird beim
    // Abschicken des Formulars ohnehin mitgesendet.
    const wantedGroup = wantedSeminarGroup();
    if (wantedGroup) {
        current = await selectSeminarGroup(jar, current, wantedGroup);
    }

    let $$ = cheerio.load(current.body);
    const confirmForm = $$('form')
        .filter((i, el) => $$(el).find('input[name=confirm_marks]').length > 0)
        .first();
    if (confirmForm.length > 0) {
        log('Bestätige Rechtsbehelfsbelehrung...');
        // Steht das Dropdown auch auf dieser Seite (bzw. im selben Formular),
        // wird die Auswahl erneut mitgegeben, damit sie nicht verloren geht.
        current = await submitForm($$, confirmForm, current.url, jar, {
            fields: seminarGroupOverride($$, confirmForm, wantedGroup),
        });
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
    await createStateAsync(STATE_PREFIX + 'lastCheck', '');

    // Pro Modul ein eigener Zweig unter ".modules". "name" hält den
    // Originalnamen, da die State-ID Sonderzeichen und Leerzeichen ersetzt.
    for (const moduleName of TARGET_MODULES) {
        const prefix = moduleStatePrefix(moduleName);
        await createStateAsync(prefix + 'name', moduleName);
        await createStateAsync(prefix + 'grade', '');
        await createStateAsync(prefix + 'graded', false);
        await createStateAsync(prefix + 'lastCheck', '');
        await setStateAsync(prefix + 'name', moduleName, true);
    }

    // Die alten Einzel-States bleiben erhalten und spiegeln weiterhin das
    // erste konfigurierte Modul - so funktionieren bestehende VIS-Widgets und
    // Skripte aus früheren Versionen unverändert weiter.
    await createStateAsync(STATE_PREFIX + 'lastGrade', '');
    await createStateAsync(STATE_PREFIX + 'lastGraded', false);
}

// Werte, die als "noch keine Note eingetragen" gewertet werden. Da die echte
// Notentabelle noch nicht eingesehen werden konnte, ist diese Liste eine
// Vermutung - bei Bedarf anhand von CONFIG.debugDir-Snapshots anpassen.
// Laut echtem HTML-Export ist die "Note"-Zelle schlicht leer, solange keine
// Note eingetragen ist (z.B. bei Status "AN" = angemeldet). Zusätzliche
// Platzhalter zur Sicherheit, falls ein Modultyp doch Text statt Leerzelle
// verwendet.
const UNGRADED_VALUES = ['-', '--', 'n.b.', 'offen'];

// Prüft alle konfigurierten Module in einem Durchlauf: einmal einloggen, einmal
// die Notenübersicht laden und parsen, dann jede Modulzeile darin suchen.
async function checkGrades() {
    const jar = {};
    try {
        const startPage = await login(jar);
        const gradesPage = await openGradesView(jar, startPage);
        const tables = parseGradesTable(gradesPage.body);
        const now = new Date().toISOString();

        let anyMissing = false;
        let firstModuleGrade = null;

        for (const moduleName of TARGET_MODULES) {
            const prefix = moduleStatePrefix(moduleName);
            const result = findTargetGrade(tables, moduleName);

            if (!result) {
                log(`Modul "${moduleName}" wurde in der Notenübersicht nicht gefunden.`, 'warn');
                anyMissing = true;
                await setStateAsync(prefix + 'lastCheck', now, true);
                continue;
            }

            const grade = result.grade;
            const isGraded = !!grade && !UNGRADED_VALUES.includes(grade.toLowerCase());

            if (isGraded) {
                log(`Note für "${moduleName}" ist eingetragen: ${grade}`);
            } else {
                log(`Note für "${moduleName}" ist noch nicht eingetragen.`);
            }

            const prevState = await getStateAsync(prefix + 'graded');
            const wasGradedBefore = prevState ? prevState.val === true : false;

            if (isGraded && !wasGradedBefore) {
                log(`Neuer Notenstand für "${moduleName}" erkannt -> sende Pushover-Benachrichtigung.`);
                notify(`Note für ${moduleName} wurde eingetragen: ${grade}`);
            }

            await setStateAsync(prefix + 'grade', grade || '', true);
            await setStateAsync(prefix + 'graded', isGraded, true);
            await setStateAsync(prefix + 'lastCheck', now, true);

            if (moduleName === TARGET_MODULES[0]) {
                firstModuleGrade = { grade: grade || '', isGraded };
            }
        }

        // Ein Snapshot reicht, auch wenn mehrere Module gefehlt haben - es ist
        // dieselbe Seite.
        if (anyMissing) dumpDebug('module-not-found', gradesPage.body);

        // Alte Einzel-States weiterhin mit dem ersten Modul versorgen.
        if (firstModuleGrade) {
            await setStateAsync(STATE_PREFIX + 'lastGrade', firstModuleGrade.grade, true);
            await setStateAsync(STATE_PREFIX + 'lastGraded', firstModuleGrade.isGraded, true);
        }
        await setStateAsync(STATE_PREFIX + 'lastCheck', now, true);
    } catch (err) {
        log('Fehler beim Prüfen der Noten: ' + err.message, 'error');
    }
}

// ---------------------------------------------------------------------------
// Einstiegspunkt
// ---------------------------------------------------------------------------

(async () => {
    TARGET_MODULES = resolveTargetModules();
    STATE_IDS.clear();
    for (const [name, id] of buildStateIds(TARGET_MODULES)) STATE_IDS.set(name, id);

    if (TARGET_MODULES.length === 0) {
        log('CONFIG.targetModules ist leer - es wird nichts überwacht.', 'error');
        return;
    }

    await ensureStates();
    schedule(CONFIG.cronSchedule, () => checkGrades());
    log(
        `HSMW Noten-Scanner gestartet, Zeitplan: ${CONFIG.cronSchedule}, ` +
            `überwachte Module: ${TARGET_MODULES.join(', ')}`,
    );
    if (CONFIG.runOnScriptStart) {
        checkGrades();
    }
})();
