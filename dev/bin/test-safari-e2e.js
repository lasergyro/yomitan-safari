/*
 * Copyright (C) 2025  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * End-to-end check of the *installed* Safari extension talking to its app extension
 * (plan/native-rewrite.md → Testing, layer 4).
 *
 * vitest and `test:jsc` both run the engine outside Safari, so neither can see the extension's
 * `sendNativeMessage` seam. This runner does, without needing a scriptable entry into the rotating
 * `safari-web-extension://` origin: the extension reaches *out*. A build made with
 * `YOMITAN_TEST_BRIDGE=1 ./rebuild-safari.sh` carries a content-script bridge
 * (ext/js/native/loopback-test-bridge.js) that runs only on 127.0.0.1/localhost; this server opens a
 * background loopback tab (`open -g`), the bridge long-polls it for `{action, params}` commands and
 * relays each to the background service worker, and the answers — native round trip and all — come
 * back here.
 *
 * What it proves, in order: the appex answers and reads the installed database (getDictionaryInfo);
 * a settings write crosses the bridge and lands in options.json in the container (registering the
 * dictionary — the options-save seam from plan/decisions.md #52); and a real lookup deinflects
 * natively over the bridge (geschützt → schützen). It restores the options and database it found.
 *
 * Usage: `node dev/bin/test-safari-e2e.js --database <compiled.sqlite3>`. Omit `--database` to test
 * whatever is already installed (the lookup step then needs a German dictionary already present).
 * Env: PORT (8731), BUNDLE_ID (dev.yomitan.safari.extension), TIMEOUT_MS (60000), KEEP (leave the
 * installed dictionary and its registration in place instead of restoring).
 */

import {execFile, spawn} from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {parseJson} from '../json.js';

const PORT = Number(process.env.PORT || 8731);
const BUNDLE_ID = process.env.BUNDLE_ID || 'dev.yomitan.safari.extension';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);
const KEEP = typeof process.env.KEEP !== 'undefined';
const APPEX_PROCESS = 'Yomitan Safari Extension.appex';
const LOOKUP_TERM = 'geschützt';
const EXPECTED_HEADWORD = 'schützen';

const containerDir = path.join(os.homedir(), 'Library/Containers', BUNDLE_ID, 'Data/Library/Application Support/Yomitan');
const databasePath = path.join(containerDir, 'dictionaries.sqlite3');
const optionsPath = path.join(containerDir, 'options.json');

/**
 * @typedef {{id: number, action: string, params: unknown}} BridgeCommand
 * @typedef {{result?: unknown, error?: {message?: string}}} BridgeEnvelope
 */

/**
 * @param {string[]} argv
 * @returns {{database: ?string}}
 * @throws {Error} When an argument is not recognized.
 */
function parseArguments(argv) {
    /** @type {?string} */
    let database = null;
    for (let i = 0; i < argv.length; ++i) {
        if (argv[i] === '--database') {
            database = path.resolve(argv[++i]);
        } else {
            throw new Error(`Unknown argument: ${argv[i]}`);
        }
    }
    return {database};
}

// --- the loopback command channel ---------------------------------------------------------------

/** @type {BridgeCommand[]} */
const commandQueue = [];
/** @type {((command: BridgeCommand) => void)[]} */
const waitingPollers = [];
/** @type {Map<number, (envelope: BridgeEnvelope) => void>} */
const pendingResults = new Map();
let nextId = 1;
/** @type {?(info: unknown) => void} */
let helloResolve = null;
/** @type {Promise<unknown>} */
const helloPromise = new Promise((resolve) => { helloResolve = resolve; });
/** @type {?{extensionId?: ?string, href?: string}} */
let bridgeInfo = null;

/** Hand any queued commands to any parked long-polls. */
function dispatchQueued() {
    while (commandQueue.length > 0 && waitingPollers.length > 0) {
        const poller = /** @type {(command: BridgeCommand) => void} */ (waitingPollers.shift());
        const command = /** @type {BridgeCommand} */ (commandQueue.shift());
        poller(command);
    }
}

/**
 * Send one API action to the extension's background over the bridge and return its unwrapped result.
 * @param {string} action
 * @param {unknown} [params]
 * @returns {Promise<unknown>}
 */
function send(action, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingResults.delete(id);
            reject(new Error(`Bridge timed out waiting for "${action}"`));
        }, TIMEOUT_MS);
        pendingResults.set(id, (envelope) => {
            clearTimeout(timer);
            if (typeof envelope.error !== 'undefined') {
                reject(new Error(`${action}: ${envelope.error.message || JSON.stringify(envelope.error)}`));
            } else {
                resolve(envelope.result);
            }
        });
        commandQueue.push({id, action, params});
        dispatchQueued();
    });
}

/**
 * @param {import('http').IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
    return new Promise((resolve) => {
        /** @type {Buffer[]} */
        const chunks = [];
        request.on('data', (chunk) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const buffer = /** @type {Buffer} */ (chunk);
            chunks.push(buffer);
        });
        request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
}

const harnessHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Yomitan E2E bridge</title></head><body><p>Yomitan Safari end-to-end bridge. This tab is driven by dev/bin/test-safari-e2e.js.</p></body></html>';

/**
 * @param {import('http').IncomingMessage} request
 * @param {import('http').ServerResponse} response
 * @returns {Promise<void>}
 */
async function handleRequest(request, response) {
    const {method, url} = request;
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        response.end(harnessHtml);
        return;
    }
    if (method === 'POST' && url === '/e2e/hello') {
        bridgeInfo = /** @type {{extensionId?: ?string, href?: string}} */ (parseJson((await readBody(request)) || '{}'));
        if (helloResolve !== null) { helloResolve(bridgeInfo); }
        response.writeHead(200);
        response.end('ok');
        return;
    }
    if (method === 'GET' && url === '/e2e/next') {
        // Long-poll: hand over a queued command, or park until one arrives / the poll times out.
        let settled = false;
        /** @param {BridgeCommand} command */
        const deliver = (command) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(idle);
            response.writeHead(200, {'Content-Type': 'application/json'});
            response.end(JSON.stringify(command));
        };
        const idle = setTimeout(() => {
            if (settled) { return; }
            settled = true;
            const index = waitingPollers.indexOf(deliver);
            if (index >= 0) { waitingPollers.splice(index, 1); }
            response.writeHead(204);
            response.end();
        }, 25000);
        waitingPollers.push(deliver);
        dispatchQueued();
        return;
    }
    if (method === 'POST' && url === '/e2e/result') {
        const payload = /** @type {{id: number, response: BridgeEnvelope}} */ (parseJson((await readBody(request)) || '{}'));
        const resolve = pendingResults.get(payload.id);
        if (typeof resolve !== 'undefined') {
            pendingResults.delete(payload.id);
            resolve(payload.response);
        }
        response.writeHead(200);
        response.end('ok');
        return;
    }
    response.writeHead(404);
    response.end('not found');
}

/**
 * @returns {Promise<import('http').Server>}
 */
function startServer() {
    const server = http.createServer((request, response) => { void handleRequest(request, response); });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => { resolve(server); });
    });
}

// --- helpers ------------------------------------------------------------------------------------

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function run(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

/**
 * @param {string} message
 * @returns {void}
 */
function log(message) {
    process.stdout.write(`${message}\n`);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @returns {void}
 */
function check(label, condition) {
    if (condition) {
        passed++;
        log(`    ok   ${label}`);
    } else {
        failed++;
        log(`    FAIL ${label}`);
    }
}

/**
 * The entry `DictionaryController.createDefaultDictionarySettings` builds, inlined so registration
 * needs no page.
 * @param {string} name
 * @param {boolean} enabled
 * @param {string} styles
 * @returns {{name: string, alias: string, enabled: boolean, allowSecondarySearches: boolean, definitionsCollapsible: string, partsOfSpeechFilter: boolean, useDeinflections: boolean, styles: string}}
 */
function createDefaultDictionarySettings(name, enabled, styles) {
    return {name, alias: name, enabled, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: true, useDeinflections: true, styles};
}

// --- the test -----------------------------------------------------------------------------------

/**
 * @returns {Promise<void>}
 */
async function main() {
    const {database} = parseArguments(process.argv.slice(2));

    if (process.platform !== 'darwin') { throw new Error('This runner drives Safari and only runs on macOS.'); }
    if (!fs.existsSync(containerDir)) { throw new Error(`No app-extension container at ${containerDir} — build and install the extension first (./rebuild-safari.sh).`); }

    // Install the compiled database, remembering what was there so it can be put back.
    /** @type {?string} */
    let databaseBackup = null;
    if (database !== null) {
        if (!fs.existsSync(database)) { throw new Error(`--database not found: ${database}`); }
        log(`==> installing ${path.basename(database)} into the container`);
        if (fs.existsSync(databasePath)) {
            databaseBackup = path.join(os.tmpdir(), `yomitan-e2e-db-backup-${Date.now()}.sqlite3`);
            fs.copyFileSync(databasePath, databaseBackup);
        }
        fs.mkdirSync(containerDir, {recursive: true});
        fs.copyFileSync(database, databasePath);
        // The appex caches an open handle to the old file; terminate it so the next call cold-starts
        // against the newly installed database.
        await run('pkill', ['-f', APPEX_PROCESS]).catch(() => {});
    }

    const server = await startServer();
    log(`==> serving the bridge on http://127.0.0.1:${PORT}/`);

    /** @type {?unknown} */
    let originalOptions = null;
    let restored = false;
    /** @returns {Promise<void>} */
    const restore = async () => {
        if (restored) { return; }
        restored = true;
        if (!KEEP && originalOptions !== null) {
            log('==> restoring options');
            await send('setAllSettings', {value: originalOptions, source: 'e2e-restore'}).catch((e) => { log(`    (options restore failed: ${e.message})`); });
        }
        if (!KEEP && databaseBackup !== null) {
            log('==> restoring the previous database');
            try {
                fs.copyFileSync(databaseBackup, databasePath);
                fs.unlinkSync(databaseBackup);
            } catch (e) {
                log(`    (database restore failed: ${/** @type {Error} */ (e).message})`);
            }
            await run('pkill', ['-f', APPEX_PROCESS]).catch(() => {});
        }
    };

    try {
        log('==> opening a background loopback tab in Safari (open -g)');
        spawn('open', ['-g', '-a', 'Safari', `http://127.0.0.1:${PORT}/`], {stdio: 'ignore'});

        log('==> waiting for the extension bridge to connect');
        /** @type {Promise<never>} */
        const helloTimeout = new Promise((resolve, reject) => {
            setTimeout(() => {
                reject(new Error('The bridge never connected. Check that the extension is enabled in Safari, that it was built with YOMITAN_TEST_BRIDGE=1 ./rebuild-safari.sh, and that Safari has host access to 127.0.0.1.'));
            }, TIMEOUT_MS);
        });
        await Promise.race([helloPromise, helloTimeout]);
        log(`    connected (extension id ${bridgeInfo !== null ? bridgeInfo.extensionId : null})`);

        // 1. The appex answers and reads the installed database.
        log('==> 1. database read seam (getDictionaryInfo)');
        await send('triggerDatabaseUpdated', {type: 'dictionary', cause: 'import'}).catch(() => {});
        const info = /** @type {{title: string, styles?: string}[]} */ (await send('getDictionaryInfo'));
        const titles = info.map((d) => d.title);
        check(`getDictionaryInfo lists a dictionary (${JSON.stringify(titles)})`, info.length > 0);
        if (info.length === 0) { throw new Error('No dictionary is installed; nothing to look up.'); }
        const summary = info[0];

        // 2. A settings write crosses the bridge into options.json (the options-save seam, #52).
        log('==> 2. options save seam (register the dictionary)');
        originalOptions = await send('optionsGetFull');
        const full = /** @type {{profiles: {options: {dictionaries: {name: string}[]}}[]}} */ (await send('optionsGetFull'));
        // Each target carries scope:'global'/optionsContext:null, exactly what the settings UI's
        // `modifyGlobalSettings` merges in before it reaches the backend (settings-controller.js).
        /** @type {{action: string, path: string, items: unknown[], scope: string, optionsContext: null}[]} */
        const targets = [];
        for (let i = 0; i < full.profiles.length; ++i) {
            const already = full.profiles[i].options.dictionaries.some((d) => d.name === summary.title);
            if (!already) {
                targets.push({action: 'push', path: `profiles[${i}].options.dictionaries`, items: [createDefaultDictionarySettings(summary.title, true, summary.styles ?? '')], scope: 'global', optionsContext: null});
            }
        }
        if (targets.length > 0) {
            const results = /** @type {{error?: unknown}[]} */ (await send('modifySettings', {targets, source: 'e2e'}));
            const targetErrors = Array.isArray(results) ? results.filter((r) => typeof r.error !== 'undefined') : [];
            if (targetErrors.length > 0) { log(`    (modifySettings reported target errors: ${JSON.stringify(targetErrors)})`); }
        }
        // The write is async on the host's queue; give the atomic rename a beat, then read the file.
        await delay(500);
        check('options.json now exists in the container', fs.existsSync(optionsPath));
        /** @type {?{profiles: {options: {dictionaries: {name: string}[]}}[]}} */
        let optionsOnDisk = null;
        try {
            optionsOnDisk = /** @type {{profiles: {options: {dictionaries: {name: string}[]}}[]}} */ (parseJson(fs.readFileSync(optionsPath, 'utf8')));
        } catch (e) {
            optionsOnDisk = null;
        }
        const registered = optionsOnDisk !== null && Array.isArray(optionsOnDisk.profiles) &&
        optionsOnDisk.profiles.some((p) => p.options.dictionaries.some((d) => d.name === summary.title));
        check(`options.json on disk records the dictionary (${summary.title})`, registered);

        // 3. A real lookup deinflects natively over the bridge.
        log(`==> 3. lookup + deinflection seam (${LOOKUP_TERM} → ${EXPECTED_HEADWORD})`);
        const result = /** @type {{dictionaryEntries: {headwords: {term: string}[]}[]}} */ (await send('termsFind', {text: LOOKUP_TERM, details: {}, optionsContext: {current: true}}));
        /** @type {string[]} */
        const headwords = [];
        for (const entry of result.dictionaryEntries) {
            for (const headword of entry.headwords) { headwords.push(headword.term); }
        }
        check(`"${LOOKUP_TERM}" yields "${EXPECTED_HEADWORD}" (got ${JSON.stringify([...new Set(headwords)])})`, headwords.includes(EXPECTED_HEADWORD));

        // 4. Native TTS: the voice list and a rendered clip both cross the bridge (the ttsVoices /
        // ttsSynthesize host actions → AVSpeechSynthesizer). This covers the native round trip, not
        // the display's blob playback, which is DOM and outside this runner's reach.
        log('==> 4. native TTS seam (voices + synthesize)');
        const voices = /** @type {{id: string, name: string, language: string, quality: string}[]} */ (await send('getTextToSpeechVoices'));
        check(`getTextToSpeechVoices returns voices (${Array.isArray(voices) ? voices.length : 'none'})`, Array.isArray(voices) && voices.length > 0);
        const germanVoice = Array.isArray(voices) ? voices.find((v) => typeof v.language === 'string' && v.language.toLowerCase().startsWith('de')) : null;
        const voiceId = germanVoice ? germanVoice.id : (Array.isArray(voices) && voices.length > 0 ? voices[0].id : '');
        const clip = /** @type {{data: string, contentType: string | null}} */ (await send('getTextToSpeechAudio', {text: EXPECTED_HEADWORD, voice: voiceId, language: 'de'}));
        const clipBytes = typeof clip.data === 'string' ? clip.data.length : 0;
        check(`getTextToSpeechAudio renders a clip (${clipBytes} b64 chars, ${clip.contentType}, voice ${JSON.stringify(voiceId)})`, clipBytes > 0);

        await restore();
    } finally {
        await restore().catch(() => {});
        server.close();
    }

    log('');
    log(`==> ${passed}/${passed + failed} checks passed`);
    if (failed > 0) { process.exitCode = 1; }
}

main().catch((error) => {
    log(`\nERROR: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
});
