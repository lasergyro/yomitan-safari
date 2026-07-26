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
                void invoke(command.action, command.params).then((envelope) => {
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
