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

import {NativeEngineClient} from './native-engine-client.js';
import {bytesToBase64, decodeMediaResults, encodeDictionarySet} from './native-protocol.js';

/**
 * The dictionary store, as the rest of the extension sees it once the engine lives in the app.
 *
 * Same method names and same semantics as `DictionaryDatabase` and `DictionaryDatabaseSqlite`, so
 * the translator, the backend and the settings UI are untouched by the move — the swap happens in
 * `dictionary-database-factory.js` and nothing above it can tell. What it actually does is forward
 * each call across `sendNativeMessage` to the engine hosted in JavaScriptCore in the app extension
 * (plan/native-rewrite.md).
 *
 * Two things it deliberately does not do:
 *
 * - **No local cache.** A query that could be answered from a cache here is one that did not need
 *   the round trip, and at ~1 ms per call the round trip is not what costs. Caching would also mean
 *   a second copy of correctness rules (inflection synthesis, codec selection) on this side of the
 *   bridge, which is exactly what moving the engine was meant to end.
 * - **No import.** Dictionaries are compiled to SQLite at build time by
 *   `dev/bin/compile-dictionary.js` and installed as files, so the write path is not part of this
 *   surface; the methods that would need it fail loudly rather than half-working.
 */
export class DictionaryDatabaseNative {
    /**
     * @param {?NativeEngineClient} [client] Injected by tests; the extension uses the default.
     */
    constructor(client = null) {
        /** @type {NativeEngineClient} */
        this._client = client ?? new NativeEngineClient();
        /** @type {boolean} */
        this._prepared = false;
        /** @type {?import('native-bridge').EngineApiReturn<'prepare'>} */
        this._info = null;
    }

    /**
     * Handshakes with the engine, which opens the database in the app container.
     *
     * Takes no arguments, which is why `prepare` sits outside the `DictionaryDatabaseRead`/`Write`
     * types (plan/decisions.md #46): opening is the one thing backends genuinely disagreed about,
     * and only whoever constructed the object calls it.
     * @returns {Promise<void>}
     */
    async prepare() {
        if (this._prepared) { throw new Error('Database already open'); }
        this._info = await this._client.invoke('prepare', {});
        this._prepared = true;
    }

    /** @returns {boolean} */
    isPrepared() {
        return this._prepared;
    }

    /**
     * The engine's schema version and dictionary count, as reported by the last `prepare()`. Null
     * before then. Exposed for the settings UI and for the extension-origin protocol test, which
     * needs a cheap assertion that the bridge is really answering.
     * @returns {?import('native-bridge').EngineApiReturn<'prepare'>}
     */
    get engineInfo() {
        return this._info;
    }

    /**
     * There is no connection to close — the appex owns the database and may be terminated between
     * calls regardless of what this side does. Kept because callers close the database on teardown
     * and a missing method would be an error rather than a no-op.
     * @returns {void}
     */
    close() {
        this._prepared = false;
        this._info = null;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async purge() {
        await this._client.invoke('purge', {});
        return true;
    }

    /**
     * @param {string} dictionaryName
     * @param {number} _progressRate
     * @param {import('dictionary-database').DeleteDictionaryProgressCallback} onProgress
     * @returns {Promise<void>}
     */
    async deleteDictionary(dictionaryName, _progressRate, onProgress) {
        await this._client.invoke('deleteDictionary', {dictionaryName});
        // The bridge cannot stream progress (no `connectNative`, so nothing can be pushed), and the
        // callback is not optional to the callers. Report the completed state once so a progress UI
        // ends at 100% instead of hanging at whatever it last saw.
        onProgress({count: 1, processed: 1, storeCount: 1, storesProcesed: 1});
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    dictionaryExists(title) {
        return this._client.invoke('dictionaryExists', {title});
    }

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    getDictionaryInfo() {
        return this._client.invoke('getDictionaryInfo', {});
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    getDictionaryCounts(dictionaryNames, getTotal) {
        return this._client.invoke('getDictionaryCounts', {dictionaryNames, getTotal});
    }

    // Term queries

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @param {import('dictionary-database').MatchType} matchType
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsBulk(termList, dictionaries, matchType) {
        return this._client.invoke('findTermsBulk', {termList, dictionaries: encodeDictionarySet(dictionaries), matchType});
    }

    /**
     * @param {import('dictionary-database').TermExactRequest[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsExactBulk(termList, dictionaries) {
        return this._client.invoke('findTermsExactBulk', {termList, dictionaries: encodeDictionarySet(dictionaries)});
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    findTermsBySequenceBulk(items) {
        return this._client.invoke('findTermsBySequenceBulk', {items});
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermMeta[]>}
     */
    findTermMetaBulk(termList, dictionaries) {
        return this._client.invoke('findTermMetaBulk', {termList, dictionaries: encodeDictionarySet(dictionaries)});
    }

    // Kanji queries

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
     */
    findKanjiBulk(kanjiList, dictionaries) {
        return this._client.invoke('findKanjiBulk', {kanjiList, dictionaries: encodeDictionarySet(dictionaries)});
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiMeta[]>}
     */
    findKanjiMetaBulk(kanjiList, dictionaries) {
        return this._client.invoke('findKanjiMetaBulk', {kanjiList, dictionaries: encodeDictionarySet(dictionaries)});
    }

    // Tags and media

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<(import('dictionary-database').Tag|undefined)[]>}
     */
    findTagMetaBulk(items) {
        return this._client.invoke('findTagMetaBulk', {items});
    }

    /**
     * @param {string} name
     * @param {string} dictionary
     * @returns {Promise<?import('dictionary-database').Tag>}
     */
    findTagForTitle(name, dictionary) {
        return this._client.invoke('findTagForTitle', {name, dictionary});
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} items
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    async getMedia(items) {
        return decodeMediaResults(await this._client.invoke('getMedia', {items}));
    }

    // Installing a compiled database

    /**
     * Reports whether the app extension is reachable, and where its database is.
     *
     * Deliberately does not start the engine: a status call that paid for a cold start would be
     * reporting its own cost rather than the app's state.
     * @returns {Promise<{ok: boolean, databasePath: string, databaseBytes: number, startupMilliseconds: number}>}
     */
    async getEngineStatus() {
        const response = await this._client.invokeHost('engineStatus');
        return {
            ok: response.ok === true,
            databasePath: typeof response.databasePath === 'string' ? response.databasePath : '',
            databaseBytes: typeof response.databaseBytes === 'number' ? response.databaseBytes : 0,
            startupMilliseconds: typeof response.startupMilliseconds === 'number' ? response.startupMilliseconds : 0,
        };
    }

    /**
     * Streams a build-time-compiled `.sqlite3` into the app container, replacing the live database.
     *
     * This is what installation *is* in the native direction: the archive was turned into a database
     * once, by `npm run compile:dictionary`, so there is nothing left to import here — only bytes to
     * move (plan/native-rewrite.md → The dictionary pipeline).
     *
     * Chunked rather than sent whole. `sendNativeMessage` has no documented size limit, the largest
     * round trip ever measured was 4 MB, and a 49 MB database in one message is exactly the kind of
     * thing that works on a developer's machine and fails on a user's. At the measured ~60 MB/s a
     * real dictionary still lands in about a second.
     * @param {ArrayBuffer|Uint8Array} bytes The compiled database.
     * @param {?(progress: {loaded: number, total: number}) => void} [onProgress]
     * @returns {Promise<{databaseBytes: number}>}
     * @throws {Error} If the file is not a database this build understands; the live database is
     *   left untouched in that case, because the transfer is staged and validated before the swap.
     */
    async installDatabase(bytes, onProgress = null) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const total = data.byteLength;
        await this._client.invokeHost('installBegin');
        try {
            for (let offset = 0; offset < total; offset += INSTALL_CHUNK_BYTES) {
                const end = Math.min(offset + INSTALL_CHUNK_BYTES, total);
                await this._client.invokeHost('installChunk', {chunk: bytesToBase64(data.subarray(offset, end))});
                if (onProgress !== null) { onProgress({loaded: end, total}); }
            }
            const response = await this._client.invokeHost('installCommit');
            // The engine reopens the replaced file on the next call, so this side's handshake is
            // stale; a caller that keeps using it would report the old dictionary count.
            this._info = null;
            this._prepared = false;
            return {databaseBytes: typeof response.databaseBytes === 'number' ? response.databaseBytes : total};
        } catch (e) {
            await this._client.invokeHost('installAbort').catch(() => {});
            throw e;
        }
    }

    // Write path — not available across the bridge

    /**
     * @returns {Promise<void>}
     */
    async finalizeImport() {
        throw createImportUnsupportedError('finalizeImport');
    }

    /**
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @returns {Promise<void>}
     */
    async bulkAdd(objectStoreName) {
        throw createImportUnsupportedError(`bulkAdd(${objectStoreName})`);
    }

    /**
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @returns {Promise<number>}
     */
    async addWithResult(objectStoreName) {
        throw createImportUnsupportedError(`addWithResult(${objectStoreName})`);
    }

    /**
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @returns {Promise<void>}
     */
    async bulkUpdate(objectStoreName) {
        throw createImportUnsupportedError(`bulkUpdate(${objectStoreName})`);
    }
}

/**
 * How much of the database to send per message.
 *
 * 4 MB is the largest round trip that has actually been measured (plan/native-engine-probe.md), and
 * base64 inflates it by a third on the wire, so this stays comfortably under it. Smaller chunks cost
 * ~1 ms each in fixed overhead, which is nothing beside the transfer itself.
 * @type {number}
 */
const INSTALL_CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * The in-browser import path does not exist in the native direction: a dictionary archive is
 * compiled to SQLite at build time and installed as a file, which is what removes the importer, the
 * trained-codec handshake and the 152-second import at once (plan/native-rewrite.md → The dictionary
 * pipeline). Anything still calling a write method is a caller that has not been migrated, so say so
 * plainly rather than failing somewhere further down.
 * @param {string} method
 * @returns {Error}
 */
function createImportUnsupportedError(method) {
    return new Error(`${method} is not available on the native backend: dictionaries are compiled with "npm run compile:dictionary" and installed as files`);
}
