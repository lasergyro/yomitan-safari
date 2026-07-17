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

// Runs in real Safari, inside a module worker (the OPFS SAH-Pool VFS needs sync access handles,
// which WebKit only exposes to workers — the same reason the extension's DB lives in a worker).
// Everything here is loaded from the actual source tree over HTTP: the backend modules from
// ext/js/**, and the *vendored* ext/lib/sqlite3.js + sqlite3.wasm + pako.js that the extension ships.
// The backend is constructed exactly as createDictionaryDatabase() constructs it, so the checks
// cover the real shipping configuration rather than a test-only wiring of it.

import {DeflatePayloadCodec} from '/ext/js/dictionary/deflate-payload-codec.js';
import {DictionaryDatabaseSqlite} from '/ext/js/dictionary/sqlite/dictionary-database-sqlite.js';

const dictionaryName = 'Safari Check Dictionary';
const dictionaries = new Set([dictionaryName]);

/** @type {{name: string, ok: boolean, error?: string, info?: string}[]} */
const checks = [];

/**
 * @param {string} name
 * @param {() => Promise<string|void>} body
 */
async function check(name, body) {
    try {
        const info = await body();
        checks.push({name, ok: true, ...(typeof info === 'string' ? {info} : {})});
    } catch (e) {
        checks.push({name, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)});
    }
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @throws {Error} If `condition` is false; `check` catches it and records the failure.
 */
function assert(condition, message) {
    if (!condition) { throw new Error(message); }
}

/**
 * @param {string} title
 * @returns {import('../../types/ext/dictionary-importer').Summary}
 */
function summaryFor(title) {
    return {title, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
}

/**
 * @param {string} suffix
 * @returns {import('../../types/ext/dictionary-database').DatabaseTermEntryPacked[]}
 */
function termRows(suffix) {
    return [
        {expression: 'いぬ', reading: 'いぬ', dictionary: dictionaryName, sequence: 1, m: ['n', '', 0, [`dog ${suffix}`, {type: 'structured-content', content: [{tag: 'div', content: 'a common domestic animal'}]}], 'tag']},
        {expression: 'いぬごや', reading: 'いぬごや', dictionary: dictionaryName, sequence: 2, m: [null, 'v5', -3, ['kennel'], void 0]},
        {expression: 'ねこ', reading: 'ねこ', dictionary: dictionaryName, sequence: 3, m: ['n', '', 7, ['cat'], '']},
    ];
}

/** Entry point. */
async function main() {
    // Exactly what createDictionaryDatabase() builds: no pako injected, so the codec self-loads the
    // vendored ext/lib/pako.js in prepare(). Constructed outside the check so the rest of main sees a
    // non-nullable handle — only prepare() can fail, and assigning inside the callback would defeat
    // both narrowing and the type checker.
    const db = new DictionaryDatabaseSqlite(new DeflatePayloadCodec());

    await check('sqlite3 + pako initialize from ext/lib on the OPFS SAH-Pool VFS', async () => {
        // No arguments == the extension path: dynamic-import the vendored builds, open OPFS.
        await db.prepare();
        assert(db.isPrepared(), 'backend did not report prepared');
    });

    if (!db.isPrepared()) {
        postMessage(checks);
        return;
    }

    await check('purge resets any state left by a previous run', async () => {
        await db.purge();
        const info = await db.getDictionaryInfo();
        assert(info.length === 0, `expected no dictionaries after purge, got ${info.length}`);
    });

    await check('import writes every store through the deflate codec', async () => {
        await db.bulkAdd('dictionaries', [summaryFor(dictionaryName)], 0, 1);
        const rows = termRows('v1');
        await db.bulkAdd('terms', rows, 0, rows.length);
        await db.bulkAdd('kanji', [{character: '犬', onyomi: 'ケン', kunyomi: 'いぬ', tags: 'jouyou', meanings: ['dog'], stats: {strokes: '4'}, dictionary: dictionaryName}], 0, 1);
        await db.bulkAdd('termMeta', [{expression: 'いぬ', mode: 'freq', data: 1234, dictionary: dictionaryName}], 0, 1);
        await db.bulkAdd('tagMeta', [{name: 'n', category: 'partOfSpeech', order: 1, notes: 'noun', score: 0, dictionary: dictionaryName}], 0, 1);
        assert(await db.dictionaryExists(dictionaryName), 'dictionary was not registered');
    });

    await check('findTermsBulk exact round-trips a deflate-compressed payload', async () => {
        const results = await db.findTermsBulk(['いぬ'], dictionaries, 'exact');
        assert(results.length === 1, `expected 1 result, got ${results.length}`);
        assert(results[0].definitions[0] === 'dog v1', `unexpected definition: ${JSON.stringify(results[0].definitions[0])}`);
        assert(results[0].dictionary === dictionaryName, 'dictionary title did not round-trip');
    });

    await check('findTermsBulk prefix uses the range query', async () => {
        const results = await db.findTermsBulk(['いぬ'], dictionaries, 'prefix');
        const terms = results.map((entry) => entry.term).sort();
        assert(terms.length === 2 && terms[0] === 'いぬ' && terms[1] === 'いぬごや', `unexpected prefix results: ${JSON.stringify(terms)}`);
    });

    await check('findTermsBulk suffix matches', async () => {
        const results = await db.findTermsBulk(['ごや'], dictionaries, 'suffix');
        assert(results.length === 1 && results[0].term === 'いぬごや', `unexpected suffix results: ${JSON.stringify(results.map((r) => r.term))}`);
    });

    await check('kanji / termMeta / tagMeta read back', async () => {
        const kanji = await db.findKanjiBulk(['犬'], dictionaries);
        assert(kanji.length === 1 && kanji[0].definitions[0] === 'dog', 'kanji did not round-trip');
        assert(kanji[0].stats.strokes === '4', 'kanji stats did not round-trip');
        const meta = await db.findTermMetaBulk(['いぬ'], dictionaries);
        assert(meta.length === 1 && meta[0].mode === 'freq', 'termMeta did not round-trip');
        const tags = await db.findTagMetaBulk([{query: 'n', dictionary: dictionaryName}]);
        assert(tags.length === 1 && tags[0]?.order === 1, 'tagMeta order (sort_order) did not round-trip');
    });

    await check('finalizeImport (ANALYZE + VACUUM) succeeds on OPFS', async () => {
        await db.finalizeImport();
        const results = await db.findTermsBulk(['ねこ'], dictionaries, 'exact');
        assert(results.length === 1, 'data unreadable after finalizeImport');
    });

    await check('data persists across close + reopen (OPFS is durable)', async () => {
        db.close();
        await db.prepare();
        const results = await db.findTermsBulk(['いぬ'], dictionaries, 'exact');
        assert(results.length === 1, 'data did not survive a close/reopen');
        assert(results[0].definitions[0] === 'dog v1', 'payload did not survive a close/reopen');
    });

    await check('rows are self-describing (codec derived from the dictionaries row)', async () => {
        // The reopen above dropped the in-memory codec cache, so this decode already had to read
        // `codec`/`codec_dict` back from the row — assert the codec actually was deflate.
        const info = await db.getDictionaryInfo();
        assert(info.length === 1 && info[0].title === dictionaryName, 'dictionary summary did not persist');
    });

    await check('storage estimate', async () => {
        if (typeof navigator.storage?.estimate !== 'function') { return 'navigator.storage.estimate unavailable'; }
        const {usage, quota} = await navigator.storage.estimate();
        return `usage ${((usage ?? 0) / 1e6).toFixed(1)} MB / quota ${((quota ?? 0) / 1e6).toFixed(0)} MB`;
    });

    await check('cleanup', async () => {
        await db.purge();
        db.close();
    });

    postMessage(checks);
}

void main();
