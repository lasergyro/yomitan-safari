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

import {parseJson} from '../core/json.js';
import {bytesToBase64} from './native-protocol.js';

/**
 * The web-platform surface the *audio downloader* needs but bare JavaScriptCore does not provide.
 *
 * The dictionary engine reached for almost none of this — `TextEncoder`/`TextDecoder`, `console`,
 * `setTimeout` were enough (native-core-main.js). Audio is different: `audio-downloader.js` is
 * upstream code that assumes a browser, so hosting it unmodified (route C — plan/native-rewrite.md)
 * means supplying `URL`, `URLSearchParams`, `crypto.subtle.digest` and `AbortController`. Each is
 * kept as small as the one file's usage allows, and the two that are easy to get subtly wrong —
 * relative-URL resolution and SHA-256 — are delegated to native code that is correct by
 * construction (`host.resolveUrl`, `host.sha256`), rather than reimplemented here. The
 * `npm run test:jsc` gate answers the same audio requests through node's *real* URL/crypto and
 * through these shims and requires identical results, so a divergence is caught rather than shipped.
 *
 * Not shimmed: a global `fetch` and `chrome.runtime` (only `custom-json`'s schema fetch wants them;
 * that source degrades to "no audio" in the engine until it is handled deliberately, rather than
 * dragging a `chrome` object into a process that is not an extension).
 */

/** @type {?Int16Array} Reverse base64 lookup, built once on first decode. */
let base64Lookup = null;

/**
 * A JSC-safe base64 decoder — there is no `atob` in bare JavaScriptCore.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
    if (base64Lookup === null) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        base64Lookup = new Int16Array(128).fill(-1);
        for (let i = 0; i < alphabet.length; ++i) { base64Lookup[alphabet.charCodeAt(i)] = i; }
    }
    const lookup = base64Lookup;
    const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
    const length = Math.floor((clean.length * 3) / 4);
    const bytes = new Uint8Array(length);
    let outIndex = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const c0 = lookup[clean.charCodeAt(i)];
        const c1 = lookup[clean.charCodeAt(i + 1)];
        const c2 = lookup[clean.charCodeAt(i + 2)];
        const c3 = lookup[clean.charCodeAt(i + 3)];
        const n = (c0 << 18) | (c1 << 12) | ((c2 & 63) << 6) | (c3 & 63);
        if (outIndex < length) { bytes[outIndex++] = (n >>> 16) & 0xff; }
        if (c2 >= 0 && outIndex < length) { bytes[outIndex++] = (n >>> 8) & 0xff; }
        if (c3 >= 0 && outIndex < length) { bytes[outIndex++] = n & 0xff; }
    }
    return bytes;
}

/**
 * The `application/x-www-form-urlencoded` byte serializer from the URL spec, so a shimmed
 * `URLSearchParams.toString()` matches what node's real one produces for the same pairs — including
 * Japanese query terms, where every UTF-8 byte is percent-encoded.
 * @param {[string, string][]} pairs
 * @returns {string}
 */
function formUrlencode(pairs) {
    const encoder = new TextEncoder();
    /**
     * @param {string} value
     * @returns {string}
     */
    const encode = (value) => {
        let out = '';
        for (const b of encoder.encode(value)) {
            if (b === 0x20) {
                out += '+';
            } else if (
                b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f ||
                (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
            ) {
                out += String.fromCharCode(b);
            } else {
                out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
            }
        }
        return out;
    };
    return pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}

/**
 * `URLSearchParams`, reduced to what the audio downloader uses: build from nothing or a plain
 * object, `set`, and `toString`. The serializer is the spec's, so it agrees with node's byte for
 * byte.
 */
class NativeUrlSearchParams {
    /** @param {string|Record<string, string>|[string, string][]} [init] */
    constructor(init) {
        /** @type {[string, string][]} */
        this._pairs = [];
        if (typeof init === 'string') {
            for (const part of init.replace(/^\?/, '').split('&')) {
                if (part.length === 0) { continue; }
                const eq = part.indexOf('=');
                const key = eq < 0 ? part : part.slice(0, eq);
                const value = eq < 0 ? '' : part.slice(eq + 1);
                this._pairs.push([decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' '))]);
            }
        } else if (Array.isArray(init)) {
            for (const [key, value] of init) { this._pairs.push([`${key}`, `${value}`]); }
        } else if (init !== null && typeof init === 'object') {
            for (const key of Object.keys(init)) { this._pairs.push([key, `${init[/** @type {keyof typeof init} */ (key)]}`]); }
        }
    }

    /**
     * @param {string} key
     * @param {string} value
     */
    set(key, value) {
        this._pairs = this._pairs.filter(([existing]) => existing !== key);
        this._pairs.push([key, `${value}`]);
    }

    /**
     * @param {string} key
     * @param {string} value
     */
    append(key, value) {
        this._pairs.push([key, `${value}`]);
    }

    /**
     * @param {string} key
     * @returns {?string}
     */
    get(key) {
        for (const [existing, value] of this._pairs) {
            if (existing === key) { return value; }
        }
        return null;
    }

    /** @returns {string} */
    toString() {
        return formUrlencode(this._pairs);
    }
}

/**
 * `new URL(url, base).href` and nothing else — the audio downloader only ever reads `.href`, to
 * turn a relative audio `src` into an absolute one. The resolution itself is native
 * (`host.resolveUrl`), so it matches the browser rather than approximating it.
 * @param {import('native-bridge').NativeHost} host
 * @returns {typeof URL}
 */
function makeUrlShim(host) {
    class NativeUrl {
        /**
         * @param {string} url
         * @param {string} [base]
         */
        constructor(url, base) {
            /** @type {string} */
            this.href = host.resolveUrl(`${url}`, typeof base === 'undefined' || base === null ? '' : `${base}`);
        }

        /** @returns {string} */
        toString() {
            return this.href;
        }
    }
    return /** @type {typeof URL} */ (/** @type {unknown} */ (NativeUrl));
}

/**
 * `crypto.subtle.digest('SHA-256', bytes)`, the audio downloader's one cryptographic call (its
 * jpod101 invalid-file check). Delegated to native SHA-256; only SHA-256 is supported.
 * @param {import('native-bridge').NativeHost} host
 * @returns {Crypto}
 */
function makeCryptoShim(host) {
    return /** @type {Crypto} */ (/** @type {unknown} */ ({
        subtle: {
            /**
             * @param {AlgorithmIdentifier} algorithm
             * @param {BufferSource} data
             * @returns {Promise<ArrayBuffer>}
             */
            digest: async (algorithm, data) => {
                const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
                if (name !== 'SHA-256') { throw new Error(`Unsupported digest algorithm: ${name}`); }
                const bytes = data instanceof ArrayBuffer ?
                    new Uint8Array(data) :
                    new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                return base64ToBytes(host.sha256(bytesToBase64(bytes))).buffer;
            },
        },
    }));
}

/**
 * `AbortController`, present but inert: the native fetch is synchronous and blocking, so there is no
 * in-flight request for a signal to interrupt. Shimmed only so the audio downloader's idle-timeout
 * setup constructs without a `ReferenceError`; the timeout that matters is `URLSession`'s own.
 */
class NativeAbortController {
    constructor() {
        /** @type {{aborted: boolean, reason: unknown, addEventListener: () => void, removeEventListener: () => void}} */
        this.signal = {
            aborted: false,
            reason: null,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    }

    /** @param {unknown} [reason] */
    abort(reason = null) {
        this.signal.aborted = true;
        this.signal.reason = reason;
    }
}

/**
 * Installs the audio-downloader platform shims on the global object, each only if absent — so node
 * (which has real `URL`, `URLSearchParams`, `crypto` and `AbortController`) keeps its own and the
 * `test:jsc` gate compares the shims against the genuine article.
 * @param {import('native-bridge').NativeHost} host
 * @returns {void}
 */
export function installEngineWebShims(host) {
    const global = /** @type {{[key: string]: unknown}} */ (/** @type {unknown} */ (globalThis));
    if (typeof global.URLSearchParams === 'undefined') { global.URLSearchParams = NativeUrlSearchParams; }
    if (typeof global.URL === 'undefined') { global.URL = makeUrlShim(host); }
    if (typeof global.crypto === 'undefined') { global.crypto = makeCryptoShim(host); }
    if (typeof global.AbortController === 'undefined') { global.AbortController = NativeAbortController; }
    // `btoa`/`atob` operate on binary strings (one byte per char code). The audio downloader reaches
    // them through `arrayBufferToBase64`, which encodes the downloaded audio bytes.
    if (typeof global.btoa === 'undefined') {
        global.btoa = (/** @type {string} */ binary) => {
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; ++i) { bytes[i] = binary.charCodeAt(i) & 0xff; }
            return bytesToBase64(bytes);
        };
    }
    if (typeof global.atob === 'undefined') {
        global.atob = (/** @type {string} */ base64) => {
            let binary = '';
            for (const byte of base64ToBytes(base64)) { binary += String.fromCharCode(byte); }
            return binary;
        };
    }
}

/**
 * A response object shaped like `fetch`'s, over a native round trip. Only the members
 * `audio-downloader.js` and `RequestBuilder.readFetchResponseArrayBuffer` touch are real; `body` is
 * deliberately `null`, which routes the array-buffer reader down its non-streaming path.
 */
export class NativeResponse {
    /** @param {{status: number, url: string, headers: {[key: string]: string}, bodyBase64: string}} result */
    constructor(result) {
        /** @type {number} */
        this.status = result.status;
        /** @type {boolean} */
        this.ok = result.status >= 200 && result.status < 300;
        /** @type {string} */
        this.url = result.url;
        /** @type {?ReadableStream} */
        this.body = null;
        /** @type {string} */
        this._bodyBase64 = result.bodyBase64;
        const headers = result.headers;
        /** @type {{get: (name: string) => ?string}} */
        this.headers = {
            get: (name) => {
                const target = name.toLowerCase();
                for (const key of Object.keys(headers)) {
                    if (key.toLowerCase() === target) { return headers[key]; }
                }
                return null;
            },
        };
    }

    /** @returns {Promise<ArrayBuffer>} */
    async arrayBuffer() {
        return base64ToBytes(this._bodyBase64).buffer;
    }

    /** @returns {Promise<string>} */
    async text() {
        return new TextDecoder().decode(base64ToBytes(this._bodyBase64));
    }

    /** @returns {Promise<unknown>} */
    async json() {
        return parseJson(await this.text());
    }
}

/**
 * A `RequestBuilder` for the engine: the same `fetchAnonymous(url, init)` the audio downloader
 * calls, backed by the host's synchronous fetch instead of the browser's `fetch` +
 * `declarativeNetRequest` header dance. "Anonymous" is the default here — the native fetch uses an
 * ephemeral, cookieless session — so there are no dynamic rules to add and remove.
 */
export class NativeRequestBuilder {
    /** @param {import('native-bridge').NativeHost} host */
    constructor(host) {
        /** @type {import('native-bridge').NativeHost} */
        this._host = host;
    }

    /**
     * The `init` is narrower than `fetch`'s `RequestInit` on purpose: the audio downloader only ever
     * sends a string or a `URLSearchParams` body, and typing it so keeps the stringification total.
     * @param {string} url
     * @param {{method?: string, headers?: {[key: string]: string}, body?: string | URLSearchParams, signal?: unknown}} [init]
     * @returns {Promise<NativeResponse>}
     */
    async fetchAnonymous(url, init = {}) {
        const method = typeof init.method === 'string' ? init.method : 'GET';
        /** @type {{[key: string]: string}} */
        const headers = {};
        if (typeof init.headers === 'object') {
            for (const [key, value] of Object.entries(init.headers)) { headers[key] = `${value}`; }
        }
        let bodyBase64 = '';
        const body = init.body;
        if (typeof body !== 'undefined') {
            // A string goes as-is; a `URLSearchParams` stringifies to `application/x-www-form-urlencoded`.
            const bodyText = typeof body === 'string' ? body : body.toString();
            bodyBase64 = bytesToBase64(new TextEncoder().encode(bodyText));
        }
        const result = /** @type {{status: number, url: string, headers: {[key: string]: string}, bodyBase64: string, error?: string}} */ (
            this._host.fetch({url, method, headers, bodyBase64, timeoutMs: 0})
        );
        if (typeof result.error === 'string') { throw new Error(result.error); }
        return new NativeResponse(result);
    }
}
