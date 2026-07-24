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
 * How the extension names the native host it wants to talk to.
 *
 * This is browser-specific in an annoying way, and it is the *only* browser-specific thing left in
 * the extension-side bridge — which is why it lives in its own module rather than buried in the
 * client (see plan/native-protocol.md → Addressing the host).
 *
 * - **Safari** has no registry. The host is the app extension that ships inside the containing app,
 *   and it is addressed by **bundle identifier**. The extension can learn its own from
 *   `chrome.runtime.id`, which Safari reports as the bundle id with the signing team appended in
 *   parentheses.
 * - **Firefox and Chrome** address the host by a **name the user's machine has registered**, in a
 *   native-messaging manifest under a well-known directory. `chrome.runtime.id` there is the
 *   extension's own id (a UUID, or `name@domain` on Firefox) and has nothing to do with the host.
 *
 * So the two cases need different strings, and the client tries every candidate until one answers.
 */

/**
 * The registered native-messaging host name, for browsers that use a manifest.
 *
 * A host installer for Linux/Windows writes a manifest whose `"name"` is exactly this, into (for
 * example) `~/.mozilla/native-messaging-hosts/dev.yomitan.engine.json`. Changing this constant means
 * changing that filename and its contents in lockstep, and every already-installed host stops being
 * found — so it is effectively permanent.
 * @type {string}
 */
export const REGISTERED_NATIVE_HOST_NAME = 'dev.yomitan.engine';

/**
 * A bundle identifier: reverse-DNS, optionally followed by ` (TEAMID)`.
 *
 * Used to decide whether `chrome.runtime.id` is worth deriving host ids from at all. A Firefox
 * extension id (`{8f2a…}` or `yomitan@example.com`) does not match, so those browsers skip straight
 * to the registered name instead of spending a failed round trip on a nonsense candidate.
 */
const BUNDLE_IDENTIFIER_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\s+\([^)]+\))?$/i;

/**
 * The host identifiers to try, in order.
 *
 * Ordered rather than sniffed-and-chosen: the client remembers whichever one answers, so a wrong
 * guess costs one failed call on the first lookup of a session and nothing afterwards. That is
 * cheaper than being clever, and it degrades correctly on a browser nobody has thought about yet.
 * @returns {string[]}
 */
export function getNativeHostCandidates() {
    /** @type {string[]} */
    const candidates = [];
    const runtimeId = typeof chrome !== 'undefined' ? chrome.runtime?.id : void 0;
    if (typeof runtimeId === 'string' && BUNDLE_IDENTIFIER_PATTERN.test(runtimeId)) {
        const bundleIdentifier = runtimeId.replace(/\s+\([^)]+\)$/, '');
        candidates.push(bundleIdentifier);
        // The app extension's id is the containing app's plus `.extension`. Which of the two answers
        // depends on how the app was packaged, so both are offered.
        if (bundleIdentifier.endsWith('.extension')) {
            candidates.push(bundleIdentifier.substring(0, bundleIdentifier.length - '.extension'.length));
        } else {
            candidates.push(`${bundleIdentifier}.extension`);
        }
    }
    candidates.push(REGISTERED_NATIVE_HOST_NAME);
    return [...new Set(candidates)];
}
