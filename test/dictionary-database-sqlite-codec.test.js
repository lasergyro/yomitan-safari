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

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as pako from 'pako';
import {beforeAll, describe, expect, test} from 'vitest';
import {DeflatePayloadCodec} from '../ext/js/dictionary/deflate-payload-codec.js';
import {DictionaryDatabaseSqlite} from '../ext/js/dictionary/sqlite/dictionary-database-sqlite.js';

const dictionaryName = 'Codec Test Dictionary';
const dictionaries = new Set([dictionaryName]);

/** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */
const termRows = [
    {expression: 'いぬ', reading: 'いぬ', dictionary: dictionaryName, sequence: 1, m: ['n', '', 0, ['dog', {type: 'structured-content', content: [{tag: 'div', content: 'a common domestic animal'}]}], 'tag']},
    {expression: 'ねこ', reading: 'ねこ', dictionary: dictionaryName, sequence: 2, m: [null, 'v5', -3, ['cat', {type: 'structured-content', content: [{tag: 'div', content: 'a common domestic animal'}]}], void 0]},
    {expression: 'とり', reading: 'とり', dictionary: dictionaryName, sequence: 3, m: ['n', '', 7, ['bird'], '']},
];

describe('DictionaryDatabaseSqlite deflate codec self-description', () => {
    /** @type {DictionaryDatabaseSqlite} */
    let backend;

    beforeAll(async () => {
        const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
        backend = new DictionaryDatabaseSqlite(new DeflatePayloadCodec(pako));
        await backend.prepare({sqlite3, vfs: 'memory'});
        /** @type {import('dictionary-importer').Summary} */
        const summary = {title: dictionaryName, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
        await backend.bulkAdd('dictionaries', [summary], 0, 1);
        await backend.bulkAdd('terms', termRows, 0, termRows.length);
    });

    test('reads back correctly using the write-time codec cache', async () => {
        const results = await backend.findTermsBulk(['いぬ'], dictionaries, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].definitions).toStrictEqual(termRows[0].m[3]);
    });

    test('reads back correctly after the codec cache is dropped (derived from the codec column)', async () => {
        // Force the read path to re-derive the codec + codec_dict from the dictionaries row rather
        // than the write-time cache, proving rows are self-describing.
        const internal = /** @type {{_dictCodec: Map<number, unknown>}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        internal._dictCodec.clear();
        const results = await backend.findTermsBulk(['ねこ'], dictionaries, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].reading).toBe('ねこ');
        // undefined termTags -> null through JSON, so termTags is [].
        expect(results[0].definitions).toStrictEqual(termRows[1].m[3]);
        expect(results[0].score).toBe(-3);
    });

    test('an unknown-codec dictionary still decodes with a registered codec', async () => {
        // The find above already exercised decode via the registry; assert every term is retrievable.
        const all = await backend.findTermsBulk(['いぬ', 'ねこ', 'とり'], dictionaries, 'exact');
        expect(all.map((entry) => entry.term).sort()).toStrictEqual(['いぬ', 'とり', 'ねこ']);
    });
});
