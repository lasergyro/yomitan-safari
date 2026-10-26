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
 * Automated check that the Safari inline pop-up can actually play audio — the one path
 * `test:safari:e2e` cannot see, because playback is DOM-bound and the inline pop-up plays off-page
 * (app/popup-inline.js -> a hidden extension-origin app/inline-audio-player.html iframe). See
 * plan/audio-service.md -> "Built: audio in the inline pop-up, played off-page".
 *
 * Like `test:safari:e2e`, it uses the build-gated loopback bridge (ext/js/native/loopback-test-bridge.js,
 * present only in a `YOMITAN_TEST_BRIDGE=1 ./rebuild-safari.sh` build) on a real `http://127.0.0.1`
 * origin. The bridge runs an in-page `audioProbe` that drives the real player code in three
 * embeddings and reports objective playback evidence:
 *
 *   - `iframe-allow`   the extension-origin player iframe WITH `allow="autoplay"` — the pop-up itself.
 *   - `iframe-noallow` the same iframe WITHOUT it — what the bug was; the A/B that shows the fix bites.
 *   - `top`            a clip in the host page's top-level context — the search page's top-level baseline.
 *
 * What it can and cannot prove: a script-driven run carries no user gesture, and Safari blocks
 * audible autoplay without one — so the probe plays muted (muted autoplay does not need a gesture) and
 * machine-verifies the whole off-page pipeline (source resolution, the blob loading under the
 * extension's CSP inside the injected cross-origin iframe) plus that playback actually starts and
 * progresses in the pop-up's exact configuration. It also runs each embedding unmuted and reports the
 * result, but does not assert on it: confirming audible sound from a real click stays a human listening
 * test (DEV.md -> Driving the installed extension). The muted A/B across embeddings is printed so a
 * regression in the `allow` delegation is visible.
 *
 * Usage: `node dev/bin/test-safari-audio.js`. Env: PORT (8732), TIMEOUT_MS (60000), AUDIO_TERM (Schützen),
 * LANGUAGE (de).
 */

import {spawn} from 'child_process';
import http from 'http';
import {parseJson} from '../json.js';

const PORT = Number(process.env.PORT || 8732);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);
const AUDIO_TERM = process.env.AUDIO_TERM || 'Schützen';
const LANGUAGE = process.env.LANGUAGE || 'de';

/**
 * @typedef {{id: number, action: string, params: unknown}} BridgeCommand
 * @typedef {{result?: unknown, error?: {message?: string}}} BridgeEnvelope
 * @typedef {{resolved: boolean, kind: string, playPromiseResolved: boolean, playError: string | null, paused: boolean, muted: boolean, currentTime: number, advanced: boolean, duration: number | null, readyState: number | null, mediaError: number | null}} Evidence
 * @typedef {{embed: string, played: boolean, evidence: Evidence | null, timedOut?: boolean, seen?: string[]}} ProbeResult
 */

// --- the loopback command channel (same shape as test-safari-e2e.js) ----------------------------

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

/** @returns {void} */
function dispatchQueued() {
    while (commandQueue.length > 0 && waitingPollers.length > 0) {
        const poller = /** @type {(command: BridgeCommand) => void} */ (waitingPollers.shift());
        const command = /** @type {BridgeCommand} */ (commandQueue.shift());
        poller(command);
    }
}

/**
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
            const env = envelope || {};
            if (typeof env.error !== 'undefined') {
                reject(new Error(`${action}: ${env.error.message || JSON.stringify(env.error)}`));
            } else if (typeof env.result === 'undefined') {
                reject(new Error(`${action}: empty response envelope (${JSON.stringify(envelope)}) — the background handler returned nothing`));
            } else {
                resolve(env.result);
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

const harnessHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Yomitan audio probe</title></head><body><p>Yomitan Safari inline-pop-up audio probe. This tab is driven by dev/bin/test-safari-audio.js.</p></body></html>';

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

/** @returns {Promise<import('http').Server>} */
function startServer() {
    const server = http.createServer((request, response) => { void handleRequest(request, response); });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => { resolve(server); });
    });
}

// --- reporting ----------------------------------------------------------------------------------

/**
 * @param {string} message
 * @returns {void}
 */
function log(message) { process.stdout.write(`${message}\n`); }

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
 * @param {ProbeResult} result
 * @param {boolean} muted
 * @returns {string}
 */
function row(result, muted) {
    const e = result.evidence;
    const cell = (/** @type {string | number | boolean | null} */ v) => String(v ?? '·').padEnd(6);
    const embed = result.embed.padEnd(15);
    if (e === null) {
        const why = result.timedOut ? `TIMED OUT — messages seen: [${(result.seen || []).join(', ') || 'none'}]` : `(no evidence — played=${result.played})`;
        return `    ${embed} ${(muted ? 'muted' : 'audible').padEnd(8)} ${why}`;
    }
    return `    ${embed} ${(muted ? 'muted' : 'audible').padEnd(8)} resolved=${cell(e.resolved)} play()=${cell(e.playPromiseResolved)} advanced=${cell(e.advanced)} paused=${cell(e.paused)} ready=${cell(e.readyState)} mediaErr=${cell(e.mediaError)} err=${e.playError ?? '·'}`;
}

// --- the probe ----------------------------------------------------------------------------------

/**
 * @param {string} embed
 * @param {boolean} muted
 * @param {{sources: unknown[], clip: {data: string, contentType: string | null}}} ctx
 * @returns {Promise<ProbeResult>}
 */
async function probe(embed, muted, ctx) {
    /** @type {Record<string, unknown>} */
    const params = embed === 'top' ?
        {embed, muted, dataBase64: ctx.clip.data, contentType: ctx.clip.contentType} :
        {embed, muted, term: AUDIO_TERM, reading: '', sources: ctx.sources, language: LANGUAGE};
    return /** @type {ProbeResult} */ (await send('audioProbe', params));
}

/** @returns {Promise<void>} */
async function main() {
    if (process.platform !== 'darwin') { throw new Error('This runner drives Safari and only runs on macOS.'); }

    const server = await startServer();
    log(`==> serving the probe on http://127.0.0.1:${PORT}/`);

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

        // A deterministic, network-independent fixture: native TTS. Pick a German voice if present.
        log('==> resolving a TTS fixture (native render, no network)');
        const voices = /** @type {{id: string, language: string}[]} */ (await send('getTextToSpeechVoices'));
        if (!Array.isArray(voices) || voices.length === 0) { throw new Error('getTextToSpeechVoices returned nothing — is the appex reachable?'); }
        const localeVoice = voices.find((v) => typeof v.language === 'string' && v.language.toLowerCase().startsWith(LANGUAGE.toLowerCase()));
        const voiceId = localeVoice ? localeVoice.id : voices[0].id;
        /** @type {unknown[]} */
        const sources = [{type: 'text-to-speech', url: '', voice: voiceId}];
        const clip = /** @type {{data: string, contentType: string | null}} */ (await send('getTextToSpeechAudio', {text: AUDIO_TERM, voice: voiceId, language: LANGUAGE}));
        check(`native TTS fixture rendered (${typeof clip.data === 'string' ? clip.data.length : 0} b64 chars, voice ${JSON.stringify(voiceId)})`, typeof clip.data === 'string' && clip.data.length > 0);

        const ctx = {sources, clip};
        const embeddings = ['iframe-allow', 'iframe-noallow', 'top'];

        log('==> probing playback (muted — the machine-checkable pipeline + autoplay-policy signal)');
        /** @type {Record<string, ProbeResult>} */
        const mutedResults = {};
        for (const embed of embeddings) {
            mutedResults[embed] = await probe(embed, true, ctx);
            log(row(mutedResults[embed], true));
        }

        log('==> probing playback (audible — reported only; gesture-free audible autoplay is expected to be blocked)');
        /** @type {Record<string, ProbeResult>} */
        const audibleResults = {};
        for (const embed of embeddings) {
            audibleResults[embed] = await probe(embed, false, ctx);
            log(row(audibleResults[embed], false));
        }

        // Assertions — the pop-up's exact configuration (iframe WITH allow), played muted.
        log('==> asserting the inline pop-up path (iframe-allow, muted)');
        const allow = mutedResults['iframe-allow'];
        const ae = allow.evidence;
        check('the player resolved a source (getTermAudioInfoList -> bytes)', allow.played && ae !== null && ae.resolved);
        check('the blob loaded under the extension CSP in the injected cross-origin iframe (readyState>=2, no mediaError)', ae !== null && (ae.readyState ?? 0) >= 2 && ae.mediaError === null);
        check('muted playback started — allow="autoplay" honored on the content-script-injected iframe (play() resolved, not paused)', ae !== null && ae.playPromiseResolved && !ae.paused);
        check('muted playback progressed (currentTime advanced)', ae !== null && ae.advanced);

        // Informational A/B: does removing allow actually change the outcome on this WebKit?
        log('==> A/B (informational): does allow="autoplay" change the muted outcome?');
        const noallow = mutedResults['iframe-noallow'];
        const ne = noallow.evidence;
        const allowPlays = ae !== null && ae.playPromiseResolved && ae.advanced;
        const noallowPlays = ne !== null && ne.playPromiseResolved && ne.advanced;
        if (allowPlays && !noallowPlays) {
            log('    allow="autoplay" is load-bearing here: muted playback starts WITH it and not without — the fix is confirmed necessary.');
        } else if (allowPlays && noallowPlays) {
            log('    NOTE: this WebKit also plays muted audio in a cross-origin iframe WITHOUT allow, so the muted probe cannot prove the attribute is required. It is still required for the real audible case (needs a listening test); allow does no harm.');
        } else {
            log('    NOTE: muted playback did not start even WITH allow — investigate before trusting the audible path (see the audible rows above and the player evidence).');
        }
    } finally {
        server.close();
    }

    log('');
    log(`==> ${passed}/${passed + failed} checks passed`);
    log('    (audible playback from a real click is not machine-checkable and stays a listening test:');
    log('     DEV.md -> Driving the installed extension.)');
    if (failed > 0) { process.exitCode = 1; }
}

main().catch((error) => {
    log(`\nERROR: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
});
