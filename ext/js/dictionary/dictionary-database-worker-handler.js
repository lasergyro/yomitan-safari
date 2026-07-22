/*
 * Copyright (C) 2024-2025  Yomitan Authors
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

import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {createDictionaryDatabase} from './dictionary-database-factory.js';
import {DictionaryDatabase} from './dictionary-database.js';

export class DictionaryDatabaseWorkerHandler {
    constructor() {
        /** @type {DictionaryDatabase?} */
        this._dictionaryDatabase = null;
        /** @type {?Promise<void>} */
        this._preparePromise = null;
    }

    /**
     *
     */
    prepare() {
        this._dictionaryDatabase = createDictionaryDatabase();

        // Register the listeners BEFORE anything is awaited. A message posted to a worker while it
        // has no `message` listener is dispatched to nothing and lost — it is not queued until one
        // appears. The background sends `prepare` the instant it spawns this worker, so registering
        // after `await database.prepare()` drops that first request: the caller then waits forever
        // for a reply that can never come, while every later call succeeds, which is exactly how
        // this presented (a `prepare` that timed out even at 45s amid passing queries).
        self.addEventListener('message', this._onMessage.bind(this), false);
        self.addEventListener('messageerror', (event) => {
            const error = new ExtensionError('DictionaryDatabaseWorkerHandler: Error receiving message from main thread');
            error.data = event;
            log.error(error);
        });

        this._preparePromise = this._dictionaryDatabase.prepare();
        // Observe the rejection here so it is not an unhandled one; the `prepare` action re-awaits
        // this same promise, so the caller still gets the real failure.
        this._preparePromise.catch((e) => { log.error(e); });
    }
    // Private

    /**
     * @param {MessageEvent<import('dictionary-database-worker-handler').MessageToWorker | import('dictionary-database-sqlite').WorkerRequest>} event
     */
    _onMessage(event) {
        const data = event.data;
        // The database-owner RPC (plan/backend-worker.md): the background page cannot hold the OPFS
        // connection, so it drives this worker's database instead. Correlated by `id`, which the
        // legacy port-handshake message below does not carry.
        if (typeof (/** @type {{id?: unknown}} */ (data).id) === 'number') {
            void this._onRequest(/** @type {import('dictionary-database-sqlite').WorkerRequest} */ (data));
            return;
        }
        const {action} = /** @type {import('dictionary-database-worker-handler').MessageToWorker} */ (data);
        switch (action) {
            case 'connectToDatabaseWorker':
                void this._dictionaryDatabase?.connectToDatabaseWorker(event.ports[0]);
                break;
            default:
                log.error(`Unknown action: ${action}`);
        }
    }

    /**
     * @param {import('dictionary-database-sqlite').WorkerRequest} request
     * @returns {Promise<void>}
     */
    async _onRequest(request) {
        const {id, action, params} = request;
        try {
            const result = await this._invoke(action, params, (...progress) => {
                self.postMessage({id, progress});
            });
            self.postMessage({id, result});
        } catch (e) {
            const error = e instanceof Error ? e : new Error(`${e}`);
            log.error(error);
            self.postMessage({id, error: ExtensionError.serialize(error)});
        }
    }

    /**
     * Runs one call against the owned database.
     *
     * Imports are deliberately absent: they keep running in their own worker, which needs the
     * SAH-Pool this worker is holding, so the background terminates this worker for the duration
     * instead of writing through it (plan/backend-worker.md).
     * @param {keyof import('dictionary-database-sqlite').OwnerParams} action
     * @param {unknown} params Narrowed to the action's shape by each case.
     * @param {(...args: unknown[]) => void} onProgress
     * @returns {Promise<unknown>}
     */
    async _invoke(action, params, onProgress) {
        const database = this._dictionaryDatabase;
        if (database === null) { throw new Error('Database not created'); }
        switch (action) {
            case 'prepare': return await this._preparePromise;
            case 'isPrepared': return database.isPrepared();
            case 'purge': return await database.purge();
            case 'finalizeImport': return await database.finalizeImport();
            case 'getDictionaryInfo': return await database.getDictionaryInfo();
            case 'dictionaryExists': {
                const {title} = /** @type {import('dictionary-database-sqlite').OwnerParams['dictionaryExists']} */ (params);
                return await database.dictionaryExists(title);
            }
            case 'getDictionaryCounts': {
                const {dictionaryNames, getTotal} = /** @type {import('dictionary-database-sqlite').OwnerParams['getDictionaryCounts']} */ (params);
                return await database.getDictionaryCounts(dictionaryNames, getTotal);
            }
            case 'deleteDictionary': {
                const {dictionaryName, progressRate} = /** @type {import('dictionary-database-sqlite').OwnerParams['deleteDictionary']} */ (params);
                return await database.deleteDictionary(dictionaryName, progressRate, (...args) => onProgress(...args));
            }
            case 'bulkAdd': {
                const {objectStoreName, items, start, count} = /** @type {import('dictionary-database-sqlite').OwnerParams['bulkAdd']} */ (params);
                return await database.bulkAdd(objectStoreName, /** @type {import('core').SafeAny} */ (items), start, count);
            }
            case 'bulkUpdate': {
                const {objectStoreName, items, start, count} = /** @type {import('dictionary-database-sqlite').OwnerParams['bulkUpdate']} */ (params);
                return await database.bulkUpdate(objectStoreName, /** @type {import('core').SafeAny} */ (items), start, count);
            }
            case 'findTermsBulk': {
                const {termList, dictionaries, matchType} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTermsBulk']} */ (params);
                return await database.findTermsBulk(termList, dictionaries, matchType);
            }
            case 'findTermsExactBulk': {
                const {termList, dictionaries} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTermsExactBulk']} */ (params);
                return await database.findTermsExactBulk(termList, dictionaries);
            }
            case 'findTermsBySequenceBulk': {
                const {items} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTermsBySequenceBulk']} */ (params);
                return await database.findTermsBySequenceBulk(items);
            }
            case 'findTermMetaBulk': {
                const {termList, dictionaries} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTermMetaBulk']} */ (params);
                return await database.findTermMetaBulk(termList, dictionaries);
            }
            case 'findKanjiBulk': {
                const {kanjiList, dictionaries} = /** @type {import('dictionary-database-sqlite').OwnerParams['findKanjiBulk']} */ (params);
                return await database.findKanjiBulk(kanjiList, dictionaries);
            }
            case 'findKanjiMetaBulk': {
                const {kanjiList, dictionaries} = /** @type {import('dictionary-database-sqlite').OwnerParams['findKanjiMetaBulk']} */ (params);
                return await database.findKanjiMetaBulk(kanjiList, dictionaries);
            }
            case 'findTagMetaBulk': {
                const {items} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTagMetaBulk']} */ (params);
                return await database.findTagMetaBulk(items);
            }
            case 'findTagForTitle': {
                const {name, dictionary} = /** @type {import('dictionary-database-sqlite').OwnerParams['findTagForTitle']} */ (params);
                return await database.findTagForTitle(name, dictionary);
            }
            case 'getMedia': {
                const {items} = /** @type {import('dictionary-database-sqlite').OwnerParams['getMedia']} */ (params);
                return await database.getMedia(items);
            }
            default: throw new Error(`Unknown action: ${/** @type {string} */ (action)}`);
        }
    }
}
