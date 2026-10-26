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

//
// Loopback test bridge — DEV/TEST ONLY, and only ever present in a build made with
// `YOMITAN_TEST_BRIDGE=1 ./rebuild-safari.sh` (build-safari.sh injects the content-script entry that
// loads this file; a normal build never references it, so it cannot ship).
//
// Why this exists: the extension talks to its Safari app extension over `sendNativeMessage`, a seam
// neither vitest nor `test:jsc` can see because both run the engine outside Safari. Reaching *into*
// the extension from the outside is blocked by Safari's model — the `safari-web-extension://` origin
// rotates every launch and has no scriptable cold entry (DEV.md -> Driving the installed extension).
// So the extension reaches *out* instead: this content script — which runs in the extension's
// isolated world with `chrome.runtime`, and is injected only on `127.0.0.1`/`localhost` pages —
// long-polls the local runner (dev/bin/test-safari-e2e.js) for `{action, params}` commands and
// relays each to the background service worker, exactly as the real UI would. The service worker
// does the native round trip; the answer is POSTed back.
//
// A dependency-free classic content script (no module loader in content scripts), so it cannot use
// the bundle's `parseJson`/`readResponseJson` helpers; the few spots that touch raw JSON disable the
// module-oriented lint rules inline.
//

(() => {
    const host = location.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') { return; }

    const base = location.origin;

    /**
     * Relay one API message to the background service worker. Resolves with the backend's raw
     * envelope ({result} | {error}) so the runner unwraps it the same way the real `API` client does.
     * @param {string} action
     * @param {unknown} params
     * @returns {Promise<unknown>}
     */
    const invoke = (action, params) => new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({action, params}, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    resolve({error: {message: lastError.message || 'runtime error'}});
                } else {
                    resolve(response);
                }
            });
        } catch (e) {
            resolve({error: {message: (e instanceof Error) ? e.message : String(e)}});
        }
    });

    /**
     * @param {string} path
     * @param {unknown} body
     * @returns {Promise<Response>}
     */
    const post = (path, body) => fetch(base + path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });

    // --- audio playback probe (dev/bin/test-safari-audio.js) ------------------------------------
    // Unlike every other command, `audioProbe` is handled *in the page*, not relayed to the
    // background: it exercises the inline pop-up's off-page playback path (app/popup-inline.js ->
    // app/inline-audio-player-main.js) on this real third-party http origin, and reports objective
    // playback evidence. Three embeddings isolate the fix: the extension-origin player iframe WITH
    // `allow="autoplay"` (the pop-up), the same iframe WITHOUT it (what the bug was), and a top-level
    // clip in this host page (the search page's top-level context, as a baseline). A gesture-free run
    // cannot make *audible* autoplay succeed, so the probe plays muted and measures the pipeline plus
    // the Permissions-Policy `autoplay` effect.

    const playerUrl = chrome.runtime.getURL('/inline-audio-player.html');
    const playerOrigin = chrome.runtime.getURL('/').replace(/\/$/, '');
    let audioReqId = 0;

    /**
     * @param {string} b64
     * @returns {Uint8Array}
     */
    const base64ToBytes = (b64) => {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; ++i) { out[i] = bin.charCodeAt(i); }
        return out;
    };

    /**
     * @param {HTMLAudioElement} audio
     * @param {boolean} playPromiseResolved
     * @param {?Error} playError
     * @returns {object}
     */
    const mediaEvidence = (audio, playPromiseResolved, playError) => ({
        resolved: true,
        kind: 'audio',
        playPromiseResolved,
        playError: playError ? (playError.name || String(playError)) : null,
        paused: audio.paused,
        muted: audio.muted,
        currentTime: audio.currentTime,
        advanced: audio.currentTime > 0.01,
        duration: Number.isFinite(audio.duration) ? audio.duration : null,
        readyState: audio.readyState,
        mediaError: audio.error ? audio.error.code : null,
    });

    /**
     * Drives the real player iframe with or without the autoplay delegation.
     * @param {{term?: string, reading?: string, sources?: unknown[], language?: string, volume?: number, fallbackSoundType?: string, muted?: boolean}} p
     * @param {boolean} withAllow
     * @returns {Promise<object>}
     */
    const probeIframe = (p, withAllow) => new Promise((resolve) => {
        const embed = withAllow ? 'iframe-allow' : 'iframe-noallow';
        const iframe = document.createElement('iframe');
        if (withAllow) { iframe.allow = 'autoplay'; }
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;left:0;top:0;pointer-events:none;';
        iframe.src = playerUrl;
        const reqId = ++audioReqId;
        /** @type {string[]} */
        const seen = [];
        let done = false;
        const cleanup = () => {
            window.removeEventListener('message', onMessage);
            if (iframe.parentNode) { iframe.parentNode.removeChild(iframe); }
        };
        // Resolve either way — a timeout returns a diagnostic result (what messages arrived) instead of
        // throwing, so the runner can print where the handshake stalled.
        const timer = setTimeout(() => {
            if (done) { return; }
            done = true;
            cleanup();
            resolve({embed, played: false, evidence: null, timedOut: true, seen});
        }, 20000);
        /** @param {MessageEvent<unknown>} event */
        const onMessage = (event) => {
            // Match on the extension origin only (secure — no host page can forge it), not
            // `event.source === iframe.contentWindow`: that identity does not hold in Safari's isolated
            // content-script world, which silently dropped every message from the player.
            if (event.origin !== playerOrigin) { return; }
            const data = /** @type {{action?: string, message?: string, params?: {id?: number, played?: boolean, evidence?: unknown}}} */ (event.data);
            if (!data || typeof data !== 'object' || typeof data.action !== 'string') { return; }
            seen.push(data.action === 'inlineAudioPlayerError' ? `error:${data.message || ''}` : data.action);
            if (data.action === 'inlineAudioPlayerReady') {
                const params = {
                    id: reqId,
                    term: p.term || '',
                    reading: p.reading || '',
                    sources: p.sources || [],
                    language: p.language || '',
                    volume: typeof p.volume === 'number' ? p.volume : 100,
                    fallbackSoundType: p.fallbackSoundType || 'click',
                    muted: p.muted !== false,
                    probe: true,
                };
                if (iframe.contentWindow) { iframe.contentWindow.postMessage({action: 'play', params}, playerOrigin); }
            } else if (data.action === 'inlineAudioPlayerPlayed' && data.params && data.params.id === reqId) {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                cleanup();
                resolve({embed, played: !!data.params.played, evidence: data.params.evidence || null, seen});
            }
        };
        window.addEventListener('message', onMessage, false);
        iframe.addEventListener('load', () => { seen.push('iframe:load'); }, {once: true});
        iframe.addEventListener('error', () => { seen.push('iframe:error'); }, {once: true});
        document.documentElement.appendChild(iframe);
    });

    /**
     * Plays a runner-supplied clip in this host page's top-level context — the baseline the search
     * page (a top-level page) represents.
     * @param {{dataBase64?: string, contentType?: string, muted?: boolean}} p
     * @returns {Promise<object>}
     */
    const probeTopLevel = (p) => new Promise((resolve, reject) => {
        let url = '';
        try {
            const blob = new Blob([base64ToBytes(p.dataBase64 || '')], {type: p.contentType || 'audio/wav'});
            url = URL.createObjectURL(blob);
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }
        const audio = new Audio(url);
        audio.muted = p.muted !== false;
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) { return; }
            settled = true; URL.revokeObjectURL(url);
            reject(new Error('audioProbe top timed out'));
        }, 20000);
        audio.addEventListener('loadeddata', () => {
            let playPromiseResolved = false;
            /** @type {?Error} */
            let playError = null;
            const finish = () => {
                setTimeout(() => {
                    if (settled) { return; }
                    settled = true; clearTimeout(timer);
                    const evidence = mediaEvidence(audio, playPromiseResolved, playError);
                    URL.revokeObjectURL(url);
                    resolve({embed: 'top', played: true, evidence});
                }, 350);
            };
            const pr = audio.play();
            if (pr && typeof pr.then === 'function') {
                pr.then(
                    () => { playPromiseResolved = true; finish(); },
                    (e) => { playError = e instanceof Error ? e : new Error(String(e)); finish(); },
                );
            } else {
                playPromiseResolved = true;
                finish();
            }
        }, {once: true});
        audio.addEventListener('error', () => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            reject(new Error('top-level audio failed to load'));
        }, {once: true});
    });

    /**
     * @param {unknown} rawParams
     * @returns {Promise<{result?: unknown, error?: {message: string}}>}
     */
    const handleAudioProbe = async (rawParams) => {
        const p = /** @type {{embed?: string, term?: string, reading?: string, sources?: unknown[], language?: string, volume?: number, fallbackSoundType?: string, muted?: boolean, dataBase64?: string, contentType?: string}} */ (rawParams || {});
        try {
            const result = p.embed === 'top' ? await probeTopLevel(p) : await probeIframe(p, p.embed === 'iframe-allow');
            return {result};
        } catch (e) {
            return {error: {message: (e instanceof Error) ? e.message : String(e)}};
        }
    };

    /** @returns {void} */
    const loop = () => {
        fetch(base + '/e2e/next')
            .then((response) => (response.status === 204 ? null : response.text()))
            .then((text) => {
                // 204 / empty body: the long-poll timed out with no command; just poll again.
                // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-unsafe-assignment
                const command = /** @type {?{id: number, action: string, params: unknown}} */ (text ? JSON.parse(text) : null);
                if (!command) {
                    loop();
                    return;
                }
                // `audioProbe` is handled in-page (playback needs the DOM); everything else relays to
                // the background service worker.
                const handled = command.action === 'audioProbe' ?
                    handleAudioProbe(command.params) :
                    invoke(command.action, command.params);
                void Promise.resolve(handled).then((envelope) => {
                    post('/e2e/result', {id: command.id, response: envelope}).then(loop, () => { setTimeout(loop, 1000); });
                });
            })
            .catch(() => {
                // The runner exits when done (connection refused); back off and retry so a later run
                // finds a live bridge without reloading the tab.
                setTimeout(loop, 1000);
            });
    };

    post('/e2e/hello', {href: location.href, extensionId: (chrome.runtime && chrome.runtime.id) || null})
        .then(loop, () => { setTimeout(loop, 1000); });
})();
