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
import {describe, expect, test} from 'vitest';
import {DICTIONARY_SQLITE_SCHEMA_VERSION, DICTIONARY_SQLITE_TABLES} from '../ext/js/dictionary/sqlite/dictionary-sqlite-schema.js';
import {openDictionaryDatabaseHandle} from '../ext/js/dictionary/sqlite/open-sqlite.js';
import {IdentityPayloadCodec} from '../ext/js/dictionary/payload-codec.js';

// Stage 1 de-risk (plan.md §10/§11): confirm the SQLite-WASM backend can run under the vitest
// (node) runner with an in-memory database, that BLOB columns round-trip as Uint8Array, and
// that the PayloadCodec survives a store/load through a BLOB column. This is the test-harness
// foundation the real SQLite DictionaryDatabase tests will build on.

describe('sqlite-wasm backend smoke test', () => {
    test('runs in-memory under vitest and round-trips a codec payload through a BLOB', async () => {
        const sqlite3 = await sqlite3InitModule();
        expect(typeof sqlite3.version.libVersion).toBe('string');

        const db = new sqlite3.oo1.DB(':memory:');
        try {
            db.exec('CREATE TABLE terms (id INTEGER PRIMARY KEY, expression TEXT NOT NULL, payload BLOB NOT NULL)');
            db.exec('CREATE INDEX ix_terms_expr ON terms(expression)');

            const codec = new IdentityPayloadCodec();
            // Shape mirrors DatabaseTermEntryPayload: [definitionTags, rules, score, glossary, termTags].
            /** @type {unknown[][]} */
            const payloads = [
                ['n', 'v5', 0, ['a simple gloss'], 'tag1'],
                [null, '', -3, [{type: 'structured-content', content: [{tag: 'div', content: 'hallo'}]}, 'zweite'], void 0],
                ['adj', 'v1 vt', 42, [{type: 'text', text: 'text node'}], ''],
            ];

            const insert = db.prepare('INSERT INTO terms(expression, payload) VALUES(?, ?)');
            try {
                for (let i = 0; i < payloads.length; i++) {
                    insert.bind(1, `wort${i}`).bind(2, codec.encode(payloads[i], null)).stepReset();
                }
            } finally {
                insert.finalize();
            }

            expect(db.selectValue('SELECT count(*) FROM terms')).toBe(payloads.length);

            for (let i = 0; i < payloads.length; i++) {
                const row = db.selectObject('SELECT expression, payload FROM terms WHERE expression = ?', [`wort${i}`]);
                if (typeof row === 'undefined') { throw new Error(`row wort${i} not found`); }
                expect(row.expression).toBe(`wort${i}`);
                expect(row.payload).toBeInstanceOf(Uint8Array);
                const decoded = codec.decode(/** @type {Uint8Array} */ (row.payload), null);
                // JSON round-trip turns `undefined` array elements into `null`; compare accordingly.
                expect(decoded).toStrictEqual(payloads[i].map((v) => (typeof v === 'undefined' ? null : v)));
            }

            // Prefix range query (the mechanism findTermsBulk 'prefix' will use).
            const prefixCount = db.selectValue(
                'SELECT count(*) FROM terms WHERE expression >= ? AND expression < ?',
                ['wort', 'wort￿'],
            );
            expect(prefixCount).toBe(payloads.length);
        } finally {
            db.close();
        }
    });

    test('openDictionaryDatabaseHandle creates the full dictionary schema (memory VFS)', async () => {
        // The package ships its own (browser-oriented) types; the backend uses the narrow
        // `Sqlite3Module` surface, so cast the injected module at this boundary.
        const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
        const db = await openDictionaryDatabaseHandle(sqlite3, {vfs: 'memory'});
        try {
            const tables = db.selectObjects("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .map((row) => row.name);
            for (const expected of DICTIONARY_SQLITE_TABLES) {
                expect(tables).toContain(expected);
            }
            expect(db.selectValue('PRAGMA user_version')).toBe(DICTIONARY_SQLITE_SCHEMA_VERSION);
            // Schema creation is idempotent (re-open path).
            expect(() => openDictionaryDatabaseHandle(sqlite3, {vfs: 'memory'})).not.toThrow();
        } finally {
            db.close();
        }
    });
});
