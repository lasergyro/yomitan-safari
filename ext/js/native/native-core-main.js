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

import * as pakoNamespace from 'pako';
import {parseJson} from '../core/json.js';
import {NativeCore} from './native-core.js';
import {ERROR_KEY, RESULT_KEY, serializeError} from './native-protocol.js';
import {TextDecoderShim, TextEncoderShim} from './text-codec-shim.js';

/**
 * Entry point for the bundle that runs inside JavaScriptCore in the app (built by
 * `dev/bin/build-native-core.js`). It does three things and no more: shim the missing platform,
 * construct the engine, and publish a call surface Swift can reach.
 *
 * **Why a bundle at all.** JavaScriptCore has no ES-module loader, so the engine's ~40-file import
 * graph has to be rolled into one script before `evaluateScript` can see it. That is also why pako
 * is imported statically here and handed to the codec, instead of the codec's usual dynamic import
 * of the vendored browser build: at runtime there is nothing to import *from*.
 *
 * **Why an explicit event loop.** A `JSContext` drains microtasks when a native call returns, so
 * plain promise chains settle by themselves — but nothing runs a timer. The engine's async paths are
 * microtask-only today, and it would be a nasty surprise if that quietly stopped being true, so the
 * host gets a real (tiny) macrotask queue that Swift pumps. `yomitanNativeRunNextTimer` below is
 * the crank.
 */

/**
 * Every pending call, by id. Results are held rather than returned directly because the engine is
 * async and JavaScriptCore cannot await a JS promise from Swift: Swift starts a call, pumps the
 * loop, and polls.
 * @type {Map<number, {settled: boolean, response: string}>}
 */
const calls = new Map();

/**
 * pako is CommonJS, and whether its functions arrive as named exports or under `.default` depends on
 * the bundler's interop. Getting it wrong is not loud — the codec would fall back to writing
 * uncompressed rows — so it is normalized once, here.
 * @type {import('pako')}
 */
const pako = /** @type {import('pako')} */ (
    typeof (/** @type {{deflateRaw?: unknown}} */ (pakoNamespace)).deflateRaw === 'function' ?
        pakoNamespace :
        /** @type {{default: import('pako')}} */ (/** @type {unknown} */ (pakoNamespace)).default
);

/** @type {number} */
let nextCallId = 0;

/** @type {{id: number, due: number, callback: () => void}[]} */
let timers = [];

/** @type {number} */
let nextTimerId = 0;

/**
 * Installs everything the engine expects to find on the global object but that bare JavaScriptCore
 * does not provide.
 * @param {import('native-bridge').NativeHost} host
 * @returns {void}
 */
function installShims(host) {
    const global = /** @type {{[key: string]: unknown}} */ (/** @type {unknown} */ (globalThis));

    if (typeof global.TextEncoder === 'undefined') { global.TextEncoder = TextEncoderShim; }
    if (typeof global.TextDecoder === 'undefined') { global.TextDecoder = TextDecoderShim; }

    // Routed to os_log so engine output lands in Console.app alongside the Swift side's, which is
    // the only place to see it: there is no Web Inspector attached to a JSContext in an appex.
    if (typeof global.console === 'undefined') {
        global.console = {
            log: (/** @type {unknown[]} */ ...args) => host.log('info', formatLogArguments(args)),
            info: (/** @type {unknown[]} */ ...args) => host.log('info', formatLogArguments(args)),
            warn: (/** @type {unknown[]} */ ...args) => host.log('warn', formatLogArguments(args)),
            error: (/** @type {unknown[]} */ ...args) => host.log('error', formatLogArguments(args)),
            debug: (/** @type {unknown[]} */ ...args) => host.log('debug', formatLogArguments(args)),
        };
    }

    if (typeof global.performance === 'undefined') {
        global.performance = {now: () => host.now()};
    }

    if (typeof global.setTimeout === 'undefined') {
        global.setTimeout = (/** @type {() => void} */ callback, /** @type {number} */ delay = 0) => {
            const id = ++nextTimerId;
            timers.push({id, due: host.now() + (Number.isFinite(delay) ? delay : 0), callback});
            return id;
        };
        global.clearTimeout = (/** @type {number} */ id) => {
            timers = timers.filter((timer) => timer.id !== id);
        };
        // setInterval is deliberately absent rather than shimmed: nothing in the engine uses it, and
        // a repeating timer in a process that can be terminated between calls is a bug waiting to
        // happen. If something reaches for it, the ReferenceError should be loud.
    }
}

/**
 * `console.log(a, b)` semantics, minus format specifiers (nothing in the engine uses them).
 * @param {unknown[]} args
 * @returns {string}
 */
function formatLogArguments(args) {
    return args.map((arg) => {
        if (typeof arg === 'string') { return arg; }
        if (arg instanceof Error) { return `${arg.name}: ${arg.message}`; }
        try {
            return JSON.stringify(arg);
        } catch (e) {
            return `${arg}`;
        }
    }).join(' ');
}

/**
 * Starts one call and returns its id. Errors — including a malformed request — settle the call
 * rather than throwing across the JavaScriptCore boundary, so Swift has one code path.
 * @param {NativeCore} core
 * @param {string} requestJson
 * @returns {number}
 */
function beginCall(core, requestJson) {
    const id = ++nextCallId;
    const slot = {settled: false, response: ''};
    calls.set(id, slot);
    /**
     * @param {unknown} value
     * @returns {void}
     */
    const settle = (value) => {
        slot.settled = true;
        try {
            slot.response = JSON.stringify(value);
        } catch (e) {
            // A result that will not serialize is a bug in an action handler, not a caller error,
            // but it must not be reported as a successful call with an empty body.
            slot.response = JSON.stringify({[ERROR_KEY]: serializeError(e)});
        }
    };
    try {
        const {action, params} = /** @type {import('native-bridge').NativeRequest} */ (parseJson(requestJson));
        Promise.resolve(core.invoke(action, params ?? {})).then(
            (result) => { settle({[RESULT_KEY]: typeof result === 'undefined' ? null : result}); },
            (error) => { settle({[ERROR_KEY]: serializeError(error)}); },
        );
    } catch (e) {
        settle({[ERROR_KEY]: serializeError(e)});
    }
    return id;
}

/**
 * @param {number} id
 * @returns {?string} The response JSON, or null while the call is still in flight.
 */
function pollCall(id) {
    const slot = calls.get(id);
    if (typeof slot === 'undefined') { return JSON.stringify({[ERROR_KEY]: {message: `Unknown native call id ${id}`}}); }
    if (!slot.settled) { return null; }
    calls.delete(id);
    return slot.response;
}

/**
 * Runs the timer that is due soonest, if any. Swift calls this in a loop while a call is unsettled;
 * returning false means "no work left", which — with the call still unsettled — is a deadlock and is
 * reported as such rather than spun on.
 * @returns {boolean} Whether a timer ran.
 */
function runNextTimer() {
    if (timers.length === 0) { return false; }
    let earliest = 0;
    for (let i = 1; i < timers.length; ++i) {
        if (timers[i].due < timers[earliest].due) { earliest = i; }
    }
    const [timer] = timers.splice(earliest, 1);
    timer.callback();
    return true;
}

/**
 * Publishes the call surface. Names are prefixed and attached to the global object because that is
 * the only namespace `JSContext.objectForKeyedSubscript` can reach.
 * @param {import('native-bridge').NativeHost} host
 * @returns {void}
 */
function main(host) {
    installShims(host);
    const core = new NativeCore(host, {pako});
    const global = /** @type {{[key: string]: unknown}} */ (/** @type {unknown} */ (globalThis));
    global.yomitanNativeBegin = (/** @type {string} */ requestJson) => beginCall(core, requestJson);
    global.yomitanNativePoll = (/** @type {number} */ id) => pollCall(id);
    global.yomitanNativeRunNextTimer = () => runNextTimer();
    global.yomitanNativeReady = true;
}

const hostObject = /** @type {?import('native-bridge').NativeHost} */ (/** @type {{yomitanNativeHost?: import('native-bridge').NativeHost}} */ (globalThis).yomitanNativeHost ?? null);
if (hostObject === null) {
    throw new Error('yomitanNativeHost was not installed before the engine bundle was evaluated');
}
main(hostObject);
