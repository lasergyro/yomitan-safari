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

// The single owner of the SQLite/OPFS dictionary database (plan/backend-worker.md).
//
// This exists because the OPFS SAH-Pool VFS is **worker-only and single-connection**:
// `createSyncAccessHandle` is `undefined` outside a worker, so no page — not the Safari background
// page, not the settings page — can hold the database itself. It is a *Shared* worker so that every
// extension page reaches the same owner: the pool admits exactly one connection, and one instance
// per (origin, script) makes that structural rather than something the callers must coordinate.
//
// Each client connects a port and sends {id, action, params}; this replies {id, result} or
// {id, error}, and may stream {id, progress} first for the long-running operations.

import {ExtensionError} from '../../core/extension-error.js';
import {log} from '../../core/log.js';
import {DeflatePayloadCodec} from '../deflate-payload-codec.js';
import {DictionaryImporter} from '../dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../dictionary-importer-media-loader.js';
import {DictionaryDatabaseSqlite} from './dictionary-database-sqlite.js';

/**
 * The one database instance. Built exactly as `createDictionaryDatabase()` builds it, so the owner
 * runs the real shipping configuration.
 * @type {DictionaryDatabaseSqlite}
 */
const database = new DictionaryDatabaseSqlite(new DeflatePayloadCodec());

/** @type {?Promise<void>} Shared so concurrent clients open the database exactly once. */
let preparePromise = null;

/**
 * Opens the database on the first client that asks, and returns that same promise to every later
 * caller. Reference-counting is deliberately absent: the pool should stay open for the worker's
 * whole life, and the worker itself goes away once every client has disconnected.
 * @returns {Promise<void>}
 */
function prepareOnce() {
    if (preparePromise === null) {
        preparePromise = database.prepare();
    }
    return preparePromise;
}

/**
 * Runs one client call against the owned database.
 *
 * `bulkAdd`/`bulkUpdate`/`finalizeImport` are here as well as the read methods because the import
 * writes through this same connection — a second connection would be refused by the pool.
 * @param {keyof import('dictionary-database-sqlite').OwnerParams} action
 * @param {unknown} params Narrowed to the action's shape by each case below.
 * @param {(...args: unknown[]) => void} onProgress
 * @returns {Promise<unknown>}
 */
async function invoke(action, params, onProgress) {
    switch (action) {
        case 'prepare': return await prepareOnce();
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
        case 'importDictionary': {
            const {archiveContent, details} = /** @type {import('dictionary-database-sqlite').OwnerParams['importDictionary']} */ (params);
            return await importDictionary(archiveContent, details, onProgress);
        }
        default: throw new Error(`Unknown action: ${/** @type {string} */ (action)}`);
    }
}

/**
 * Imports through the owned connection rather than a throwaway one.
 *
 * The importer used to run in its own worker with its own database; that cannot work once anything
 * else holds the pool, so the import comes here instead. `importDictionary` already calls
 * `finalizeImport()` itself on success.
 * @param {ArrayBuffer} archiveContent
 * @param {import('dictionary-importer').ImportDetails} details
 * @param {(...args: unknown[]) => void} onProgress
 * @returns {Promise<import('dictionary-worker').MessageCompleteResultSerialized>}
 */
async function importDictionary(archiveContent, details, onProgress) {
    await prepareOnce();
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), (...args) => onProgress(...args));
    const {result, errors} = await importer.importDictionary(
        /** @type {import('../dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        archiveContent,
        details,
    );
    return {result, errors: errors.map((error) => ExtensionError.serialize(error))};
}

/**
 * @param {MessagePort} port
 * @param {import('dictionary-database-sqlite').WorkerRequest} request
 * @returns {Promise<void>}
 */
async function handleRequest(port, request) {
    const {id, action, params} = request;
    try {
        const result = await invoke(action, params ?? {}, (...progress) => {
            port.postMessage({id, progress});
        });
        port.postMessage({id, result});
    } catch (e) {
        const error = e instanceof Error ? e : new Error(`${e}`);
        log.error(error);
        port.postMessage({id, error: ExtensionError.serialize(error)});
    }
}

self.addEventListener('connect', (/** @type {Event} */ event) => {
    const port = /** @type {MessageEvent} */ (event).ports[0];
    port.addEventListener('message', (/** @type {MessageEvent<import('dictionary-database-sqlite').WorkerRequest>} */ messageEvent) => {
        void handleRequest(port, messageEvent.data);
    });
    port.start();
});
