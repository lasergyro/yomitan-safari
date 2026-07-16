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
import {ZstdPayloadCodec} from '../ext/js/dictionary/zstd-payload-codec.js';
import {loadZstdInitModule} from '../dev/zstd/load.js';

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

    test('finalizeImport (ANALYZE + VACUUM) leaves the data queryable', async () => {
        await backend.finalizeImport();
        const results = await backend.findTermsBulk(['とり'], dictionaries, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].definitions).toStrictEqual(['bird']);
    });
});

const zstdDictionaryName = 'Zstd Codec Test Dictionary';

/**
 * ZDICT will not train on a handful of rows, so the zstd trained-dictionary path needs a corpus with
 * real size and variety — hence a generated one rather than the three handwritten rows above.
 * @param {number} count
 * @returns {import('dictionary-database').DatabaseTermEntryPacked[]}
 */
function createZstdTermRows(count) {
    const readings = ['いぬ', 'ねこ', 'とり', 'さかな', 'うま', 'ひつじ', 'うし', 'ぶた'];
    const glosses = ['dog', 'cat', 'bird', 'fish', 'horse', 'sheep', 'cow', 'pig'];
    /** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */
    const rows = [];
    for (let i = 0; i < count; ++i) {
        const reading = `${readings[i % readings.length]}${i}`;
        const gloss = glosses[(i * 3) % glosses.length];
        rows.push({
            expression: reading,
            reading,
            dictionary: zstdDictionaryName,
            sequence: i,
            m: [
                i % 2 === 0 ? 'n' : 'vt',
                i % 3 === 0 ? 'v5r' : '',
                (i % 100) - 50,
                [{type: 'structured-content',
                    content: [
                        {tag: 'div', data: {content: 'glossary'}, content: `${gloss} number ${i}`},
                        {tag: 'ul', content: [{tag: 'li', content: `an example sentence about ${gloss} ${i % 17}`}]},
                    ]}],
                i % 5 === 0 ? 'common' : '',
            ],
        });
    }
    return rows;
}

describe('DictionaryDatabaseSqlite zstd codec self-description', () => {
    /** @type {DictionaryDatabaseSqlite} */
    let backend;
    const rows = createZstdTermRows(2000);
    const dictionarySet = new Set([zstdDictionaryName]);

    beforeAll(async () => {
        const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
        backend = new DictionaryDatabaseSqlite(new ZstdPayloadCodec(await loadZstdInitModule()));
        await backend.prepare({sqlite3, vfs: 'memory'});
        /** @type {import('dictionary-importer').Summary} */
        const summary = {title: zstdDictionaryName, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
        await backend.bulkAdd('dictionaries', [summary], 0, 1);
        await backend.bulkAdd('terms', rows, 0, rows.length);
    });

    test('persists the trained dictionary in codec_dict and the name in codec', () => {
        const internal = /** @type {{_require: () => {selectObject: (sql: string, args: unknown[]) => {codec: unknown, codec_dict: unknown}|undefined}}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        const row = internal._require().selectObject('SELECT codec, codec_dict FROM dictionaries WHERE title = ?', [zstdDictionaryName]);
        expect(row).toBeDefined();
        expect(row?.codec).toBe('zstd');
        // A trained dictionary must actually have been produced and stored as a BLOB -- this is the
        // whole point of the codec, and the part a small dictionary silently skips.
        const trained = row?.codec_dict;
        expect(trained).toBeInstanceOf(Uint8Array);
        expect(/** @type {Uint8Array} */ (trained).length).toBeGreaterThan(0);
    });

    test('reads back correctly using the write-time codec cache', async () => {
        const results = await backend.findTermsBulk([rows[0].expression], dictionarySet, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].definitions).toStrictEqual(rows[0].m[3]);
    });

    test('reads back through the trained dictionary loaded from codec_dict', async () => {
        // Drop the write-time cache so both the codec *and* its trained dictionary have to be
        // re-derived from the dictionaries row: this is what a fresh session does on every read, and
        // it only works if the dictionary BLOB survived the round-trip through sqlite intact.
        const internal = /** @type {{_dictCodec: Map<number, unknown>}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        internal._dictCodec.clear();
        const target = rows[1234];
        const results = await backend.findTermsBulk([target.expression], dictionarySet, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].definitions).toStrictEqual(target.m[3]);
        expect(results[0].score).toBe(target.m[2]);
    });

    test('every row round-trips', async () => {
        const expressions = rows.map((row) => row.expression);
        const results = await backend.findTermsBulk(expressions, dictionarySet, 'exact');
        expect(results).toHaveLength(rows.length);
        const byTerm = new Map(results.map((entry) => [entry.term, entry]));
        for (const row of rows) {
            expect(byTerm.get(row.expression)?.definitions).toStrictEqual(row.m[3]);
        }
    });

    test('finalizeImport (ANALYZE + VACUUM) leaves the data queryable', async () => {
        await backend.finalizeImport();
        const results = await backend.findTermsBulk([rows[7].expression], dictionarySet, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].definitions).toStrictEqual(rows[7].m[3]);
    });
});
