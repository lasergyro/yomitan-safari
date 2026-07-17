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
import {beforeAll, describe, expect, test} from 'vitest';
import {DictionaryDatabaseSqlite} from '../ext/js/dictionary/sqlite/dictionary-database-sqlite.js';

/**
 * Guards the term lookup path against full table scans, and pins the reading index's partial
 * predicate to the shape the real importer produces.
 *
 * `_queryTermColumn` pins `INDEXED BY` so a reading probe always seeks — IndexedDB did that
 * unconditionally, and the planner once chose a ~75 ms/hover scan instead (plan/02-decisions.md #27).
 *
 * The fixture reproduces what the importer actually writes, which an earlier version of this test got
 * wrong: `dictionary-importer.js` rewrites an empty reading to the expression, so a German dictionary
 * has `reading === expression` on every row and never `''` (see #35). The partial index is therefore
 * `WHERE reading <> expression` (#36) — empty on the German-shaped rows below, holding only the few
 * with a distinct reading. Building `reading: ''` rows through `bulkAdd` (as this test used to) tested
 * a shape the product never produces, and asserted a `sqlite_stat1` of `'0 0'` that real data refutes.
 */

/**
 * The slice of the sqlite handle this test drives directly, to run EXPLAIN QUERY PLAN on the SQL the
 * backend issues.
 * @typedef {{selectObjects: (sql: string, args?: unknown[]) => import('sqlite-wasm').SqlRow[]}} SqlHandle
 */

const dictionaryName = 'Query Plan Test Dictionary';

/** Enough rows for ANALYZE to record real statistics for the planner. */
const ROW_COUNT = 2000;

/** How many of them carry a distinct reading (the Japanese shape), so the partial index is non-empty. */
const DISTINCT_READING_COUNT = 10;

/**
 * Rows as the importer writes them: `reading === expression` for the German majority (its
 * `_convertTermBankEntryV3` rewrites an empty reading to the expression), and a handful with a
 * genuinely distinct reading, which are the only rows `ix_terms_reading` (partial on
 * `reading <> expression`) holds.
 * @returns {import('dictionary-database').DatabaseTermEntryPacked[]}
 */
function createTermRows() {
    /** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */
    const rows = [];
    for (let i = 0; i < ROW_COUNT; ++i) {
        const expression = `wort${i}`;
        rows.push({
            expression,
            reading: i < DISTINCT_READING_COUNT ? `yomi${i}` : expression,
            dictionary: dictionaryName,
            sequence: i,
            m: ['n', '', i % 50, [`gloss ${i}`], ''],
        });
    }
    return rows;
}

describe('DictionaryDatabaseSqlite term query plans', () => {
    /** @type {DictionaryDatabaseSqlite} */
    let backend;
    /** @type {SqlHandle} */
    let handle;
    const dictionaries = new Set([dictionaryName]);

    beforeAll(async () => {
        const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
        backend = new DictionaryDatabaseSqlite();
        await backend.prepare({sqlite3, vfs: 'memory'});
        /** @type {import('dictionary-importer').Summary} */
        const summary = {title: dictionaryName, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
        await backend.bulkAdd('dictionaries', [summary], 0, 1);
        const rows = createTermRows();
        await backend.bulkAdd('terms', rows, 0, rows.length);
        // ANALYZE is what teaches the planner the degenerate statistic, so the guard is only
        // meaningful after it -- and finalizeImport is what production runs.
        await backend.finalizeImport();
        const internal = /** @type {{_require: () => SqlHandle}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        handle = internal._require();
    });

    test('the partial reading index holds only the rows whose reading differs from the expression', () => {
        // #36: partial on `reading <> expression`, so it holds the DISTINCT_READING_COUNT rows and
        // none of the German-shaped majority. This is the saving made real -- on the full dictionary
        // it is 0 of 947,070 rows (a 25.67 MB index reduced to nothing). The earlier `reading <> ''`
        // predicate held all 2000, because the importer never writes an empty reading (#35), and this
        // test used to assert `sqlite_stat1 = '0 0'` against `reading: ''` rows the product never
        // produces. `<count> 1` is ANALYZE reporting the index is perfectly selective.
        const stat = handle.selectObjects("SELECT stat FROM sqlite_stat1 WHERE idx = 'ix_terms_reading'")[0]?.stat;
        expect(stat).toBe(`${DISTINCT_READING_COUNT} 1`);
        expect(handle.selectObjects('SELECT count(*) AS n FROM terms WHERE reading <> expression')[0]?.n).toBe(DISTINCT_READING_COUNT);
    });

    test('ix_terms_dictionary is gone, and the queries that used it still seek', () => {
        // It was a strict prefix-duplicate of ix_terms_sequence(dictionary_id, sequence) -- redundant
        // on every dictionary, not just this one -- so dropping it costs no capability.
        const indexes = handle.selectObjects("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'terms'")
            .map((row) => String(row.name));
        expect(indexes).not.toContain('ix_terms_dictionary');
        expect(indexes).toContain('ix_terms_sequence');
        for (const sql of ['SELECT count(*) FROM terms WHERE dictionary_id = 1', 'DELETE FROM terms WHERE dictionary_id = 1']) {
            expect(planOf(sql, []), `planned as a scan:\n  ${sql}`).toMatch(/SEARCH terms USING (COVERING )?INDEX ix_terms_sequence/);
        }
    });

    test('the reading probe carries `reading <> expression`, without which it cannot compile', async () => {
        // The partial index and the query are coupled: SQLite only uses a partial index when the
        // query provably implies its WHERE clause, and it cannot prove that of a bound parameter.
        // Combined with INDEXED BY there is then no plan at all -- this fails hard rather than
        // silently degrading to a scan, which is why the literal must never be dropped (#36).
        const queries = await captureQueries(() => backend.findTermsBulk(['wort7'], dictionaries, 'exact'));
        const readingQuery = queries.find(({sql}) => /WHERE reading =/.test(sql));
        expect(readingQuery?.sql).toContain('reading <> expression');
        expect(() => handle.selectObjects(
            'SELECT id FROM terms INDEXED BY ix_terms_reading WHERE reading = ? AND dictionary_id IN (1)',
            ['yomi1'],
        )).toThrow(/no query solution/);
    });

    test('a reading probe still finds a row whose reading is distinct, by seeking the partial index', async () => {
        // The index is not merely empty on German -- it must still serve a real reading lookup on the
        // rows it does hold. `yomi1` is the reading of `wort1`, so a reading probe must return it.
        const entries = await backend.findTermsBulk(['yomi1'], dictionaries, 'exact');
        expect(entries.map((e) => e.term)).toContain('wort1');
        expect(planOf("SELECT id FROM terms INDEXED BY ix_terms_reading WHERE reading = 'yomi1' AND reading <> expression AND dictionary_id IN (1)", []))
            .toMatch(/SEARCH terms USING INDEX ix_terms_reading/);
    });

    /**
     * Captures the SQL the backend actually issues, so this tests the real queries rather than a
     * copy of them that could silently drift. Patches the backend's own `_selectObjects` rather than
     * the sqlite handle: the read paths go through held prepared statements
     * (plan/02-decisions.md #32), so `handle.selectObjects` no longer sees them.
     * @param {() => Promise<unknown>} body
     * @returns {Promise<{sql: string, args: unknown[]}[]>}
     */
    async function captureQueries(body) {
        /** @type {{sql: string, args: unknown[]}[]} */
        const captured = [];
        const internal = /** @type {{_selectObjects: (sql: string, args?: unknown[]) => import('sqlite-wasm').SqlRow[]}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        const original = internal._selectObjects.bind(internal);
        // eslint-disable-next-line no-underscore-dangle
        internal._selectObjects = (sql, args) => {
            captured.push({sql, args: args ?? []});
            return original(sql, args);
        };
        try {
            await body();
        } finally {
            // eslint-disable-next-line no-underscore-dangle
            internal._selectObjects = original;
        }
        return captured;
    }

    /**
     * @param {string} sql
     * @param {unknown[]} args
     * @returns {string}
     */
    function planOf(sql, args) {
        return handle.selectObjects(`EXPLAIN QUERY PLAN ${sql}`, args)
            .map((row) => String(row.detail))
            .join('; ');
    }

    for (const matchType of /** @type {const} */ (['exact', 'prefix'])) {
        test(`findTermsBulk '${matchType}' never scans the terms table`, async () => {
            const queries = await captureQueries(() => backend.findTermsBulk(['wort7'], dictionaries, matchType));
            const termQueries = queries.filter(({sql}) => sql.includes('FROM terms'));
            expect(termQueries.length).toBeGreaterThan(0);
            for (const {sql, args} of termQueries) {
                const plan = planOf(sql, args);
                // "SCAN terms" here means every row is read on every keystroke-speed lookup.
                expect(plan, `query planned as a full scan:\n  ${sql}\n  plan: ${plan}`).not.toMatch(/\bSCAN terms\b/);
                expect(plan).toMatch(/SEARCH terms USING INDEX/);
            }
        });
    }

    test('findTermsExactBulk never scans the terms table', async () => {
        const queries = await captureQueries(() => backend.findTermsExactBulk([{term: 'wort7', reading: ''}], dictionaries));
        const termQueries = queries.filter(({sql}) => sql.includes('FROM terms'));
        expect(termQueries.length).toBeGreaterThan(0);
        for (const {sql, args} of termQueries) {
            expect(planOf(sql, args)).not.toMatch(/\bSCAN terms\b/);
        }
    });

    test('the reading probe uses the reading index, not just the expression one', async () => {
        // findTermsBulk queries both columns; the reading one is the query that regressed.
        const queries = await captureQueries(() => backend.findTermsBulk(['wort7'], dictionaries, 'exact'));
        const readingQuery = queries.find(({sql}) => /WHERE reading =/.test(sql));
        expect(readingQuery).toBeDefined();
        expect(planOf(/** @type {{sql: string}} */ (readingQuery).sql, /** @type {{args: unknown[]}} */ (readingQuery).args))
            .toMatch(/SEARCH terms USING INDEX ix_terms_reading/);
    });

    test('lookups still return correct results with the index pinned', async () => {
        const results = await backend.findTermsBulk(['wort7'], dictionaries, 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].term).toBe('wort7');
        expect(results[0].definitions).toStrictEqual(['gloss 7']);
    });

    test('suffix is allowed to scan — no index can serve it', async () => {
        // The complement of the guard above: suffix has no reverse column, so its scan is the real
        // plan rather than a planner mistake. Pinning an index there would be wrong.
        const queries = await captureQueries(() => backend.findTermsBulk(['t7'], dictionaries, 'suffix'));
        const termQueries = queries.filter(({sql}) => sql.includes('FROM terms'));
        expect(termQueries.length).toBeGreaterThan(0);
        expect(termQueries.every(({sql}) => !sql.includes('INDEXED BY'))).toBe(true);
    });
});
