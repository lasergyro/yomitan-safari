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

import {ExtensionError} from '../../core/extension-error.js';

/**
 * How long to wait for the owning worker to acknowledge `prepare` before giving up.
 *
 * Deliberately generous: it covers loading the sqlite3 WASM *and* acquiring the OPFS SAH-Pool, and
 * the pool is not released the instant its previous holder is terminated — the extension pays that
 * same handoff when it resumes after an import. Still finite, so a worker that never starts at all
 * surfaces as an error rather than hanging every caller behind it forever.
 */
const PREPARE_TIMEOUT_MS = 45000;

/**
 * Client side of the database-owner RPC (plan/backend-worker.md).
 *
 * The background page cannot hold the OPFS connection itself — sync access handles are Worker-only —
 * so it spawns the worker that can and drives it through this. The correlation and
 * progress-streaming rules live here rather than in the backend so the backend's public methods stay
 * one-line forwards.
 *
 * A **dedicated** worker, not a SharedWorker: SharedWorker constructs but never connects in Safari
 * web-extension pages, which is what made the background hang forever on `prepare()`
 * (plan/backend-worker.md → RETRACTED).
 */
export class DatabaseOwnerClient {
    constructor() {
        /** @type {?Worker} */
        this._link = null;
        /** @type {number} */
        this._invocationId = 0;
        /** @type {Map<number, {resolve: (value: any) => void, reject: (reason: Error) => void, onProgress: ?((...args: any[]) => void)}>} */
        this._invocations = new Map();
    }

    /** @returns {boolean} */
    get connected() {
        return this._link !== null;
    }

    /**
     * Spawns the worker that owns the database.
     *
     * Exactly one of these may exist at a time: the SAH-Pool admits a single connection, and the pool
     * holds its OPFS handles for the worker's whole life (closing the database does not give them
     * back — only terminating the worker does, which is what `disconnect()` is for).
     * @returns {void}
     */
    connect() {
        if (this._link !== null) { return; }
        // Resolved against this module rather than as a server-absolute path, so the same code works
        // both in the extension (/js/…) and under the test server, which serves the tree at /ext/js/….
        const worker = new Worker(new URL('../dictionary-database-worker-main.js', import.meta.url), {type: 'module'});
        worker.addEventListener('message', this._onMessage.bind(this));
        this._link = worker;
    }

    /**
     * Sends one call and resolves with its reply. `onProgress`, when given, receives each progress
     * message the owner streams before the result — a callback cannot cross the worker boundary, so
     * long-running operations report through the port instead.
     * @param {string} action
     * @param {{[key: string]: unknown}} params
     * @param {?((...args: any[]) => void)} [onProgress]
     * @param {Transferable[]} [transfer]
     * @returns {Promise<unknown>} The owner's return value; callers narrow it to the action's type.
     * @throws {Error} If this client is not connected to the owner.
     */
    invoke(action, params, onProgress = null, transfer = []) {
        const link = this._link;
        if (link === null) { throw new Error('Not connected to the database owner'); }
        return new Promise((resolve, reject) => {
            const id = ++this._invocationId;
            // Bound the handshake only. A worker that never answers must not wedge the caller
            // forever: a silently dead owner is precisely how the SharedWorker attempt failed — the
            // background hung on `prepare()` and every extension API call queued behind it, with
            // nothing in the log to say why (plan/backend-worker.md → RETRACTED). The other actions
            // are deliberately untimed, because `finalizeImport` legitimately runs for minutes.
            const timer = action !== 'prepare' ?
null :
setTimeout(() => {
    if (!this._invocations.delete(id)) { return; }
    reject(new Error(`The dictionary database worker did not respond to "${action}" within ${PREPARE_TIMEOUT_MS}ms`));
}, PREPARE_TIMEOUT_MS);
            const settle = {
                /** @param {any} value */
                resolve: (value) => {
                    if (timer !== null) { clearTimeout(timer); }
                    resolve(value);
                },
                /** @param {Error} reason */
                reject: (reason) => {
                    if (timer !== null) { clearTimeout(timer); }
                    reject(reason);
                },
                onProgress,
            };
            this._invocations.set(id, settle);
            try {
                link.postMessage({id, action, params}, transfer);
            } catch (e) {
                this._invocations.delete(id);
                settle.reject(e instanceof Error ? e : new Error(`${e}`));
            }
        });
    }

    /**
     * Terminates the owner, which is the only way to give the SAH-Pool's OPFS handles back — a plain
     * database close leaves the pool holding them for the worker's lifetime. The import runs in its
     * own worker and needs the pool, so this is what lets it in.
     * @returns {void}
     */
    disconnect() {
        if (this._link === null) { return; }
        this._link.terminate();
        this._link = null;
        for (const {reject} of this._invocations.values()) {
            reject(new Error('Database owner connection closed'));
        }
        this._invocations.clear();
    }

    // Private

    /**
     * @param {MessageEvent<import('dictionary-database-sqlite').WorkerResponse>} event
     * @returns {void}
     */
    _onMessage(event) {
        const {id, result, error, progress} = event.data;
        const invocation = this._invocations.get(id);
        if (typeof invocation === 'undefined') { return; }
        if (typeof progress !== 'undefined') {
            if (invocation.onProgress !== null) { invocation.onProgress(...progress); }
            return;
        }
        this._invocations.delete(id);
        if (typeof error !== 'undefined') {
            invocation.reject(ExtensionError.deserialize(error));
        } else {
            invocation.resolve(result);
        }
    }
}
