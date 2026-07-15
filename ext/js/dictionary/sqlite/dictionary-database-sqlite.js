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

import {IdentityPayloadCodec} from '../payload-codec.js';
import {openDictionaryDatabaseHandle} from './open-sqlite.js';

/**
 * SQLite-WASM implementation of the dictionary store. Mirrors the parts of the `DictionaryDatabase`
 * public API that the translator and importer use, but stores rows columnar in SQLite (see
 * plan/design.md §8): the heavy non-indexed term fields live compressed in `terms.payload` via a
 * payload codec (see payload-codec.js), and the repeated dictionary title becomes an integer
 * `dictionary_id`.
 *
 * The `sqlite3` module is injected (see plan/decisions.md #9): the extension DB worker builds it
 * from the vendored browser build and passes `vfs: 'opfs'`; node tests build it from the package
 * and pass `vfs: 'memory'`.
 *
 * Stage 1 scope: the term write path (`bulkAdd('terms'|'dictionaries')`) and the term read path
 * (`findTermsBulk`, `findTermsExactBulk`). The remaining stores/queries land in Stage 2.
 */
export class DictionaryDatabaseSqlite {
    /**
     * @param {import('payload-codec').PayloadCodec} [codec] Defaults to the identity (JSON, no
     *   compression) codec; a compressing codec is swapped in later (Stage 3).
     */
    constructor(codec = new IdentityPayloadCodec()) {
        /** @type {import('sqlite-wasm').SqliteDatabaseHandle?} */
        this._db = null;
        /** @type {import('payload-codec').PayloadCodec} */
        this._codec = codec;
        /** @type {Map<string, number>} */
        this._titleToId = new Map();
        /** @type {Map<number, string>} */
        this._idToTitle = new Map();
    }

    /**
     * Opens the database and loads the dictionary id<->title cache.
     * @param {{sqlite3: import('sqlite-wasm').Sqlite3Module, vfs?: import('sqlite-wasm').SqliteVfs, path?: string, initialCapacity?: number}} options
     * @returns {Promise<void>}
     */
    async prepare({sqlite3, vfs = 'memory', path, initialCapacity}) {
        if (this._db !== null) { throw new Error('Database already open'); }
        this._db = await openDictionaryDatabaseHandle(sqlite3, {vfs, path, initialCapacity});
        this._titleToId.clear();
        this._idToTitle.clear();
        for (const row of this._db.selectObjects('SELECT id, title FROM dictionaries')) {
            this._cacheDictionary(/** @type {number} */ (row.id), /** @type {string} */ (row.title));
        }
    }

    /** @returns {boolean} */
    isPrepared() {
        return this._db !== null;
    }

    /** @returns {void} */
    close() {
        if (this._db === null) { return; }
        this._db.close();
        this._db = null;
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    async dictionaryExists(title) {
        return this._titleToId.has(title) || typeof this._require().selectValue('SELECT id FROM dictionaries WHERE title = ?', [title]) === 'number';
    }

    /**
     * @template {import('dictionary-database').ObjectStoreName} T
     * @param {T} objectStoreName
     * @param {import('dictionary-database').ObjectStoreData<T>[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async bulkAdd(objectStoreName, items, start, count) {
        const end = Math.min(start + count, items.length);
        if (end <= start) { return; }
        switch (objectStoreName) {
            case 'terms':
                this._bulkAddTerms(/** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */ (items), start, end);
                return;
            case 'dictionaries':
                this._bulkAddDictionaries(/** @type {import('dictionary-importer').Summary[]} */ (items), start, end);
                return;
            default:
                throw new Error(`bulkAdd not implemented for store '${objectStoreName}'`);
        }
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @param {import('dictionary-database').MatchType} matchType
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBulk(termList, dictionaries, matchType) {
        const dictionaryIds = this._enabledDictionaryIds(dictionaries);
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        if (termList.length === 0 || dictionaryIds.length === 0) { return results; }
        // Mirror DictionaryDatabase.findTermsBulk: query the expression column (matchSource 'term')
        // then the reading column (matchSource 'reading'), deduplicating physical rows across the
        // whole result by id, exactly as the shared `visited` set does.
        const visited = new Set();
        for (let i = 0, ii = termList.length; i < ii; ++i) {
            const term = termList[i];
            for (const matchSource of /** @type {import('dictionary-database').MatchSource[]} */ (['term', 'reading'])) {
                const column = matchSource === 'term' ? 'expression' : 'reading';
                for (const row of this._queryTermColumn(column, term, matchType, dictionaryIds)) {
                    const id = /** @type {number} */ (row.id);
                    if (visited.has(id)) { continue; }
                    visited.add(id);
                    // _createTermGeneric: exact when the matched column value equals the query term.
                    const rowMatchType = row[column] === term ? 'exact' : matchType;
                    results.push(this._createTerm(matchSource, rowMatchType, row, i));
                }
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').TermExactRequest[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsExactBulk(termList, dictionaries) {
        const dictionaryIds = this._enabledDictionaryIds(dictionaries);
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        if (termList.length === 0 || dictionaryIds.length === 0) { return results; }
        // Mirror DictionaryDatabase.findTermsExactBulk: expression-only, no id dedup, filter reading.
        for (let i = 0, ii = termList.length; i < ii; ++i) {
            const {term, reading} = termList[i];
            for (const row of this._queryTermColumn('expression', term, 'exact', dictionaryIds)) {
                if (row.reading !== reading) { continue; }
                results.push(this._createTerm('term', 'exact', row, i));
            }
        }
        return results;
    }

    // Private

    /**
     * @param {import('dictionary-database').DatabaseTermEntryPacked[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _bulkAddTerms(items, start, end) {
        const db = this._require();
        db.transaction((tx) => {
            const statement = tx.prepare('INSERT INTO terms(dictionary_id, expression, reading, sequence, payload) VALUES(?, ?, ?, ?, ?)');
            try {
                for (let i = start; i < end; ++i) {
                    const item = items[i];
                    const dictionaryId = this._resolveDictionaryId(item.dictionary);
                    const sequence = typeof item.sequence === 'number' ? item.sequence : null;
                    const payload = this._codec.encode(item.m, null);
                    statement
                        .bind(1, dictionaryId)
                        .bind(2, item.expression)
                        .bind(3, item.reading)
                        .bind(4, sequence)
                        .bind(5, payload)
                        .stepReset();
                }
            } finally {
                statement.finalize();
            }
        });
    }

    /**
     * @param {import('dictionary-importer').Summary[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _bulkAddDictionaries(items, start, end) {
        for (let i = start; i < end; ++i) {
            const summary = items[i];
            this._upsertDictionary(summary);
        }
    }

    /**
     * @param {import('dictionary-importer').Summary} summary
     * @returns {number}
     */
    _upsertDictionary(summary) {
        const db = this._require();
        const id = /** @type {number} */ (db.selectValue(
            'INSERT INTO dictionaries(title, revision, version, summary_json) VALUES(?, ?, ?, ?)' +
            ' ON CONFLICT(title) DO UPDATE SET revision = excluded.revision, version = excluded.version, summary_json = excluded.summary_json' +
            ' RETURNING id',
            [summary.title, summary.revision, summary.version, JSON.stringify(summary)],
        ));
        this._cacheDictionary(id, summary.title);
        return id;
    }

    /**
     * Resolves the integer id for a dictionary title, inserting a bare row if the title is not yet
     * known. Term rows carry only their dictionary title, so this backfills the id on import.
     * @param {string} title
     * @returns {number}
     */
    _resolveDictionaryId(title) {
        const cached = this._titleToId.get(title);
        if (typeof cached === 'number') { return cached; }
        const db = this._require();
        let id = db.selectValue('SELECT id FROM dictionaries WHERE title = ?', [title]);
        if (typeof id !== 'number') {
            id = db.selectValue('INSERT INTO dictionaries(title) VALUES(?) RETURNING id', [title]);
        }
        this._cacheDictionary(/** @type {number} */ (id), title);
        return /** @type {number} */ (id);
    }

    /**
     * @param {number} id
     * @param {string} title
     * @returns {void}
     */
    _cacheDictionary(id, title) {
        this._titleToId.set(title, id);
        this._idToTitle.set(id, title);
    }

    /**
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {number[]}
     */
    _enabledDictionaryIds(dictionaries) {
        /** @type {number[]} */
        const ids = [];
        for (const [title, id] of this._titleToId) {
            if (dictionaries.has(title)) { ids.push(id); }
        }
        return ids;
    }

    /**
     * Fetches the term rows matching a single query term on one indexed column, restricted to the
     * enabled dictionaries. `matchType` selects exact / prefix / suffix semantics matching the
     * IndexedDB `IDBKeyRange` queries in `DictionaryDatabase`.
     * @param {'expression'|'reading'} column
     * @param {string} term
     * @param {import('dictionary-database').MatchType} matchType
     * @param {number[]} dictionaryIds
     * @returns {import('sqlite-wasm').SqlRow[]}
     */
    _queryTermColumn(column, term, matchType, dictionaryIds) {
        const db = this._require();
        const idFilter = `dictionary_id IN (${dictionaryIds.join(',')})`;
        const select = 'SELECT id, dictionary_id, expression, reading, sequence, payload FROM terms';
        switch (matchType) {
            case 'prefix':
                // Inclusive bound [term, term+'￿'], matching IDBKeyRange.bound(term, term+'￿').
                // Valid for BMP strings, where SQLite BINARY (UTF-8) and IndexedDB (UTF-16) code-point
                // orders agree; dictionary data is BMP.
                return db.selectObjects(
                    `${select} WHERE ${column} >= ? AND ${column} <= ? || char(65535) AND ${idFilter}`,
                    [term, term],
                );
            case 'suffix': {
                // No reverse column yet (that is a later schema addition, see plan/progress.md
                // "watch-outs"); filter suffix matches in JS over the enabled dictionaries.
                const rows = db.selectObjects(`${select} WHERE ${idFilter}`);
                return rows.filter((row) => typeof row[column] === 'string' && /** @type {string} */ (row[column]).endsWith(term));
            }
            default: // 'exact'
                return db.selectObjects(`${select} WHERE ${column} = ? AND ${idFilter}`, [term]);
        }
    }

    /**
     * Builds a `TermEntry` with the same shaping as `DictionaryDatabase._createTerm`.
     * @param {import('dictionary-database').MatchSource} matchSource
     * @param {import('dictionary-database').MatchType} matchType
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').TermEntry}
     */
    _createTerm(matchSource, matchType, row, index) {
        const decoded = this._codec.decode(/** @type {Uint8Array} */ (row.payload), null);
        const [definitionTags, rules, score, glossary, termTags] = /** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (
            Array.isArray(decoded) ? decoded : []
        );
        const {sequence} = row;
        return {
            index,
            matchType,
            matchSource,
            term: /** @type {string} */ (row.expression),
            reading: /** @type {string} */ (row.reading),
            definitionTags: this._splitField(definitionTags),
            termTags: this._splitField(termTags),
            rules: this._splitField(rules),
            definitions: glossary,
            score,
            dictionary: /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id))),
            id: /** @type {number} */ (row.id),
            sequence: typeof sequence === 'number' ? sequence : -1,
        };
    }

    /**
     * @param {unknown} field
     * @returns {string[]}
     */
    _splitField(field) {
        return typeof field === 'string' && field.length > 0 ? field.split(' ') : [];
    }

    /**
     * @returns {import('sqlite-wasm').SqliteDatabaseHandle}
     * @throws {Error} If the database is not open.
     */
    _require() {
        if (this._db === null) { throw new Error('Database not open'); }
        return this._db;
    }
}
