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

import {parseJson} from '../../core/json.js';
import {IdentityPayloadCodec} from '../payload-codec.js';
import {requestPersistentStorage} from './dictionary-storage-migration.js';
import {DICTIONARY_SQLITE_TABLES} from './dictionary-sqlite-schema.js';
import {buildInflectionTable, deriveLemmas, deserializeInflectionTable, isDerivable, serializeInflectionTable} from './inflection-rules.js';
import {openDictionaryDatabaseHandle} from './open-sqlite.js';

/**
 * Maps an IndexedDB-era object-store name to its SQLite table. The public API keeps the old store
 * names (the importer and callers use them); the columnar tables use snake_case.
 * @type {Record<import('dictionary-database').ObjectStoreName, string>}
 */
const STORE_TABLE = {
    dictionaries: 'dictionaries',
    terms: 'terms',
    termMeta: 'term_meta',
    kanji: 'kanji',
    kanjiMeta: 'kanji_meta',
    tagMeta: 'tag_meta',
    media: 'media',
};

/**
 * How many prepared statements to hold. The term queries interpolate the enabled dictionary ids, so
 * the distinct SQL texts are (column × matchType × the dictionary subsets in use) — a handful in
 * practice. The cap only exists so that toggling dictionaries can never grow the cache without end.
 */
const STATEMENT_CACHE_SIZE = 32;

/**
 * Default inflection-rule budget. 1,000 derives 76.6% of `kty-de-en`'s form-of rows while keeping a
 * hover at ~0.2 ms — the knee of the measured curve (plan/sizing/README.md §5.4).
 */
const DEFAULT_RULE_BUDGET = 1000;

/**
 * Everything a dropped form-of row carried apart from its glossary and its expression, in the order
 * `[definitionTags, rules, score, termTags, sequence, readingMirrorsExpression]`.
 *
 * Of these only `rules` reaches a reader, gating the parts-of-speech filter in
 * `translator._matchEntriesToDeinflections`. The rest are carried so a synthesized row is
 * indistinguishable from the one it replaces, which is what lets the two be tested by equality.
 *
 * `readingMirrorsExpression` exists because **the importer never writes an empty reading**:
 * `dictionary-importer.js`'s `_convertTermBankEntryV3` does `reading = reading.length > 0 ? reading
 * : expression`, so on a German dictionary every row has `reading === expression` rather than `''`.
 * A row whose reading is neither empty nor the expression is reachable through the reading probe by
 * a *different* string, which synthesis (keyed on the expression) could not answer — those are never
 * dropped. The flag says which of the two droppable cases a row was, so the reading can be rebuilt.
 *
 * The field types mirror `DatabaseTermEntryPayload`. Note that a `termTags` of `undefined` comes back
 * as `null` through a JSON codec; `_splitField` maps both to the same empty list, so the round-trip
 * is still faithful where it counts.
 * @typedef {[definitionTags: string|null, rules: string, score: number, termTags: string|undefined, sequence: number, readingMirrorsExpression: boolean]} StubTemplate
 */

/**
 * How many row ids to name in one `DELETE ... WHERE id IN (...)`. SQLITE_MAX_VARIABLE_NUMBER is 32k
 * in recent builds but the statement text is what actually costs here, so keep the batches modest.
 */
const DELETE_BATCH_SIZE = 512;

/**
 * Memoized vendored sqlite3 module.
 *
 * This MUST be a singleton: `installOpfsSAHPoolVfs` caches its pool per VFS name *inside a single
 * sqlite3 instance*, and the pool holds exclusive OPFS sync access handles for the whole session.
 * Calling `sqlite3InitModule()` a second time builds an independent runtime whose pool then tries
 * to re-acquire handles the first one still owns, which fails with `InvalidStateError` ("The object
 * is in an invalid state"). That happens on any close/reopen — notably `purge()`, which closes and
 * re-prepares. Verified against real Safari by `npm run test:safari`.
 * @type {Promise<import('sqlite-wasm').Sqlite3Module>?}
 */
let vendoredSqlite3Promise = null;

/**
 * @returns {Promise<import('sqlite-wasm').Sqlite3Module>}
 */
function loadVendoredSqlite3() {
    if (vendoredSqlite3Promise === null) {
        vendoredSqlite3Promise = (async () => {
            // Vendored ESM build (dev/build-libs.js -> ext/lib/sqlite3.js); the dynamic import keeps
            // the WASM out of the module graph when the SQLite backend is not selected.
            const {default: sqlite3InitModule} = await import('../../../lib/sqlite3.js');
            return /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
        })();
    }
    return vendoredSqlite3Promise;
}

/**
 * SQLite-WASM implementation of the dictionary store. A drop-in for the IndexedDB
 * `DictionaryDatabase` at the public-API level (same method names/semantics), but stores rows
 * columnar in SQLite (see plan/01-design.md §8): the heavy non-indexed term/kanji fields live in a
 * `payload` BLOB encoded through a payload codec (see payload-codec.js), and the repeated
 * dictionary title becomes an integer `dictionary_id`.
 *
 * The `sqlite3` module is injected (see plan/02-decisions.md #10): the extension DB worker builds it
 * from the vendored browser build and passes `vfs: 'opfs'`; node tests build it from the package
 * and pass `vfs: 'memory'`.
 */
export class DictionaryDatabaseSqlite {
    /**
     * @param {import('payload-codec').PayloadCodec} [codec] The codec used to write new imports.
     *   Defaults to the identity (JSON, no compression) codec.
     * @param {import('payload-codec').PayloadCodec[]} [decodeCodecs] Extra codecs available for
     *   decoding rows written by a different codec (rows are self-describing via the `codec`
     *   column). The write codec and an identity codec are always registered.
     * @param {{trainSampleSize?: number, ruleBudget?: number}} [options] `trainSampleSize` is how
     *   many payloads a compressing codec trains its per-dictionary dictionary from; `ruleBudget` is
     *   how many inflection rules to induce per dictionary. See the fields below for both.
     */
    constructor(codec = new IdentityPayloadCodec(), decodeCodecs = [], {trainSampleSize = 1000, ruleBudget = DEFAULT_RULE_BUDGET} = {}) {
        /** @type {import('sqlite-wasm').SqliteDatabaseHandle?} */
        this._db = null;
        /** @type {import('payload-codec').PayloadCodec} The write/default codec for new imports. */
        this._codec = codec;
        /** @type {import('payload-codec').PayloadCodec} Always-available fallback for decode. */
        this._identityCodec = new IdentityPayloadCodec();
        /** @type {Map<string, import('payload-codec').PayloadCodec>} name -> codec, for decode. */
        this._codecRegistry = new Map();
        for (const registered of [this._identityCodec, codec, ...decodeCodecs]) {
            this._codecRegistry.set(registered.name, registered);
        }
        /** @type {Map<number, {codec: import('payload-codec').PayloadCodec, dict: ?Uint8Array}>} */
        this._dictCodec = new Map();
        /**
         * Per-dictionary inflection rules for the query path, or null for a dictionary that had no
         * rows dropped and therefore needs no synthesis. Cached because a lookup consults this on
         * every hover and the blob is 1.42 MB on `kty-de-en` — decoding it per query would cost more
         * than the rows it replaced.
         * @type {Map<number, ?{table: import('./inflection-rules.js').InflectionTable, template: StubTemplate}>}
         */
        this._inflectionCache = new Map();
        /**
         * Prepared statements for the read paths, keyed by SQL text, least-recently-used last.
         *
         * `selectObjects` compiles *and finalizes* a statement on every call, and a lookup issues one
         * query per deinflection candidate, so on a real hover compilation — not the index seek —
         * dominates: 434 candidates cost 9.44 ms re-prepared versus 1.52 ms with the statements held
         * (plan/sizing/README.md §5.4). Bounded because the term queries interpolate the enabled
         * dictionary ids, so the SQL text varies with which dictionaries are switched on.
         * @type {Map<string, import('sqlite-wasm').SqliteStatement>}
         */
        this._statements = new Map();
        /** @type {Map<string, number>} */
        this._titleToId = new Map();
        /** @type {Map<number, string>} */
        this._idToTitle = new Map();
        /**
         * How many payloads to sample when training a per-dictionary codec dictionary.
         *
         * The ceiling is the importer's batch size (`maxTransactionLength`, 1000), because training
         * happens on the first `bulkAdd` batch — a larger value here does nothing on its own. It is
         * a knob because a codec with a large shared dictionary needs proportionally more samples,
         * which means buffering more of the import before the first insert. deflate's dictionary is
         * capped at DEFLATE's 32 KB window, so 1000 rows already saturate it. `npm run
         * measure:storage` re-derives the tradeoff; plan/zstd/README.md records it.
         * @type {number}
         */
        this._trainSampleSize = trainSampleSize;
        /**
         * How many inflection rules to induce per dictionary, ranked by how many lemmas use them.
         *
         * The size/latency knob (plan/02-decisions.md #31): every kept rule is another candidate to
         * generate and look up on every hover, and every rule left out means its forms must stay as
         * rows. Measured on the real `kty-de-en`: 1,000 rules derive 76.6% of the 852,139 form-of
         * rows at ~0.2 ms per hover, where all 70,247 derive 100% at ~3.4 ms. 0 disables induction.
         * @type {number}
         */
        this._ruleBudget = ruleBudget;
    }

    /**
     * Opens the database and loads the dictionary id<->title cache. Called with no arguments (as
     * `DictionaryDatabase.prepare()` is) it self-initializes sqlite3 from the vendored browser build
     * on the OPFS SAH-Pool VFS and requests persistent storage — this is the extension/worker path.
     * Tests inject `sqlite3` and use the in-memory VFS.
     * @param {{sqlite3?: import('sqlite-wasm').Sqlite3Module, vfs?: import('sqlite-wasm').SqliteVfs, path?: string, initialCapacity?: number}} [options]
     * @returns {Promise<void>}
     */
    async prepare(options) {
        if (this._db !== null) { throw new Error('Database already open'); }
        let {sqlite3} = options ?? {};
        const {vfs = typeof sqlite3 === 'undefined' ? 'opfs' : 'memory', path, initialCapacity} = options ?? {};
        if (typeof sqlite3 === 'undefined') {
            sqlite3 = await loadVendoredSqlite3();
        }
        await this._prepareCodecs();
        this._db = await openDictionaryDatabaseHandle(sqlite3, {vfs, path, initialCapacity});
        this._loadDictionaryCache();
        if (vfs === 'opfs') { await requestPersistentStorage(); }
    }

    /**
     * Initializes every registered codec before the first row is read or written. `encode`/`decode`
     * are synchronous (they run inside sqlite's synchronous query/transaction paths), so a codec
     * needing async setup — loading a WASM module — has to do it here; a read of already-imported
     * rows never calls `train()` and would otherwise have no async moment to initialize in.
     * @returns {Promise<void>}
     */
    async _prepareCodecs() {
        for (const codec of this._codecRegistry.values()) {
            if (typeof codec.prepare === 'function') { await codec.prepare(); }
        }
    }

    /** @returns {boolean} */
    isPrepared() {
        return this._db !== null;
    }

    /** @returns {void} */
    close() {
        if (this._db === null) { return; }
        this._finalizeStatements();
        this._db.close();
        this._db = null;
        this._titleToId.clear();
        this._idToTitle.clear();
        this._dictCodec.clear();
        this._inflectionCache.clear();
    }

    /**
     * Returns a held prepared statement for `sql`, compiling it on first use. The statement is
     * always returned reset and unbound, and callers must fully drain it before requesting the same
     * SQL again — every caller here materializes its rows before returning, so no query nests inside
     * another.
     * @param {string} sql
     * @returns {import('sqlite-wasm').SqliteStatement}
     */
    _cachedStatement(sql) {
        const cached = this._statements.get(sql);
        if (typeof cached !== 'undefined') {
            // Re-insert to mark it most-recently-used; Map iterates in insertion order.
            this._statements.delete(sql);
            this._statements.set(sql, cached);
            return cached;
        }
        const statement = this._require().prepare(sql);
        this._statements.set(sql, statement);
        if (this._statements.size > STATEMENT_CACHE_SIZE) {
            const oldest = this._statements.keys().next();
            if (!oldest.done) {
                const evicted = this._statements.get(oldest.value);
                this._statements.delete(oldest.value);
                if (typeof evicted !== 'undefined') { evicted.finalize(); }
            }
        }
        return statement;
    }

    /**
     * `SqliteDatabaseHandle.selectObjects` with the statement held rather than recompiled per call.
     * @param {string} sql
     * @param {import('sqlite-wasm').SqlBind} [args]
     * @returns {import('sqlite-wasm').SqlRow[]}
     */
    _selectObjects(sql, args) {
        const statement = this._cachedStatement(sql);
        /** @type {import('sqlite-wasm').SqlRow[]} */
        const rows = [];
        try {
            if (typeof args !== 'undefined') { statement.bind(args); }
            while (statement.step()) { rows.push(statement.get({})); }
        } finally {
            statement.reset(true);
        }
        return rows;
    }

    /**
     * Like `_selectObjects` but yields each row instead of materializing them all, for the queries
     * that walk a whole table: `_selectObjects` on `kty-de-en`'s 947,070 terms would hold every
     * payload BLOB live at once, hundreds of MB inside a browser extension, purely to iterate them.
     *
     * Uses its own statement rather than the LRU: these run once per import, and an abandoned
     * generator would otherwise leave a cached statement mid-step for the next caller of that SQL.
     * @param {string} sql
     * @param {import('sqlite-wasm').SqlBind} [args]
     * @yields {import('sqlite-wasm').SqlRow}
     * @returns {Generator<import('sqlite-wasm').SqlRow, void, void>}
     */
    *_iterateObjects(sql, args) {
        const statement = this._require().prepare(sql);
        try {
            if (typeof args !== 'undefined') { statement.bind(args); }
            while (statement.step()) { yield statement.get({}); }
        } finally {
            statement.finalize();
        }
    }

    /**
     * `SqliteDatabaseHandle.selectObject` with the statement held rather than recompiled per call.
     * @param {string} sql
     * @param {import('sqlite-wasm').SqlBind} [args]
     * @returns {import('sqlite-wasm').SqlRow|undefined}
     */
    _selectObject(sql, args) {
        const statement = this._cachedStatement(sql);
        try {
            if (typeof args !== 'undefined') { statement.bind(args); }
            return statement.step() ? statement.get({}) : void 0;
        } finally {
            statement.reset(true);
        }
    }

    /** @returns {void} */
    _finalizeStatements() {
        for (const statement of this._statements.values()) { statement.finalize(); }
        this._statements.clear();
    }

    /**
     * Drops all dictionary data (mirrors `DictionaryDatabase.purge`).
     * @returns {Promise<boolean>}
     */
    async purge() {
        const db = this._require();
        db.transaction((tx) => {
            for (const table of DICTIONARY_SQLITE_TABLES) {
                tx.exec(`DELETE FROM ${table}`);
            }
        });
        db.exec('VACUUM');
        this._titleToId.clear();
        this._idToTitle.clear();
        this._dictCodec.clear();
        this._inflectionCache.clear();
        return true;
    }

    /**
     * Compacts and re-analyzes the database after a large import: `ANALYZE` refreshes the query
     * planner statistics and `VACUUM` reclaims free pages and defragments the file. Call once after
     * an import (or deletion) completes; both are no-ops mid-transaction so run them standalone.
     * @returns {Promise<void>}
     */
    async finalizeImport() {
        const db = this._require();
        for (const dictionaryId of this._idToTitle.keys()) {
            this._buildInflectionTable(dictionaryId);
            this._dropDerivableRows(dictionaryId);
        }
        db.exec('ANALYZE');
        db.exec('VACUUM');
    }

    /**
     * Deletes the form-of rows this dictionary's own rules can reproduce, and records the payload
     * they shared so `findTermsBulk` can synthesize them back (plan/02-decisions.md #34). This is
     * where the size win is actually taken: everything before it only measured the win.
     *
     * A row is only dropped when all three hold, so that anything the scheme cannot reproduce
     * exactly stays a row and costs space instead of correctness:
     *   - it is a pure stub (no real glossary text a reader would lose) whose reading is either
     *     empty or the expression itself — a reading that is some *other* string can be found by a
     *     reading probe that synthesis, keyed on the expression, could never answer,
     *   - the rules derive every pair it states (not merely some — a row is dropped whole),
     *   - its non-glossary fields equal the template, which the first droppable row establishes.
     * @param {number} dictionaryId
     * @returns {void}
     */
    _dropDerivableRows(dictionaryId) {
        if (this._ruleBudget <= 0) { return; }
        const db = this._require();
        // Non-null means this dictionary's rows were already dropped; re-running would be a no-op but
        // would re-scan every payload, and finalizeImport runs again for each new dictionary.
        if (db.selectValue('SELECT stub_template IS NOT NULL FROM dictionaries WHERE id = ?', [dictionaryId]) === 1) { return; }
        const table = this._loadInflectionTable(dictionaryId);
        if (table === null) { return; }

        /** @type {?StubTemplate} */
        let template = null;
        /** @type {number[]} */
        const ids = [];
        for (const row of this._readFormOfRows(dictionaryId)) {
            if (!row.pureStub || (row.reading.length > 0 && row.reading !== row.form)) { continue; }
            if (!row.pairs.every(({lemma}) => isDerivable(table, row.form, lemma))) { continue; }
            if (template === null) {
                template = row.template;
            } else if (!this._templatesMatch(template, row.template)) {
                continue;
            }
            ids.push(row.id);
        }
        if (template === null || ids.length === 0) { return; }

        const {codec, dict} = this._getDictCodec(dictionaryId);
        const encodedTemplate = codec.encode(/** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (/** @type {unknown} */ (template)), dict);
        db.transaction(() => {
            for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
                const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
                db.exec(`DELETE FROM terms WHERE id IN (${batch.join(',')})`);
            }
            const statement = db.prepare('UPDATE dictionaries SET stub_template = ? WHERE id = ?');
            try {
                statement.bind([encodedTemplate, dictionaryId]).stepReset();
            } finally {
                statement.finalize();
            }
        });
        // The deletes invalidate any cached decision about this dictionary.
        this._inflectionCache.delete(dictionaryId);
    }

    /**
     * @param {StubTemplate} a
     * @param {StubTemplate} b
     * @returns {boolean}
     */
    _templatesMatch(a, b) {
        for (let i = 0; i < a.length; ++i) {
            if (a[i] !== b[i]) { return false; }
        }
        return true;
    }

    /**
     * Induces this dictionary's inflection rules from its own form-of entries and stores them, so
     * that a later import can leave out the rows the rules already derive (plan/02-decisions.md #31).
     *
     * Runs here rather than during `bulkAdd` because the ranking needs every pair before it can pick
     * any rule, and the importer streams. Skips a dictionary that already has a table, so calling
     * `finalizeImport` again after adding a second dictionary does not redo the first.
     * @param {number} dictionaryId
     * @returns {void}
     */
    _buildInflectionTable(dictionaryId) {
        if (this._ruleBudget <= 0) { return; }
        const db = this._require();
        if (db.selectValue('SELECT inflection_table IS NOT NULL FROM dictionaries WHERE id = ?', [dictionaryId]) === 1) { return; }
        const pairs = [...this._readFormOfPairs(dictionaryId)];
        if (pairs.length === 0) { return; }
        const table = buildInflectionTable(pairs, {ruleBudget: this._ruleBudget});
        if (table.rules.length === 0) { return; }
        const {codec, dict} = this._getDictCodec(dictionaryId);
        const encoded = codec.encode(serializeInflectionTable(table), dict);
        const statement = db.prepare('UPDATE dictionaries SET inflection_table = ? WHERE id = ?');
        try {
            statement.bind([encoded, dictionaryId]).stepReset();
        } finally {
            statement.finalize();
        }
    }

    /**
     * Yields every row of this dictionary that states at least one `form -> lemma` pair, by decoding
     * its term payloads. A form-of entry is a glossary array `[formOf, inflectionRules]`, exactly
     * what `translator._getDictionaryDeinflections` follows.
     *
     * Row-level rather than pair-level because dropping is a per-row decision: a row is only
     * redundant if the rules derive *every* pair it states, and `pureStub` says whether it carries
     * real glossary text that would be lost with it.
     * @param {number} dictionaryId
     * @yields {{id: number, form: string, reading: string, pureStub: boolean, template: StubTemplate, pairs: {lemma: string, labels: string[]}[]}}
     * @returns {Generator<{id: number, form: string, reading: string, pureStub: boolean, template: StubTemplate, pairs: {lemma: string, labels: string[]}[]}, void, void>}
     */
    *_readFormOfRows(dictionaryId) {
        const {codec, dict} = this._getDictCodec(dictionaryId);
        for (const row of this._iterateObjects('SELECT id, expression, reading, sequence, payload FROM terms WHERE dictionary_id = ?', [dictionaryId])) {
            const [definitionTags, rules, score, glossary, termTags] = /** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (
                codec.decode(/** @type {Uint8Array} */ (row.payload), dict)
            );
            if (!Array.isArray(glossary)) { continue; }
            /** @type {{lemma: string, labels: string[]}[]} */
            const pairs = [];
            let arrays = 0;
            for (const entry of glossary) {
                if (!Array.isArray(entry)) { continue; }
                ++arrays;
                const [lemma, labels] = entry;
                if (typeof lemma !== 'string' || lemma.length === 0) { continue; }
                pairs.push({lemma, labels: Array.isArray(labels) ? labels.map(String) : []});
            }
            if (pairs.length === 0) { continue; }
            yield {
                id: /** @type {number} */ (row.id),
                form: /** @type {string} */ (row.expression),
                reading: /** @type {string} */ (row.reading),
                // A glossary entry that is not an array is real text a reader would see, so the row
                // has to stay whatever the rules can derive.
                pureStub: arrays === glossary.length && pairs.length === arrays,
                template: [definitionTags, rules, score, termTags, typeof row.sequence === 'number' ? row.sequence : 0, row.reading === row.expression],
                pairs,
            };
        }
    }

    /**
     * Yields every `form -> lemma` pair this dictionary states, for induction.
     * @param {number} dictionaryId
     * @yields {{form: string, lemma: string, labels: string[]}}
     * @returns {Generator<{form: string, lemma: string, labels: string[]}, void, void>}
     */
    *_readFormOfPairs(dictionaryId) {
        for (const {form, pairs} of this._readFormOfRows(dictionaryId)) {
            for (const {lemma, labels} of pairs) { yield {form, lemma, labels}; }
        }
    }

    /**
     * The inflection table imported with a dictionary, or null if it has none.
     * @param {string} dictionary
     * @returns {?import('./inflection-rules.js').InflectionTable}
     */
    getInflectionTable(dictionary) {
        const dictionaryId = this._titleToId.get(dictionary);
        return typeof dictionaryId === 'number' ? this._loadInflectionTable(dictionaryId) : null;
    }

    /**
     * Decodes a dictionary's stored rules. Uncached and ungated — the import path needs the rules
     * before it has dropped anything, which is exactly when `_getInflection` must still say no.
     * @param {number} dictionaryId
     * @returns {?import('./inflection-rules.js').InflectionTable}
     */
    _loadInflectionTable(dictionaryId) {
        const row = this._selectObject('SELECT inflection_table FROM dictionaries WHERE id = ?', [dictionaryId]);
        const blob = row?.inflection_table;
        if (!(blob instanceof Uint8Array)) { return null; }
        const {codec, dict} = this._getDictCodec(dictionaryId);
        return deserializeInflectionTable(codec.decode(blob, dict));
    }

    /**
     * The rules the query path should synthesize dropped rows with, or null if this dictionary has
     * every row it ever had.
     *
     * Gated on `stub_template` rather than on the rules existing, because the two are not the same
     * thing: a v3 database (and any v4 one between induction and the drop pass) has rules but a full
     * set of rows, and synthesizing there would return every deinflection twice.
     * @param {number} dictionaryId
     * @returns {?{table: import('./inflection-rules.js').InflectionTable, template: StubTemplate}}
     */
    _getInflection(dictionaryId) {
        const cached = this._inflectionCache.get(dictionaryId);
        if (typeof cached !== 'undefined') { return cached; }
        /** @type {?{table: import('./inflection-rules.js').InflectionTable, template: StubTemplate}} */
        let result = null;
        const row = this._selectObject('SELECT stub_template FROM dictionaries WHERE id = ?', [dictionaryId]);
        const blob = row?.stub_template;
        if (blob instanceof Uint8Array) {
            const table = this._loadInflectionTable(dictionaryId);
            if (table !== null) {
                const {codec, dict} = this._getDictCodec(dictionaryId);
                result = {table, template: /** @type {StubTemplate} */ (/** @type {unknown} */ (codec.decode(blob, dict)))};
            }
        }
        this._inflectionCache.set(dictionaryId, result);
        return result;
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    async dictionaryExists(title) {
        if (this._titleToId.has(title)) { return true; }
        return typeof this._require().selectValue('SELECT id FROM dictionaries WHERE title = ?', [title]) === 'number';
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
        // Payload-bearing stores need their per-dictionary write codec resolved (and trained, which
        // is async) before the synchronous insert transaction.
        if (objectStoreName === 'terms') {
            await this._ensureWriteCodecs(/** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */ (items), start, end, (term) => term.m);
        } else if (objectStoreName === 'kanji') {
            await this._ensureWriteCodecs(/** @type {import('dictionary-database').DatabaseKanjiEntry[]} */ (items), start, end, (kanji) => [kanji.onyomi, kanji.kunyomi, kanji.tags, kanji.meanings, kanji.stats]);
        }
        const db = this._require();
        db.transaction((tx) => {
            switch (objectStoreName) {
                case 'terms': this._insertTerms(tx, /** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */ (items), start, end); break;
                case 'termMeta': this._insertTermMeta(tx, /** @type {import('dictionary-database').DatabaseTermMeta[]} */ (items), start, end); break;
                case 'kanji': this._insertKanji(tx, /** @type {import('dictionary-database').DatabaseKanjiEntry[]} */ (items), start, end); break;
                case 'kanjiMeta': this._insertKanjiMeta(tx, /** @type {import('dictionary-database').DatabaseKanjiMeta[]} */ (items), start, end); break;
                case 'tagMeta': this._insertTagMeta(tx, /** @type {import('dictionary-database').Tag[]} */ (items), start, end); break;
                case 'media': this._insertMedia(tx, /** @type {import('dictionary-database').MediaDataArrayBufferContent[]} */ (items), start, end); break;
                case 'dictionaries':
                    for (let i = start; i < end; ++i) { this._upsertDictionary(/** @type {import('dictionary-importer').Summary} */ (items[i])); }
                    break;
                default: throw new Error(`bulkAdd not implemented for store '${objectStoreName}'`);
            }
        });
    }

    /**
     * Adds a single dictionary summary and returns an IndexedDB-style request whose `result` is the
     * new row id (the importer awaits `onsuccess`/`result`).
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @param {import('dictionary-database').ObjectStoreData<import('dictionary-database').ObjectStoreName>} item
     * @returns {Promise<IDBRequest<IDBValidKey>>}
     */
    async addWithResult(objectStoreName, item) {
        if (objectStoreName !== 'dictionaries') {
            throw new Error(`addWithResult not implemented for store '${objectStoreName}'`);
        }
        const id = this._upsertDictionary(/** @type {import('dictionary-importer').Summary} */ (item));
        return this._makeRequest(id);
    }

    /**
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @param {import('dictionary-database').DatabaseUpdateItem[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async bulkUpdate(objectStoreName, items, start, count) {
        if (objectStoreName !== 'dictionaries') {
            throw new Error(`bulkUpdate not implemented for store '${objectStoreName}'`);
        }
        const end = Math.min(start + count, items.length);
        const db = this._require();
        db.transaction((tx) => {
            const statement = tx.prepare('UPDATE dictionaries SET title = ?, revision = ?, version = ?, summary_json = ? WHERE id = ?');
            try {
                for (let i = start; i < end; ++i) {
                    const summary = /** @type {import('dictionary-importer').Summary} */ (items[i].data);
                    const id = /** @type {number} */ (items[i].primaryKey);
                    statement.bind([summary.title, summary.revision, summary.version, JSON.stringify(summary), id]).stepReset();
                    this._cacheDictionary(id, summary.title);
                }
            } finally {
                statement.finalize();
            }
        });
    }

    // Term queries

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
            const stored = results.length;
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
            // Only an exact probe can be answered from the rules: a wildcard asks which *stored*
            // forms match a pattern, and a dropped form is not stored. See plan/02-decisions.md #34.
            if (matchType === 'exact') {
                this._addDerivedTerms(results, stored, term, i, dictionaryIds);
            }
        }
        return results;
    }

    /**
     * Appends the form-of rows `_dropDerivableRows` deleted for `term`, rebuilt from the rules, to
     * `results`. To everything downstream these are the rows: `translator._getDictionaryDeinflections`
     * reads their `[lemma, labels]` glossary exactly as it read the stored ones, and
     * `translator._getDeinflections` then strips them, so no synthesized row is ever displayed.
     *
     * One entry per dictionary, holding every derived pointer, because that is the shape the
     * dictionary itself uses: `kty-de-en` packs all nine of `Rappen`'s pointers into one row's
     * glossary rather than into nine rows. The translator loops entries × definitions, so the
     * deinflections are the same either way — but matching the stored shape keeps the two
     * comparable, and allocates one entry per hover candidate instead of nine.
     * @param {import('dictionary-database').TermEntry[]} results
     * @param {number} stored Index in `results` where this term's stored rows begin.
     * @param {string} term
     * @param {number} index The term's index in the query list.
     * @param {number[]} dictionaryIds
     * @returns {void}
     */
    _addDerivedTerms(results, stored, term, index, dictionaryIds) {
        for (const dictionaryId of dictionaryIds) {
            const inflection = this._getInflection(dictionaryId);
            if (inflection === null) { continue; }
            const derived = deriveLemmas(inflection.table, term);
            if (derived.length === 0) { continue; }
            const dictionary = /** @type {string} */ (this._idToTitle.get(dictionaryId));
            // A row is kept whole when any one of its pairs is underivable, so its derivable pairs
            // would otherwise be stated twice: once by the surviving row, once by the rules.
            /** @type {Set<string>} */
            const alreadyStored = new Set();
            for (let i = stored, ii = results.length; i < ii; ++i) {
                const entry = results[i];
                if (entry.dictionary !== dictionary) { continue; }
                for (const definition of entry.definitions) {
                    if (Array.isArray(definition) && typeof definition[0] === 'string') { alreadyStored.add(definition[0]); }
                }
            }
            /** @type {import('dictionary-data').TermGlossary[]} */
            const definitions = [];
            for (const {lemma, labels} of derived) {
                if (alreadyStored.has(lemma)) { continue; }
                definitions.push(/** @type {import('dictionary-data').TermGlossary} */ (/** @type {unknown} */ ([lemma, labels])));
            }
            if (definitions.length === 0) { continue; }
            const [definitionTags, rules, score, termTags, sequence, readingMirrorsExpression] = inflection.template;
            results.push({
                index,
                matchType: 'exact',
                matchSource: 'term',
                term,
                // The importer never writes an empty reading (see StubTemplate), so on a real German
                // import this is the term; '' only occurs for rows written around the importer.
                reading: readingMirrorsExpression ? term : '',
                definitionTags: this._splitField(definitionTags),
                termTags: this._splitField(termTags),
                rules: this._splitField(rules),
                definitions,
                score,
                dictionary,
                // Negative, so it can never collide with a stored row's id in the `visited` set here
                // or in the `ids` set merge mode keeps. Distinct per synthesized entry.
                id: -(results.length + 1),
                sequence,
            });
        }
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

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBySequenceBulk(items) {
        this._require(); // guard: throws if the database is not open
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        for (let i = 0, ii = items.length; i < ii; ++i) {
            const {query, dictionary} = items[i];
            const dictionaryId = this._titleToId.get(dictionary);
            if (typeof dictionaryId !== 'number') { continue; }
            const rows = this._selectObjects(
                'SELECT id, dictionary_id, expression, reading, sequence, payload FROM terms WHERE sequence = ? AND dictionary_id = ?',
                [query, dictionaryId],
            );
            for (const row of rows) {
                results.push(this._createTerm('sequence', 'exact', row, i));
            }
        }
        return results;
    }

    // Meta / kanji / tag / media queries

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermMeta[]>}
     */
    async findTermMetaBulk(termList, dictionaries) {
        const dictionaryIds = this._enabledDictionaryIds(dictionaries);
        /** @type {import('dictionary-database').TermMeta[]} */
        const results = [];
        if (termList.length === 0 || dictionaryIds.length === 0) { return results; }
        this._require(); // guard: throws if the database is not open
        const idFilter = `dictionary_id IN (${dictionaryIds.join(',')})`;
        for (let i = 0, ii = termList.length; i < ii; ++i) {
            const rows = this._selectObjects(`SELECT expression, mode, data_json, dictionary_id FROM term_meta WHERE expression = ? AND ${idFilter}`, [termList[i]]);
            for (const row of rows) {
                results.push(this._createTermMeta(row, i));
            }
        }
        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
     */
    async findKanjiBulk(kanjiList, dictionaries) {
        const dictionaryIds = this._enabledDictionaryIds(dictionaries);
        /** @type {import('dictionary-database').KanjiEntry[]} */
        const results = [];
        if (kanjiList.length === 0 || dictionaryIds.length === 0) { return results; }
        this._require(); // guard: throws if the database is not open
        const idFilter = `dictionary_id IN (${dictionaryIds.join(',')})`;
        for (let i = 0, ii = kanjiList.length; i < ii; ++i) {
            const rows = this._selectObjects(`SELECT character, payload, dictionary_id FROM kanji WHERE character = ? AND ${idFilter}`, [kanjiList[i]]);
            for (const row of rows) {
                results.push(this._createKanji(row, i));
            }
        }
        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiMeta[]>}
     */
    async findKanjiMetaBulk(kanjiList, dictionaries) {
        const dictionaryIds = this._enabledDictionaryIds(dictionaries);
        /** @type {import('dictionary-database').KanjiMeta[]} */
        const results = [];
        if (kanjiList.length === 0 || dictionaryIds.length === 0) { return results; }
        this._require(); // guard: throws if the database is not open
        const idFilter = `dictionary_id IN (${dictionaryIds.join(',')})`;
        for (let i = 0, ii = kanjiList.length; i < ii; ++i) {
            const rows = this._selectObjects(`SELECT character, mode, data_json, dictionary_id FROM kanji_meta WHERE character = ? AND ${idFilter}`, [kanjiList[i]]);
            for (const row of rows) {
                results.push(this._createKanjiMeta(row, i));
            }
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<(import('dictionary-database').Tag|undefined)[]>}
     */
    async findTagMetaBulk(items) {
        this._require(); // guard: throws if the database is not open
        /** @type {(import('dictionary-database').Tag|undefined)[]} */
        const results = [];
        for (const item of items) {
            const dictionaryId = this._titleToId.get(item.dictionary);
            let tag;
            if (typeof dictionaryId === 'number') {
                const row = this._selectObject('SELECT name, category, sort_order, notes, score, dictionary_id FROM tag_meta WHERE name = ? AND dictionary_id = ? LIMIT 1', [item.query, dictionaryId]);
                if (typeof row !== 'undefined') { tag = this._createTag(row); }
            }
            results.push(tag);
        }
        return results;
    }

    /**
     * @param {string} name
     * @param {string} dictionary
     * @returns {Promise<?import('dictionary-database').Tag>}
     */
    async findTagForTitle(name, dictionary) {
        const dictionaryId = this._titleToId.get(dictionary);
        if (typeof dictionaryId !== 'number') { return null; }
        const row = this._selectObject('SELECT name, category, sort_order, notes, score, dictionary_id FROM tag_meta WHERE name = ? AND dictionary_id = ? LIMIT 1', [name, dictionaryId]);
        return typeof row === 'undefined' ? null : this._createTag(row);
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} items
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    async getMedia(items) {
        this._require(); // guard: throws if the database is not open
        /** @type {import('dictionary-database').Media[]} */
        const results = [];
        for (let i = 0, ii = items.length; i < ii; ++i) {
            const {path, dictionary} = items[i];
            const dictionaryId = this._titleToId.get(dictionary);
            if (typeof dictionaryId !== 'number') { continue; }
            const rows = this._selectObjects('SELECT path, media_type, width, height, content, dictionary_id FROM media WHERE path = ? AND dictionary_id = ?', [path, dictionaryId]);
            for (const row of rows) {
                results.push(this._createMedia(row, i));
            }
        }
        return results;
    }

    // Admin

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    async getDictionaryInfo() {
        const rows = this._require().selectObjects('SELECT summary_json FROM dictionaries ORDER BY id');
        /** @type {import('dictionary-importer').Summary[]} */
        const summaries = [];
        for (const row of rows) {
            if (typeof row.summary_json === 'string') {
                summaries.push(/** @type {import('dictionary-importer').Summary} */ (parseJson(row.summary_json)));
            }
        }
        return summaries;
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async getDictionaryCounts(dictionaryNames, getTotal) {
        const db = this._require();
        /** @type {import('dictionary-database').ObjectStoreName[]} */
        const stores = ['kanji', 'kanjiMeta', 'terms', 'termMeta', 'tagMeta', 'media'];
        /**
         * @param {number|null} dictionaryId
         * @returns {import('dictionary-database').DictionaryCountGroup}
         */
        const countGroup = (dictionaryId) => {
            /** @type {import('dictionary-database').DictionaryCountGroup} */
            const group = {};
            for (const store of stores) {
                const table = STORE_TABLE[store];
                group[store] = dictionaryId === null ?
                    /** @type {number} */ (db.selectValue(`SELECT count(*) FROM ${table}`)) :
                    /** @type {number} */ (db.selectValue(`SELECT count(*) FROM ${table} WHERE dictionary_id = ?`, [dictionaryId]));
            }
            return group;
        };

        const total = getTotal ? countGroup(null) : null;
        /** @type {import('dictionary-database').DictionaryCountGroup[]} */
        const counts = [];
        for (const name of dictionaryNames) {
            const dictionaryId = this._titleToId.get(name);
            counts.push(typeof dictionaryId === 'number' ? countGroup(dictionaryId) : countGroup(-1));
        }
        return {total, counts};
    }

    /**
     * @param {string} dictionaryName
     * @param {number} progressRate
     * @param {import('dictionary-database').DeleteDictionaryProgressCallback} onProgress
     * @returns {Promise<void>}
     */
    async deleteDictionary(dictionaryName, progressRate, onProgress) {
        const db = this._require();
        const dictionaryId = this._titleToId.get(dictionaryName);
        /** @type {import('dictionary-database').ObjectStoreName[]} */
        const stores = ['kanji', 'kanjiMeta', 'terms', 'termMeta', 'tagMeta', 'media'];
        /** @type {import('dictionary-database').DeleteDictionaryProgressData} */
        const progressData = {count: 0, processed: 0, storeCount: stores.length + 1, storesProcesed: 0};
        if (typeof dictionaryId !== 'number') {
            onProgress(progressData);
            return;
        }
        for (const store of stores) {
            const table = STORE_TABLE[store];
            const rowCount = /** @type {number} */ (db.selectValue(`SELECT count(*) FROM ${table} WHERE dictionary_id = ?`, [dictionaryId]));
            progressData.count += rowCount;
            ++progressData.storesProcesed;
            onProgress(progressData);
            db.exec(`DELETE FROM ${table} WHERE dictionary_id = ${dictionaryId}`);
            progressData.processed += rowCount;
            if (progressRate > 0) { onProgress(progressData); }
        }
        db.exec(`DELETE FROM dictionaries WHERE id = ${dictionaryId}`);
        ++progressData.storesProcesed;
        onProgress(progressData);
        this._titleToId.delete(dictionaryName);
        this._idToTitle.delete(dictionaryId);
        this._dictCodec.delete(dictionaryId);
        // Not merely stale but dangerous to keep: SQLite hands out INTEGER PRIMARY KEY values again
        // once the rows holding them are gone, so the next imported dictionary can be given this id
        // and would inherit these rules — synthesizing another dictionary's forms into its lookups.
        this._inflectionCache.delete(dictionaryId);
    }

    // Private — inserts (one prepared statement per batch; dictionary ids resolved from the title)

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').DatabaseTermEntryPacked[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertTerms(db, items, start, end) {
        const statement = db.prepare('INSERT INTO terms(dictionary_id, expression, reading, sequence, payload) VALUES(?, ?, ?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const term = items[i];
                const dictionaryId = this._resolveDictionaryId(term.dictionary);
                const {codec, dict} = this._writeCodecFor(dictionaryId);
                const sequence = typeof term.sequence === 'number' ? term.sequence : null;
                statement.bind([dictionaryId, term.expression, term.reading, sequence, codec.encode(term.m, dict)]).stepReset();
            }
        } finally {
            statement.finalize();
        }
    }

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').DatabaseTermMeta[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertTermMeta(db, items, start, end) {
        const statement = db.prepare('INSERT INTO term_meta(dictionary_id, expression, mode, data_json) VALUES(?, ?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const meta = items[i];
                statement.bind([this._resolveDictionaryId(meta.dictionary), meta.expression, meta.mode, JSON.stringify(meta.data)]).stepReset();
            }
        } finally {
            statement.finalize();
        }
    }

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').DatabaseKanjiEntry[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertKanji(db, items, start, end) {
        const statement = db.prepare('INSERT INTO kanji(dictionary_id, character, payload) VALUES(?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const kanji = items[i];
                const dictionaryId = this._resolveDictionaryId(kanji.dictionary);
                const {codec, dict} = this._writeCodecFor(dictionaryId);
                const payload = codec.encode([kanji.onyomi, kanji.kunyomi, kanji.tags, kanji.meanings, kanji.stats], dict);
                statement.bind([dictionaryId, kanji.character, payload]).stepReset();
            }
        } finally {
            statement.finalize();
        }
    }

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').DatabaseKanjiMeta[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertKanjiMeta(db, items, start, end) {
        const statement = db.prepare('INSERT INTO kanji_meta(dictionary_id, character, mode, data_json) VALUES(?, ?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const meta = items[i];
                statement.bind([this._resolveDictionaryId(meta.dictionary), meta.character, meta.mode, JSON.stringify(meta.data)]).stepReset();
            }
        } finally {
            statement.finalize();
        }
    }

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').Tag[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertTagMeta(db, items, start, end) {
        const statement = db.prepare('INSERT INTO tag_meta(dictionary_id, name, category, sort_order, notes, score) VALUES(?, ?, ?, ?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const tag = items[i];
                statement.bind([this._resolveDictionaryId(tag.dictionary), tag.name, tag.category, tag.order, tag.notes, tag.score]).stepReset();
            }
        } finally {
            statement.finalize();
        }
    }

    /**
     * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
     * @param {import('dictionary-database').MediaDataArrayBufferContent[]} items
     * @param {number} start
     * @param {number} end
     * @returns {void}
     */
    _insertMedia(db, items, start, end) {
        const statement = db.prepare('INSERT INTO media(dictionary_id, path, media_type, width, height, content) VALUES(?, ?, ?, ?, ?, ?)');
        try {
            for (let i = start; i < end; ++i) {
                const media = items[i];
                statement.bind([this._resolveDictionaryId(media.dictionary), media.path, media.mediaType, media.width, media.height, new Uint8Array(media.content)]).stepReset();
            }
        } finally {
            statement.finalize();
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

    // Private — result builders (match DictionaryDatabase._create* shaping)

    /**
     * @param {import('dictionary-database').MatchSource} matchSource
     * @param {import('dictionary-database').MatchType} matchType
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').TermEntry}
     */
    _createTerm(matchSource, matchType, row, index) {
        const dictionaryId = /** @type {number} */ (row.dictionary_id);
        const {codec, dict} = this._getDictCodec(dictionaryId);
        // The codec always returns an array; cast the positional payload to its tuple shape.
        const [definitionTags, rules, score, glossary, termTags] = /** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (
            codec.decode(/** @type {Uint8Array} */ (row.payload), dict)
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
            dictionary: /** @type {string} */ (this._idToTitle.get(dictionaryId)),
            id: /** @type {number} */ (row.id),
            sequence: typeof sequence === 'number' ? sequence : -1,
        };
    }

    /**
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').KanjiEntry}
     */
    _createKanji(row, index) {
        const {codec, dict} = this._getDictCodec(/** @type {number} */ (row.dictionary_id));
        // Kanji payload shape: [onyomi, kunyomi, tags, meanings, stats]; see _insertKanji.
        const [onyomi, kunyomi, tags, meanings, stats] = /** @type {[string, string, string, string[], {[name: string]: string}|undefined]} */ (
            codec.decode(/** @type {Uint8Array} */ (row.payload), dict)
        );
        return {
            index,
            character: /** @type {string} */ (row.character),
            onyomi: this._splitField(onyomi),
            kunyomi: this._splitField(kunyomi),
            tags: this._splitField(tags),
            definitions: meanings,
            stats: typeof stats === 'object' && stats !== null ? stats : {},
            dictionary: /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id))),
        };
    }

    /**
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').TermMeta}
     * @throws {Error}
     */
    _createTermMeta(row, index) {
        const term = /** @type {string} */ (row.expression);
        const mode = /** @type {string} */ (row.mode);
        const dictionary = /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id)));
        const data = parseJson(/** @type {string} */ (row.data_json));
        switch (mode) {
            case 'freq':
            case 'pitch':
            case 'ipa':
                return /** @type {import('dictionary-database').TermMeta} */ ({index, term, mode, data, dictionary});
            default:
                throw new Error(`Unknown mode: ${mode}`);
        }
    }

    /**
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').KanjiMeta}
     */
    _createKanjiMeta(row, index) {
        return /** @type {import('dictionary-database').KanjiMeta} */ ({
            index,
            character: /** @type {string} */ (row.character),
            mode: /** @type {string} */ (row.mode),
            data: parseJson(/** @type {string} */ (row.data_json)),
            dictionary: /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id))),
        });
    }

    /**
     * @param {import('sqlite-wasm').SqlRow} row
     * @returns {import('dictionary-database').Tag}
     */
    _createTag(row) {
        return {
            name: /** @type {string} */ (row.name),
            category: /** @type {string} */ (row.category),
            order: /** @type {number} */ (row.sort_order),
            notes: /** @type {string} */ (row.notes),
            score: /** @type {number} */ (row.score),
            dictionary: /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id))),
        };
    }

    /**
     * @param {import('sqlite-wasm').SqlRow} row
     * @param {number} index
     * @returns {import('dictionary-database').Media}
     */
    _createMedia(row, index) {
        const content = /** @type {Uint8Array} */ (row.content);
        return {
            index,
            dictionary: /** @type {string} */ (this._idToTitle.get(/** @type {number} */ (row.dictionary_id))),
            path: /** @type {string} */ (row.path),
            mediaType: /** @type {string} */ (row.media_type),
            width: /** @type {number} */ (row.width),
            height: /** @type {number} */ (row.height),
            content: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
        };
    }

    // Private — helpers

    /**
     * Resolves (training if necessary) the write codec for every distinct dictionary in a batch,
     * before the synchronous insert transaction. Identity leaves the row's `codec` column null;
     * a compressing codec trains a per-dictionary dictionary from a sample of the batch's payloads
     * and persists `codec` + `codec_dict` so the rows are self-describing on read.
     * @template T
     * @param {T[]} items
     * @param {number} start
     * @param {number} end
     * @param {(item: T) => unknown[]} toPayload
     * @returns {Promise<void>}
     */
    async _ensureWriteCodecs(items, start, end, toPayload) {
        /** @type {Map<string, unknown[][]>} */
        const samplesByTitle = new Map();
        for (let i = start; i < end; ++i) {
            const title = /** @type {{dictionary: string}} */ (items[i]).dictionary;
            let samples = samplesByTitle.get(title);
            if (typeof samples === 'undefined') {
                samples = [];
                samplesByTitle.set(title, samples);
            }
            if (samples.length < this._trainSampleSize) { samples.push(toPayload(items[i])); }
        }
        for (const [title, samples] of samplesByTitle) {
            await this._ensureWriteCodec(this._resolveDictionaryId(title), samples);
        }
    }

    /**
     * @param {number} dictionaryId
     * @param {unknown[][]} samples
     * @returns {Promise<void>}
     */
    async _ensureWriteCodec(dictionaryId, samples) {
        if (this._dictCodec.has(dictionaryId)) { return; }
        const db = this._require();
        const codecName = db.selectValue('SELECT codec FROM dictionaries WHERE id = ?', [dictionaryId]);
        if (typeof codecName === 'string' && codecName.length > 0) {
            this._loadDictCodec(dictionaryId, codecName);
            return;
        }
        if (this._codec.name === 'identity') {
            // Leave the `codec` column null (== identity on read); keeps identity byte-identical.
            this._dictCodec.set(dictionaryId, {codec: this._codec, dict: null});
            return;
        }
        const trained = await this._codec.train(samples);
        const dict = trained.length > 0 ? trained : null;
        const statement = db.prepare('UPDATE dictionaries SET codec = ?, codec_dict = ? WHERE id = ?');
        try {
            statement.bind([this._codec.name, dict, dictionaryId]).stepReset();
        } finally {
            statement.finalize();
        }
        this._dictCodec.set(dictionaryId, {codec: this._codec, dict});
    }

    /**
     * Returns the write codec resolved by `_ensureWriteCodecs`; falls back to the default codec.
     * @param {number} dictionaryId
     * @returns {{codec: import('payload-codec').PayloadCodec, dict: ?Uint8Array}}
     */
    _writeCodecFor(dictionaryId) {
        return this._dictCodec.get(dictionaryId) ?? {codec: this._codec, dict: null};
    }

    /**
     * Returns the codec a dictionary's rows were written with (self-describing via the `codec`
     * column), for decoding. Null/absent `codec` means identity.
     * @param {number} dictionaryId
     * @returns {{codec: import('payload-codec').PayloadCodec, dict: ?Uint8Array}}
     */
    _getDictCodec(dictionaryId) {
        const cached = this._dictCodec.get(dictionaryId);
        if (typeof cached !== 'undefined') { return cached; }
        const codecName = this._require().selectValue('SELECT codec FROM dictionaries WHERE id = ?', [dictionaryId]);
        if (typeof codecName === 'string' && codecName.length > 0) {
            this._loadDictCodec(dictionaryId, codecName);
            return /** @type {{codec: import('payload-codec').PayloadCodec, dict: ?Uint8Array}} */ (this._dictCodec.get(dictionaryId));
        }
        const entry = {codec: this._identityCodec, dict: null};
        this._dictCodec.set(dictionaryId, entry);
        return entry;
    }

    /**
     * Loads and caches the codec instance + `codec_dict` bytes for a dictionary from its row.
     * @param {number} dictionaryId
     * @param {string} codecName
     * @returns {void}
     */
    _loadDictCodec(dictionaryId, codecName) {
        const row = this._require().selectObject('SELECT codec_dict FROM dictionaries WHERE id = ?', [dictionaryId]);
        const codec = this._codecRegistry.get(codecName) ?? this._identityCodec;
        const dict = typeof row !== 'undefined' && row.codec_dict instanceof Uint8Array ? row.codec_dict : null;
        this._dictCodec.set(dictionaryId, {codec, dict});
    }

    /**
     * Resolves the integer id for a dictionary title, inserting a bare row if the title is not yet
     * known. Term/meta/media rows carry only their dictionary title, so this backfills the id.
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

    /** @returns {void} */
    _loadDictionaryCache() {
        this._titleToId.clear();
        this._idToTitle.clear();
        this._dictCodec.clear();
        this._inflectionCache.clear();
        for (const row of this._require().selectObjects('SELECT id, title FROM dictionaries')) {
            this._cacheDictionary(/** @type {number} */ (row.id), /** @type {string} */ (row.title));
        }
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
        this._require(); // guard: throws if the database is not open
        const idFilter = `dictionary_id IN (${dictionaryIds.join(',')})`;
        const columns = 'id, dictionary_id, expression, reading, sequence, payload';
        // `INDEXED BY` forces the seek instead of letting the planner choose. It always seeks the
        // index — which is what these probes want, and what IndexedDB did unconditionally — so it can
        // never regress into the full table scan the planner once chose for a reading probe (that was
        // the ~75 ms/hover bug of plan/02-decisions.md #27, on the mistaken premise that all readings
        // were ''; the premise is gone, see #35, but the guarantee is still worth keeping).
        const index = column === 'expression' ? 'ix_terms_expression' : 'ix_terms_reading';
        // ix_terms_reading is partial (`WHERE reading <> expression`), so the probe has to repeat that
        // predicate literally: SQLite only uses a partial index when the query provably implies its
        // WHERE clause, and it cannot prove that of a bound parameter. Without it the `INDEXED BY`
        // above does not degrade to a scan — the statement fails to compile at all, with
        // "no query solution". It is also the correct semantics: a row whose reading equals its
        // expression is already found by the expression probe (findTermsBulk dedups by id), so the
        // reading probe contributing it too would be redundant. See #35/#36.
        const partial = column === 'reading' ? ' AND reading <> expression' : '';
        switch (matchType) {
            case 'prefix':
                // Inclusive bound [term, term+'￿'], matching IDBKeyRange.bound(term, term+'￿').
                // Valid for BMP strings, where SQLite BINARY (UTF-8) and IndexedDB (UTF-16) code-point
                // orders agree; dictionary data is BMP.
                return this._selectObjects(
                    `SELECT ${columns} FROM terms INDEXED BY ${index} WHERE ${column} >= ? AND ${column} <= ? || char(65535)${partial} AND ${idFilter}`,
                    [term, term],
                );
            case 'suffix': {
                // No reverse column yet (that is a later schema addition, see plan/03-progress.md
                // "watch-outs"); filter suffix matches in JS over the enabled dictionaries. Left to
                // the planner deliberately — no index can serve this, so the scan is the real plan.
                const rows = this._selectObjects(`SELECT ${columns} FROM terms WHERE ${idFilter}`);
                return rows.filter((row) => typeof row[column] === 'string' && /** @type {string} */ (row[column]).endsWith(term));
            }
            default: // 'exact'
                return this._selectObjects(
                    `SELECT ${columns} FROM terms INDEXED BY ${index} WHERE ${column} = ?${partial} AND ${idFilter}`,
                    [term],
                );
        }
    }

    /**
     * @param {unknown} field
     * @returns {string[]}
     */
    _splitField(field) {
        return typeof field === 'string' && field.length > 0 ? field.split(' ') : [];
    }

    /**
     * Builds a minimal IndexedDB-style request object (the importer only reads `onsuccess`/`result`).
     * @param {IDBValidKey} result
     * @returns {IDBRequest<IDBValidKey>}
     */
    _makeRequest(result) {
        /** @type {(() => void)|null} */
        let onsuccess = null;
        return /** @type {IDBRequest<IDBValidKey>} */ (/** @type {unknown} */ ({
            result,
            error: null,
            onerror: null,
            get onsuccess() { return onsuccess; },
            set onsuccess(callback) {
                onsuccess = callback;
                if (typeof callback === 'function') { queueMicrotask(callback); }
            },
        }));
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
