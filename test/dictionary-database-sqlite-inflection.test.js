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

import {readFileSync} from 'fs';
import {fileURLToPath} from 'node:url';
import path from 'path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {beforeAll, describe, expect, test} from 'vitest';
import {createDictionaryArchiveData} from '../dev/dictionary-archive-util.js';
import {parseJson} from '../dev/json.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryDatabaseSqlite} from '../ext/js/dictionary/sqlite/dictionary-database-sqlite.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';
import {setupStubs} from './utilities/database.js';

/**
 * Guards the "drop the derivable form-of rows and synthesize them back" scheme
 * (plan/decisions.md #31, #34), which on `kty-de-en` deletes 69% of the rows.
 *
 * **Everything here goes through the real `DictionaryImporter`, against a real dictionary archive.**
 * An earlier version of this test hand-wrote packed rows straight into `bulkAdd`, and that is exactly
 * how it missed the bug that mattered: `_convertTermBankEntryV3` rewrites an empty reading to the
 * expression (`dictionary-importer.js`: `reading = reading.length > 0 ? reading : expression`), so a
 * German dictionary has `reading === expression` on every row and never the `''` the hand-written
 * fixture used. The drop pass keyed on `reading === ''` and therefore dropped **nothing at all** on a
 * real import, while ten tests stayed green. A fixture that reproduces the importer's shape by hand
 * is a fixture that reproduces the author's belief about it.
 *
 * The scheme rests on one claim: the translator cannot tell the difference. So the archive is
 * imported twice — once with induction off, so every row is stored, once with it on — and the two
 * lookups are asserted equal, in the sense `lookup` defines below.
 */

setupStubs();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dictionaryName = 'Inflection Test Dictionary';
const dictionaryDirectory = path.join(dirname, 'data/dictionaries/inflection-dictionary');

/**
 * The fixture's own term bank, to drive the assertions from the dictionary rather than from a second
 * copy of it in this file.
 * @type {import('dictionary-data').TermV3[]}
 */
const termBank = parseJson(readFileSync(path.join(dictionaryDirectory, 'term_bank_1.json'), {encoding: 'utf8'}));

/**
 * @param {number} ruleBudget 0 disables induction, so every row is stored.
 * @returns {Promise<DictionaryDatabaseSqlite>}
 */
async function createBackend(ruleBudget) {
    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
    const backend = new DictionaryDatabaseSqlite(void 0, [], {ruleBudget});
    await backend.prepare({sqlite3, vfs: 'memory'});
    const archive = await createDictionaryArchiveData(dictionaryDirectory, dictionaryName);
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    // The SQLite backend implements the same public surface; cast at the importer seam as the shared
    // translator fixtures do.
    const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (backend));
    // importDictionary finalizes on success (induces rules, drops derivable rows, ANALYZE/VACUUM),
    // so this exercises that wiring rather than calling finalizeImport by hand.
    const {errors} = await importer.importDictionary(database, archive, {prefixWildcardsSupported: false, yomitanVersion: '0.0.0.0'});
    expect(errors).toHaveLength(0);
    return backend;
}

describe('DictionaryDatabaseSqlite induced inflection rows', () => {
    /** Every row stored: the ground truth a lookup must keep matching. */
    let stored = /** @type {DictionaryDatabaseSqlite} */ (/** @type {unknown} */ (null));
    /** Derivable rows dropped and synthesized back on lookup. */
    let derived = /** @type {DictionaryDatabaseSqlite} */ (/** @type {unknown} */ (null));
    /** A budget too small for every rule, so the rules that lose it must leave their rows behind. */
    let derivedTiny = /** @type {DictionaryDatabaseSqlite} */ (/** @type {unknown} */ (null));
    const dictionaries = new Set([dictionaryName]);

    /**
     * @param {DictionaryDatabaseSqlite} backend
     * @returns {import('sqlite-wasm').SqliteDatabaseHandle}
     */
    const handle = (backend) => {
        const internal = /** @type {{_require: () => import('sqlite-wasm').SqliteDatabaseHandle}} */ (/** @type {unknown} */ (backend));
        // eslint-disable-next-line no-underscore-dangle
        return internal._require();
    };

    /**
     * @param {DictionaryDatabaseSqlite} backend
     * @returns {number}
     */
    const countRows = (backend) => Number(handle(backend).selectValue('SELECT count(*) FROM terms'));

    /**
     * What a lookup gives the translator, split the way the translator splits it.
     *
     * Entry-identity is deliberately NOT the claim. The dictionary chooses how to group its form-of
     * pointers into rows and in what order, and rules cannot recover a grouping — so what must be
     * preserved is what `translator._getDeinflections` consumes: the entries left after form-of
     * pointers are stripped (untouched rows, so they must match exactly) and the set of
     * `[lemma, labels]` pointers (which drive `_getDictionaryDeinflections`, order-insensitively).
     * Asserting entry-identity instead passed against a one-pointer-per-row fixture and then failed
     * on 39% of real lookups for no defect — see plan/decisions.md #34.
     * @param {DictionaryDatabaseSqlite} backend
     * @param {string} term
     * @param {import('dictionary-database').MatchType} [matchType]
     * @returns {Promise<{real: string[], pointers: string[]}>}
     */
    const lookup = async (backend, term, matchType = 'exact') => {
        const entries = await backend.findTermsBulk([term], dictionaries, matchType);
        /** @type {string[]} */
        const real = [];
        /** @type {Set<string>} */
        const pointers = new Set();
        for (const entry of entries) {
            /** @type {import('dictionary-data').TermGlossary[]} */
            const kept = [];
            for (const definition of entry.definitions) {
                if (Array.isArray(definition)) {
                    pointers.add(JSON.stringify(definition));
                } else {
                    kept.push(definition);
                }
            }
            if (kept.length === 0) { continue; }
            // Everything a stored row carries except `id`, which is a storage artefact: a
            // synthesized entry has no stored id, by design.
            real.push(JSON.stringify([
                entry.index,
                entry.matchType,
                entry.matchSource,
                entry.term,
                entry.reading,
                entry.definitionTags,
                entry.termTags,
                entry.rules,
                entry.score,
                entry.dictionary,
                entry.sequence,
                kept,
            ]));
        }
        return {real: real.sort(), pointers: [...pointers].sort()};
    };

    /**
     * @param {DictionaryDatabaseSqlite} backend
     * @param {string} term
     * @returns {Promise<boolean>}
     */
    const findsNothing = async (backend, term) => {
        const {real, pointers} = await lookup(backend, term);
        return real.length === 0 && pointers.length === 0;
    };

    beforeAll(async () => {
        stored = await createBackend(0);
        derived = await createBackend(100);
        derivedTiny = await createBackend(2);
    }, 60000);

    test('the importer rewrites an empty reading to the expression, which is what the drop pass must handle', () => {
        // The premise of this whole file, asserted rather than assumed. Every fixture row ships
        // reading '' except `getragen`; after the real importer, none of them are ''. If this ever
        // changes upstream, the drop condition below is silently wrong again.
        const db = handle(stored);
        expect(db.selectValue("SELECT count(*) FROM terms WHERE reading = ''")).toBe(0);
        expect(db.selectValue('SELECT count(*) FROM terms WHERE reading = expression')).toBe(termBank.length - 1);
        expect(db.selectValue("SELECT reading FROM terms WHERE expression = 'getragen'")).toBe('ge-tra-gen');
    });

    test('the derivable rows really are gone', () => {
        // Without this the equivalence tests below would pass trivially -- as they did while the
        // drop pass was silently dropping nothing on real imports.
        expect(countRows(stored)).toBe(termBank.length);
        expect(countRows(derived)).toBeLessThan(countRows(stored));
        const db = handle(derived);
        expect(db.selectValue("SELECT count(*) FROM terms WHERE expression = 'geschützt'")).toBe(0);
        expect(db.selectValue("SELECT count(*) FROM terms WHERE expression = 'Strolches'")).toBe(0);
        // ...and the template that lets them be rebuilt was recorded.
        expect(db.selectValue('SELECT stub_template IS NOT NULL FROM dictionaries WHERE title = ?', [dictionaryName])).toBe(1);
    });

    test('a lookup of a dropped form gives the translator what the dropped row gave it', async () => {
        for (const term of ['geschützt', 'geplant', 'gegrunzt', 'würde geplant haben', 'Strolches', 'Waldes', 'Rappen']) {
            expect(await lookup(derived, term), term).toStrictEqual(await lookup(stored, term));
            // Not vacuous: the term really does resolve to a deinflection.
            expect((await lookup(derived, term)).pointers.length, term).toBeGreaterThan(0);
        }
    });

    test('a lookup of every form in the dictionary is unchanged, dropped or not', async () => {
        // The general claim, over the fixture's own term bank rather than a chosen handful.
        for (const [expression] of termBank) {
            expect(await lookup(derived, expression), expression).toStrictEqual(await lookup(stored, expression));
        }
    });

    test('a synthesized entry carries the reading the importer gave the row', async () => {
        // Not '': the dropped row had reading === expression, so its rebuilt form must too, or a
        // reading probe would answer differently than it did before the row was dropped.
        const entries = await derived.findTermsBulk(['geschützt'], dictionaries, 'exact');
        expect(entries).toHaveLength(1);
        expect(entries[0].reading).toBe('geschützt');
        expect(await lookup(derived, 'geschützt')).toStrictEqual(await lookup(stored, 'geschützt'));
    });

    test('a form the dictionary never stated is not invented', async () => {
        // `gehüpft` fits the participle rule, but `hüpfen` is not in the fixture, so the paradigm
        // check must reject it -- rules over-generate and the paradigm is what filters them.
        expect(await findsNothing(derived, 'gehüpft')).toBe(true);
        expect(await findsNothing(derived, 'gekocht')).toBe(false);
    });

    test('a form with several pointers comes back as one entry, as the dictionary stored it', async () => {
        // Caught on the real dictionary: emitting one entry per derived pointer makes 39% of lookups
        // differ from the stored ones. The deinflections are the same either way (the translator
        // loops entries × definitions), but the stored shape is one row per form.
        const entries = await derived.findTermsBulk(['Rappen'], dictionaries, 'exact');
        expect(entries).toHaveLength(1);
        expect(entries[0].definitions).toHaveLength(4);
        expect(entries[0].definitions).toContainEqual(['Rappe', ['plural']]);
        expect(entries[0].definitions).toContainEqual(['Rappe', ['dative singular']]);
    });

    test('a row is kept when the rules cannot reproduce it exactly', () => {
        const db = handle(derived);
        // Each is a distinct reason from _dropDerivableRows; all three rows survive, and (by the
        // equivalence test above) still answer a lookup identically.
        for (const expression of [
            'gelesen', // real glossary text alongside the pointer
            'getragen', // a reading that is neither empty nor the expression
            'gesungen', // non-glossary fields differ from the template
        ]) {
            expect(db.selectValue('SELECT count(*) FROM terms WHERE expression = ?', [expression]), expression).toBe(1);
        }
    });

    test('a kept row is not also synthesized', async () => {
        // `gesungen`'s pair IS derivable (singen shares the participle rule) -- it is kept only
        // because its fields differ. Without the dedup in _addDerivedTerms the lookup would state
        // the same deinflection twice, once from the row and once from the rules.
        const entries = await derived.findTermsBulk(['gesungen'], dictionaries, 'exact');
        expect(entries).toHaveLength(1);
        expect(entries[0].definitions).toStrictEqual([['singen', ['past participle']]]);
    });

    test('a rule that loses the budget leaves its rows behind rather than losing the lookup', async () => {
        // The budget is a size/latency knob, never a correctness one: cutting it may only move a
        // deinflection back into a stored row. `bin`/`sein` shares its rule with no other lemma, so
        // it is the first cut -- at a budget of 2 only the participle and genitive rules survive.
        const db = handle(derivedTiny);
        expect(db.selectValue("SELECT count(*) FROM terms WHERE expression = 'bin'")).toBe(1);
        expect(db.selectValue("SELECT count(*) FROM terms WHERE expression = 'geschützt'")).toBe(0);
        expect(countRows(derivedTiny)).toBeGreaterThan(countRows(derived));
        for (const [expression] of termBank) {
            expect(await lookup(derivedTiny, expression), expression).toStrictEqual(await lookup(stored, expression));
        }
    });

    test('a deleted dictionary does not leave its rules behind for the next one', async () => {
        // SQLite reissues INTEGER PRIMARY KEY values once the rows holding them are deleted, so the
        // replacement dictionary here is handed the same id. If the cached rules survived that, it
        // would answer lookups with the deleted dictionary's forms.
        const backend = await createBackend(100);
        expect(await findsNothing(backend, 'geschützt')).toBe(false);
        await backend.deleteDictionary(dictionaryName, 1, () => { /* no progress reporting */ });

        const other = 'Replacement Dictionary';
        /** @type {import('dictionary-importer').Summary} */
        const summary = {title: other, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
        await backend.bulkAdd('dictionaries', [summary], 0, 1);
        await backend.bulkAdd('terms', [{expression: 'Haus', reading: 'Haus', dictionary: other, sequence: 1, m: ['n', 'n', 0, ['house'], '']}], 0, 1);

        expect(await backend.findTermsBulk(['geschützt'], new Set([other]), 'exact')).toStrictEqual([]);
        backend.close();
    }, 30000);

    test('a wildcard lookup cannot see a dropped form, and says so by finding nothing', async () => {
        // The known and accepted gap (plan/decisions.md #34): a wildcard asks which *stored*
        // forms match a pattern, and a dropped form is not stored. `matchType` is 'exact' on the
        // hover path; only the search page's explicit `*` reaches this.
        expect(await lookup(stored, 'geschütz', 'prefix')).not.toStrictEqual({real: [], pointers: []});
        expect(await lookup(derived, 'geschütz', 'prefix')).toStrictEqual({real: [], pointers: []});
        // A kept row is still found by the wildcard, so this is about the drop, not about wildcards.
        expect(await lookup(derived, 'gelese', 'prefix')).toStrictEqual(await lookup(stored, 'gelese', 'prefix'));
    });
});
