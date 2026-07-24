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

import {DeflatePayloadCodec} from '../dictionary/deflate-payload-codec.js';
import {DictionaryDatabaseSqlite} from '../dictionary/sqlite/dictionary-database-sqlite.js';
import {DICTIONARY_SQLITE_SCHEMA_VERSION} from '../dictionary/sqlite/dictionary-sqlite-schema.js';
import {Translator} from '../language/translator.js';
import {decodeDictionarySet, decodeFindKanjiOptions, decodeFindTermsOptions, encodeMediaResults} from './native-protocol.js';

/**
 * The dictionary engine, as it runs inside the native app.
 *
 * This is the *same* `DictionaryDatabaseSqlite` the extension ran on OPFS — the whole point of
 * route C in plan/native-rewrite.md is that the engine is re-hosted rather than rewritten. What
 * changes is underneath it: `sqlite3` is a native binding over the system `libsqlite3` instead of a
 * WASM build over an OPFS SAH-Pool, and the file lives in the app container, where Safari's
 * per-launch origin rotation cannot strand it (plan/history/safari-opfs-blocker.md).
 *
 * Everything above the handle interface is untouched, which is why the vitest suites for the
 * backend, the codec and the inflection synthesis keep their value: they test this code.
 *
 * The class deliberately knows nothing about how requests arrive. `native-core-main.js` wires it to
 * JavaScriptCore; `dev/bin/test-native-core.js` drives it both ways and requires the answers to
 * match. That is what makes the engine testable without an app around it.
 */
export class NativeCore {
    /**
     * @param {import('native-bridge').NativeHost} host The platform surface the Swift side installs.
     * @param {{pako: import('pako'), databasePath?: string}} options `pako` is injected rather than
     *   dynamically imported so the bundler resolves it statically — JavaScriptCore has no module
     *   loader, so a live `import()` at runtime would have nothing to load from. It is required:
     *   the codec has no fallback and throws without it.
     */
    constructor(host, {pako, databasePath}) {
        /** @type {import('native-bridge').NativeHost} */
        this._host = host;
        /** @type {?string} */
        this._databasePath = typeof databasePath === 'string' ? databasePath : null;
        /** @type {DictionaryDatabaseSqlite} */
        this._database = new DictionaryDatabaseSqlite(new DeflatePayloadCodec(pako));
        /**
         * The translator, running here rather than in the extension (plan/native-rewrite.md, stage
         * N3). Deinflection, result assembly and every query it issues now happen on this side of
         * the bridge, so a lookup is one round trip carrying only the entries that survived, instead
         * of half a dozen carrying every candidate that was considered.
         *
         * This is also the reason route C was chosen: the deinflection rules are live closures and
         * compiled regexes across 23 languages, and they run here unmodified.
         * @type {Translator}
         */
        this._translator = new Translator(this._database);
        /**
         * In-flight (or completed) preparation. The app extension can be terminated between calls,
         * so a client cannot be relied on to have called `prepare` first — every action awaits this,
         * and it costs one already-resolved promise once the process is warm.
         * @type {?Promise<import('native-bridge').EngineApiReturn<'prepare'>>}
         */
        this._preparePromise = null;
        /** @type {import('native-bridge').EngineApiHandlerMap} */
        this._handlers = this._createHandlers();
    }

    /**
     * Dispatches one request. Never throws: a failure comes back as the envelope's error branch so
     * the Swift router has exactly one shape to forward.
     * @param {string} action
     * @param {{[key: string]: unknown}} params
     * @returns {Promise<unknown>}
     */
    async invoke(action, params) {
        const handler = /** @type {import('native-bridge').EngineApiHandlerMap & {[key: string]: import('native-bridge').EngineApiHandler|undefined}} */ (this._handlers)[action];
        if (typeof handler !== 'function') {
            throw new Error(`Unsupported engine action: ${action}`);
        }
        if (action !== 'prepare') { await this._prepare(); }
        return await handler(/** @type {never} */ (params));
    }

    /**
     * Opens the database, once. Idempotent and safe to race: the promise is stored before the first
     * await, so concurrent callers share one open rather than each trying to create the schema.
     * @returns {Promise<import('native-bridge').EngineApiReturn<'prepare'>>}
     */
    _prepare() {
        if (this._preparePromise === null) {
            this._preparePromise = (async () => {
                const path = this._databasePath ?? this._host.databasePath();
                const sqlite3 = createNativeSqliteModule(this._host);
                await this._database.prepare({sqlite3, vfs: 'native', path});
                this._translator.prepare();
                const info = await this._database.getDictionaryInfo();
                return {schemaVersion: NATIVE_ENGINE_SCHEMA_VERSION, dictionaryCount: info.length};
            })();
        }
        return this._preparePromise;
    }

    /**
     * The action table. Written out rather than generated from the database's method names so that
     * the bridge's surface is a deliberate list — an action reaching the engine is a decision, not
     * an accident of what happens to be public.
     * @returns {import('native-bridge').EngineApiHandlerMap}
     */
    _createHandlers() {
        const db = this._database;
        return {
            prepare: () => this._prepare(),
            getDictionaryInfo: () => db.getDictionaryInfo(),
            getDictionaryCounts: ({dictionaryNames, getTotal}) => db.getDictionaryCounts(dictionaryNames, getTotal),
            dictionaryExists: ({title}) => db.dictionaryExists(title),
            // No progress stream: `sendNativeMessage` is one-shot and Safari has no `connectNative`,
            // so there is nothing to push down. Deletion of a single dictionary is fast enough to
            // finish inside one call; if that stops being true this is the action that becomes a job
            // (plan/native-rewrite.md → The protocol, consequence 1).
            deleteDictionary: async ({dictionaryName}) => { await db.deleteDictionary(dictionaryName, 0, () => {}); },
            purge: async () => { await db.purge(); },
            findTermsBulk: ({termList, dictionaries, matchType}) => db.findTermsBulk(termList, decodeDictionarySet(dictionaries), matchType),
            findTermsExactBulk: ({termList, dictionaries}) => db.findTermsExactBulk(termList, decodeDictionarySet(dictionaries)),
            findTermsBySequenceBulk: ({items}) => db.findTermsBySequenceBulk(items),
            findTermMetaBulk: ({termList, dictionaries}) => db.findTermMetaBulk(termList, decodeDictionarySet(dictionaries)),
            findKanjiBulk: ({kanjiList, dictionaries}) => db.findKanjiBulk(kanjiList, decodeDictionarySet(dictionaries)),
            findKanjiMetaBulk: ({kanjiList, dictionaries}) => db.findKanjiMetaBulk(kanjiList, decodeDictionarySet(dictionaries)),
            findTagMetaBulk: ({items}) => db.findTagMetaBulk(items),
            findTagForTitle: ({name, dictionary}) => db.findTagForTitle(name, dictionary),
            getMedia: async ({items}) => encodeMediaResults(await db.getMedia(items)),
            // The `maxResults` truncation stays on the extension side: it is a display preference,
            // and applying it here would mean the engine's answer depended on a setting it has no
            // other reason to know about.
            termsFind: ({mode, text, options}) => this._translator.findTerms(mode, text, decodeFindTermsOptions(options)),
            kanjiFind: ({text, options}) => this._translator.findKanji(text, decodeFindKanjiOptions(options)),
            getTermFrequencies: ({termReadingList, dictionaries}) => this._translator.getTermFrequencies(termReadingList, dictionaries),
            clearDatabaseCaches: () => { this._translator.clearDatabaseCaches(); },
        };
    }
}

/**
 * The schema version reported to the client at `prepare`, and the version the Swift installer checks
 * a compiled database's `user_version` against before replacing the live one
 * (native/Sources/YomitanNative/DictionaryStore.swift). Re-exported from the schema module rather
 * than restated, and `test/native-host-shims.test.js` pins the Swift literal to it — a silent drift
 * would either reject every valid dictionary or accept an incompatible one.
 * @type {number}
 */
export const NATIVE_ENGINE_SCHEMA_VERSION = DICTIONARY_SQLITE_SCHEMA_VERSION;

/**
 * Wraps the host's `openDatabase` in the shape `DictionaryDatabaseSqlite.prepare` injects.
 *
 * The backend funnels every query through `openDictionaryDatabaseHandle`, which takes the `sqlite3`
 * module as an argument instead of importing it — the seam that already existed so node tests could
 * use `:memory:` and the worker could use OPFS. The native binding substitutes at exactly that seam,
 * which is the concrete reason this is a re-host and not a rewrite (plan/design.md → Integration).
 * @param {import('native-bridge').NativeHost} host
 * @returns {import('sqlite-wasm').Sqlite3Module}
 */
function createNativeSqliteModule(host) {
    return /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ ({
        version: {libVersion: 'native', sourceId: 'native'},
        oo1: {DB: function NativeDb(/** @type {string|undefined} */ filename) {
            return host.openDatabase(typeof filename === 'string' ? filename : ':memory:');
        }},
        installOpfsSAHPoolVfs: () => { throw new Error('OPFS is not available in the native host'); },
    }));
}
