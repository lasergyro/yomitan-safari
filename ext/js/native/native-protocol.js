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
 * The wire format shared by both ends of the native bridge (plan/native-rewrite.md → The protocol).
 *
 * Both ends import this file: the extension-side client (`native-engine-client.js`) and the engine
 * that runs inside JavaScriptCore in the app (`native-core.js`). Keeping the encoders here is what
 * stops the two halves drifting — a shape only has to be taught to the bridge once.
 *
 * **Everything crosses as one JSON string.** Not a property-list dictionary of nested objects: the
 * only transport measurement we have (plan/native-engine-probe.md) timed a single flat string, and
 * its caveat #1 is that a plist of many rows may serialize very differently. Sending one string
 * keeps the measured numbers applicable, and moves the structural cost to `JSON.parse`, which is
 * fast and which we can profile in the browser. It also sidesteps plist's lack of a byte-array type
 * that survives `SFExtensionMessageKey` round-tripping intact.
 *
 * Binary therefore needs an encoding. `ArrayBuffer` payloads (dictionary media) are base64 — +33%
 * on a path that is already off the hover budget. See `encodeMediaResults`.
 */

/**
 * Envelope key for a successful call. Chosen so `('error' in response)` is an unambiguous test even
 * when the result itself is `undefined` (which `getMedia`'s callers never produce, but `optionsSet`
 * and friends will).
 * @type {string}
 */
export const RESULT_KEY = 'result';

/** @type {string} */
export const ERROR_KEY = 'error';

/**
 * Converts the enabled-dictionary set every query method takes into something JSON can carry.
 *
 * Two traps in one line. A `Map` or `Set` serializes to `{}` through `JSON.stringify` — *silently*,
 * so every lookup would return nothing rather than fail. And what callers actually pass is the
 * translator's `Map<string, FindTermDictionary>`, so spreading it directly would yield `[key, value]`
 * pairs, not names; `keys()` is what both shapes agree on.
 * @param {import('dictionary-database').DictionarySet} dictionaries
 * @returns {string[]}
 */
export function encodeDictionarySet(dictionaries) {
    return [...dictionaries.keys()];
}

/**
 * @param {unknown} value
 * @returns {import('dictionary-database').DictionarySet}
 */
export function decodeDictionarySet(value) {
    return new Set(Array.isArray(value) ? /** @type {string[]} */ (value) : []);
}

/**
 * Base64 for the engine side, where there is no `btoa` (JavaScriptCore has no `window`) and the
 * input is a `Uint8Array` rather than a binary string. Written against a lookup table because the
 * media path can carry a few hundred KB and per-byte string concatenation is measurably worse.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    const {length} = bytes;
    const limit = length - (length % 3);
    for (let i = 0; i < limit; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + alphabet[(n >>> 6) & 63] + alphabet[n & 63];
    }
    if (length - limit === 1) {
        const n = bytes[limit] << 16;
        out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + '==';
    } else if (length - limit === 2) {
        const n = (bytes[limit] << 16) | (bytes[limit + 1] << 8);
        out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + alphabet[(n >>> 6) & 63] + '=';
    }
    return out;
}

/**
 * The extension side runs in a browser, so it gets to use `atob`.
 * @param {string} text
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0, ii = binary.length; i < ii; ++i) { bytes[i] = binary.charCodeAt(i); }
    return bytes.buffer;
}

/**
 * Replaces each media result's `ArrayBuffer` content with base64 for the trip across the bridge.
 * Mutation is deliberate: these objects were built for this reply and are discarded with it, and
 * copying a few hundred KB of media twice to avoid touching them would be the expensive kind of
 * purity.
 * @param {import('dictionary-database').Media[]} results
 * @returns {import('native-bridge').EncodedMedia[]}
 */
export function encodeMediaResults(results) {
    /** @type {import('native-bridge').EncodedMedia[]} */
    const encoded = [];
    for (const media of results) {
        const {content, ...rest} = media;
        encoded.push({...rest, content: bytesToBase64(new Uint8Array(content))});
    }
    return encoded;
}

/**
 * @param {import('native-bridge').EncodedMedia[]} results
 * @returns {import('dictionary-database').Media[]}
 */
export function decodeMediaResults(results) {
    /** @type {import('dictionary-database').Media[]} */
    const decoded = [];
    for (const media of results) {
        const {content, ...rest} = media;
        decoded.push({...rest, content: base64ToArrayBuffer(content)});
    }
    return decoded;
}

/**
 * Flattens a thrown value into the envelope's error shape. `ExtensionError.serialize` is not used
 * here because the engine half runs in JavaScriptCore, where importing the extension's error module
 * would drag in `chrome`-aware code; the client re-inflates this into a real `Error` on arrival.
 * @param {unknown} error
 * @returns {import('native-bridge').SerializedError}
 */
export function serializeError(error) {
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
            stack: typeof error.stack === 'string' ? error.stack : void 0,
        };
    }
    return {message: `${error}`, name: 'Error'};
}

/**
 * @param {import('native-bridge').SerializedError} serialized
 * @returns {Error}
 */
export function deserializeError(serialized) {
    const error = new Error(serialized.message);
    if (typeof serialized.name === 'string') { error.name = serialized.name; }
    // Keep the engine's stack rather than the (useless) one from inside the transport, but mark
    // where the boundary was so a trace is not silently misread as browser-side.
    if (typeof serialized.stack === 'string') { error.stack = `${serialized.stack}\n    at <native bridge>`; }
    return error;
}
