/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {IDBKeyRange, indexedDB} from 'fake-indexeddb';
import * as pako from 'pako';
import {expect, vi} from 'vitest';
import {createDictionaryArchiveData} from '../../dev/dictionary-archive-util.js';
import {DeflatePayloadCodec} from '../../ext/js/dictionary/deflate-payload-codec.js';
import {DictionaryImporter} from '../../ext/js/dictionary/dictionary-importer.js';
import {DictionaryDatabaseSqlite} from '../../ext/js/dictionary/sqlite/dictionary-database-sqlite.js';
import {Translator} from '../../ext/js/language/translator.js';
import {chrome, fetch} from '../mocks/common.js';
import {DictionaryImporterMediaLoader} from '../mocks/dictionary-importer-media-loader.js';
import {createDomTest} from './dom-test.js';

vi.stubGlobal('indexedDB', indexedDB);
vi.stubGlobal('IDBKeyRange', IDBKeyRange);
vi.stubGlobal('fetch', fetch);
vi.stubGlobal('chrome', chrome);

/**
 * The write codec for a sqlite backend variant; `undefined` leaves the backend on its identity
 * default. `DictionaryDatabaseSqlite.prepare()` initializes whatever codec it is given.
 * @param {'sqlite'|'sqlite-deflate'} backend
 * @returns {import('payload-codec').PayloadCodec|undefined}
 */
function createCodec(backend) {
    return backend === 'sqlite-deflate' ? new DeflatePayloadCodec(pako) : void 0;
}

/**
 * Builds a prepared dictionary database, in memory.
 *
 * There used to be a choice here: the IndexedDB store, or the SQLite backend, so the same
 * fixtures/importer/translator could prove the two agreed. That comparison is over — the IndexedDB
 * backend is gone, and the SQLite engine is what the app runs. What remains is the codec choice:
 * `'sqlite-deflate'` uses pako with a trained preset dictionary, which is what ships, so the
 * compressing path is exercised end to end rather than only the identity one.
 * @param {'sqlite'|'sqlite-deflate'} backend
 * @returns {Promise<DictionaryDatabaseSqlite>}
 */
async function createDictionaryDatabaseBackend(backend) {
    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
    const database = new DictionaryDatabaseSqlite(createCodec(backend));
    await database.prepare({sqlite3, vfs: 'memory'});
    return database;
}

/**
 * @param {string} dictionaryDirectory
 * @param {string} dictionaryName
 * @param {'sqlite'|'sqlite-deflate'} [backend]
 * @returns {Promise<{translator: Translator, styles: string}>}
 */
export async function createTranslatorContext(dictionaryDirectory, dictionaryName, backend = 'sqlite') {
    // Dictionary
    const testDictionaryData = await createDictionaryArchiveData(dictionaryDirectory, dictionaryName);

    // Setup database
    const dictionaryImporterMediaLoader = new DictionaryImporterMediaLoader();
    const dictionaryImporter = new DictionaryImporter(dictionaryImporterMediaLoader);
    const dictionaryDatabase = await createDictionaryDatabaseBackend(backend);

    const {errors, result} = await dictionaryImporter.importDictionary(
        dictionaryDatabase,
        testDictionaryData,
        {prefixWildcardsSupported: true, yomitanVersion: '0.0.0.0'},
    );

    expect(errors.length).toEqual(0);
    expect(result).not.toBeNull();

    const styles = result?.styles ?? '';

    // Setup translator
    const translator = new Translator(dictionaryDatabase);
    translator.prepare();

    return {translator, styles};
}

/**
 * @param {string|undefined} htmlFilePath
 * @param {string} dictionaryDirectory
 * @param {string} dictionaryName
 * @param {'sqlite'|'sqlite-deflate'} [backend]
 * @returns {Promise<import('vitest').TestAPI<{window: import('jsdom').DOMWindow, translator: Translator, styles: string}>>}
 */
export async function createTranslatorTest(htmlFilePath, dictionaryDirectory, dictionaryName, backend = 'sqlite') {
    const test = createDomTest(htmlFilePath);
    const {translator, styles} = await createTranslatorContext(dictionaryDirectory, dictionaryName, backend);
    /** @type {import('vitest').TestAPI<{window: import('jsdom').DOMWindow, translator: Translator, styles: string}>} */
    // eslint-disable-next-line sonarjs/prefer-immediate-return
    const result = test.extend({
        window: async ({window}, use) => { await use(window); },
        // eslint-disable-next-line no-empty-pattern
        translator: async ({}, use) => { await use(translator); },
        // eslint-disable-next-line no-empty-pattern
        styles: async ({}, use) => { await use(styles); },
    });
    return result;
}
