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
import {deserializeError} from './native-protocol.js';

/**
 * The extension side of the bridge: one call out to the app extension and back.
 *
 * Safari has no `connectNative`, so there is no port, no push and no streaming — every interaction
 * is a one-shot `sendNativeMessage`. The measured cost is ~1 ms fixed plus ~60 MB/s of payload
 * (plan/native-engine-probe.md), which is what makes putting a hover-path query behind it viable.
 *
 * The request and the reply each carry a single JSON string rather than a nested property list; see
 * native-protocol.js for why that choice is load-bearing rather than incidental.
 */
export class NativeEngineClient {
    /**
     * @param {?string[]} [applications] Native host ids to try in order. Defaults to the same
     *   derivation `anki-connect.js` uses, which is the only way to learn the app's bundle id at
     *   runtime: Safari reports it as `chrome.runtime.id`, with the signing team appended.
     */
    constructor(applications = null) {
        /** @type {string[]} */
        this._applications = applications ?? getDefaultNativeMessagingApplications();
        /**
         * The host that answered last. Trying three ids on every hover would triple the failure
         * latency of a misconfigured install and add a wasted round trip to every call on a correct
         * one, so the working id is remembered after the first success.
         * @type {?string}
         */
        this._resolvedApplication = null;
    }

    /** @returns {boolean} Whether this browser exposes native messaging at all. */
    static isAvailable() {
        return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendNativeMessage === 'function';
    }

    /**
     * @template {import('native-bridge').EngineApiNames} TName
     * @param {TName} action
     * @param {import('native-bridge').EngineApiParams<TName>} params
     * @returns {Promise<import('native-bridge').EngineApiReturn<TName>>}
     */
    async invoke(action, params) {
        const request = JSON.stringify({action, params});
        const response = await this._send({action: 'engine', request});
        if (!isObject(response)) {
            throw new Error(`The native host returned no response for "${action}"`);
        }
        // The Swift router replies with the engine's JSON verbatim under `response`. A failure
        // *before* the engine is reached (no such action, engine failed to start) uses the plain
        // `error` string the pre-existing handler actions already use, so both shapes are handled.
        if (typeof response.error === 'string') {
            throw new Error(`Native host error for "${action}": ${response.error}`);
        }
        if (typeof response.response !== 'string') {
            throw new Error(`Malformed native response for "${action}"`);
        }
        /** @type {import('native-bridge').NativeResponse} */
        const envelope = parseJson(response.response);
        if (typeof envelope.error !== 'undefined') {
            throw deserializeError(envelope.error);
        }
        return /** @type {import('native-bridge').EngineApiReturn<TName>} */ (envelope.result);
    }

    /**
     * Sends one message the **Swift router** handles directly, without the engine being involved.
     *
     * These are the actions that are about files and processes rather than about dictionary data:
     * streaming a compiled database into the container, and asking whether the app is there at all.
     * They deliberately do not go through `invoke`, because they have no JSON envelope and no
     * JavaScriptCore on the other end.
     * @param {string} action
     * @param {{[key: string]: unknown}} [params]
     * @returns {Promise<{[key: string]: unknown}>}
     * @throws {Error} When the host reports an error.
     */
    async invokeHost(action, params = {}) {
        const response = await this._send({action, ...params});
        if (typeof response.error === 'string') {
            throw new Error(`Native host error for "${action}": ${response.error}`);
        }
        return response;
    }

    /**
     * Sends one raw message, trying each candidate host id until one answers and then sticking with
     * it.
     * @param {{[key: string]: unknown}} message
     * @returns {Promise<{[key: string]: unknown}>}
     */
    async _send(message) {
        const candidates = this._resolvedApplication !== null ? [this._resolvedApplication] : this._applications;
        if (candidates.length === 0) {
            throw new Error('No native messaging application is configured; the native engine needs the Safari app extension');
        }
        /** @type {string[]} */
        const failures = [];
        for (const application of candidates) {
            try {
                const response = await sendNativeMessage(application, message);
                this._resolvedApplication = application;
                return isObject(response) ? response : {};
            } catch (e) {
                failures.push(`${application}: ${e instanceof Error ? e.message : e}`);
            }
        }
        // A remembered host that stops answering (the app was updated, or removed) must not wedge
        // every later call, so forget it and let the next attempt rediscover.
        this._resolvedApplication = null;
        throw new Error(`Native messaging failed (${failures.join('; ')})`);
    }
}

/**
 * @param {unknown} value
 * @returns {value is {[key: string]: unknown}}
 */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safari reports the extension's own bundle id as `chrome.runtime.id`, with ` (TEAMID)` appended,
 * and the appex id is the app id plus `.extension`. Both are tried because which one answers
 * depends on how the app was packaged.
 * @returns {string[]}
 */
function getDefaultNativeMessagingApplications() {
    /** @type {string[]} */
    const applications = [];
    const runtimeId = typeof chrome !== 'undefined' ? chrome.runtime?.id : void 0;
    if (typeof runtimeId === 'string' && runtimeId.length > 0) {
        const extensionId = runtimeId.replace(/\s+\([^)]+\)$/, '');
        applications.push(extensionId);
        if (extensionId.endsWith('.extension')) {
            applications.push(extensionId.substring(0, extensionId.length - '.extension'.length));
        }
    }
    return [...new Set(applications)];
}

/**
 * `chrome.runtime.sendNativeMessage` as a promise. Safari may resolve a returned promise *and*
 * invoke the callback for the same call, so both are handled and the first one wins — the same
 * defence `anki-connect.js` carries.
 * @param {string} application
 * @param {{[key: string]: unknown}} message
 * @returns {Promise<unknown>}
 */
function sendNativeMessage(application, message) {
    return new Promise((resolve, reject) => {
        let handled = false;
        /** @param {unknown} value */
        const onResolve = (value) => {
            if (handled) { return; }
            handled = true;
            resolve(value);
        };
        /** @param {unknown} error */
        const onReject = (error) => {
            if (handled) { return; }
            handled = true;
            reject(error instanceof Error ? error : new Error(`${error}`));
        };
        try {
            const maybePromise = /** @type {?Promise<unknown>} */ (/** @type {unknown} */ (chrome.runtime.sendNativeMessage(application, message, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    onReject(new Error(error.message));
                } else {
                    onResolve(response);
                }
            })));
            if (typeof maybePromise === 'object' && maybePromise !== null && typeof maybePromise.then === 'function') {
                maybePromise.then(onResolve, onReject);
            }
        } catch (e) {
            onReject(e);
        }
    });
}
