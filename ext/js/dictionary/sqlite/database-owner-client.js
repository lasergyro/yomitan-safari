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
 * Client side of the database-owner RPC (plan/backend-worker.md).
 *
 * Every context that cannot hold the OPFS connection itself — the background page that reads, the
 * settings-side import — talks to the one SharedWorker that can, through this. It is shared rather
 * than reimplemented per caller so that the correlation and progress-streaming rules live in one
 * place.
 */
export class DatabaseOwnerClient {
    constructor() {
        /** @type {?import('dictionary-database-sqlite').WorkerLink} */
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
     * Connects to the SharedWorker that owns the database, starting it if this is the first client.
     *
     * A **Shared**Worker is what makes "exactly one connection" structural: the SAH-Pool admits a
     * single connection, and one worker instance per (origin, script) means the background page and
     * the settings page reach the same owner instead of racing for the pool.
     * @returns {void}
     */
    connect() {
        if (this._link !== null) { return; }
        const worker = new SharedWorker(new URL('dictionary-database-shared-worker.js', import.meta.url), {type: 'module'});
        const port = worker.port;
        port.addEventListener('message', this._onMessage.bind(this));
        port.start();
        this._link = port;
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
            this._invocations.set(id, {resolve, reject, onProgress});
            try {
                link.postMessage({id, action, params}, transfer);
            } catch (e) {
                this._invocations.delete(id);
                reject(e instanceof Error ? e : new Error(`${e}`));
            }
        });
    }

    /**
     * Detaches this client. The owner is shared, so its database is deliberately left open for the
     * other clients; the SharedWorker itself goes away once every client has disconnected.
     * @returns {void}
     */
    disconnect() {
        if (this._link === null) { return; }
        this._link.close();
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
