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

// Runs in the harness **page** — a Window, not a worker — which is the context the real extension's
// background page runs in, and the one that could not hold the database at all: OPFS sync access
// handles are Worker-only, so `DictionaryDatabaseSqlite` here must go into *proxy* mode and reach
// the SharedWorker that owns the connection (plan/backend-worker.md).
//
// worker.js covers the owner side. These checks cover the seam that bug lived in, which neither
// vitest (node, in-memory) nor worker.js (already inside a worker) can see.

import {DeflatePayloadCodec} from '/ext/js/dictionary/deflate-payload-codec.js';
import {DictionaryDatabaseSqlite} from '/ext/js/dictionary/sqlite/dictionary-database-sqlite.js';

const dictionaryName = 'Safari Proxy Check Dictionary';
const dictionaries = new Set([dictionaryName]);

/**
 * @param {string} title
 * @returns {import('../../types/ext/dictionary-importer').Summary}
 */
function summaryFor(title) {
    return {title, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
}

/**
 * @returns {Promise<{name: string, ok: boolean, error?: string, info?: string}[]>}
 */
export async function runPageChecks() {
    /** @type {{name: string, ok: boolean, error?: string, info?: string}[]} */
    const checks = [];

    /**
     * @param {string} name
     * @param {() => Promise<string|void>} body
     */
    const check = async (name, body) => {
        try {
            const info = await body();
            checks.push({name, ok: true, ...(typeof info === 'string' ? {info} : {})});
        } catch (e) {
            checks.push({name, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)});
        }
    };

    await check('a Window cannot hold OPFS itself (the bug this fixes)', async () => {
        const available = typeof FileSystemFileHandle !== 'undefined' &&
        typeof FileSystemFileHandle.prototype.createSyncAccessHandle === 'function';
        if (available) { throw new Error('createSyncAccessHandle unexpectedly exists on the main thread'); }
        return 'createSyncAccessHandle is undefined off a Worker, as expected';
    });

    // Constructed exactly as createDictionaryDatabase() does. In a Window with nothing injected this
    // must select proxy mode and connect to the SharedWorker owner.
    const db = new DictionaryDatabaseSqlite(new DeflatePayloadCodec());

    await check('page prepare() proxies to the SharedWorker owner', async () => {
        await db.prepare();
        if (!db.isPrepared()) { throw new Error('backend did not report prepared'); }
    });

    if (!db.isPrepared()) { return checks; }

    await check('purge over the proxy resets previous state', async () => {
        await db.purge();
        const info = await db.getDictionaryInfo();
        if (info.length > 0) { throw new Error(`expected no dictionaries after purge, got ${info.length}`); }
    });

    await check('writes over the proxy reach the owned connection', async () => {
        await db.bulkAdd('dictionaries', [summaryFor(dictionaryName)], 0, 1);
        const rows = [
            {expression: 'いぬ', reading: 'いぬ', dictionary: dictionaryName, sequence: 1, m: ['n', '', 0, ['dog'], 'tag']},
            {expression: 'いぬごや', reading: 'いぬごや', dictionary: dictionaryName, sequence: 2, m: [null, 'v5', -3, ['kennel'], void 0]},
        ];
        await db.bulkAdd('terms', /** @type {import('../../types/ext/dictionary-database').DatabaseTermEntryPacked[]} */ (rows), 0, rows.length);
        if (!(await db.dictionaryExists(dictionaryName))) { throw new Error('dictionary was not registered'); }
    });

    await check('findTermsBulk over the proxy round-trips a compressed payload', async () => {
        const results = await db.findTermsBulk(['いぬ'], dictionaries, 'exact');
        if (results.length !== 1) { throw new Error(`expected 1 result, got ${results.length}`); }
        if (results[0].definitions[0] !== 'dog') { throw new Error(`unexpected definition: ${JSON.stringify(results[0].definitions[0])}`); }
        if (results[0].dictionary !== dictionaryName) { throw new Error('dictionary title did not round-trip'); }
    });

    await check('prefix queries work over the proxy', async () => {
        const results = await db.findTermsBulk(['いぬ'], dictionaries, 'prefix');
        const terms = results.map((entry) => entry.term).sort();
        if (terms.length !== 2) { throw new Error(`unexpected prefix results: ${JSON.stringify(terms)}`); }
    });

    await check('getDictionaryInfo over the proxy (the call that failed in the extension)', async () => {
        const info = await db.getDictionaryInfo();
        if (info.length !== 1 || info[0].title !== dictionaryName) {
            throw new Error(`unexpected dictionary info: ${JSON.stringify(info.map((x) => x.title))}`);
        }
    });

    await check('a second page-side client shares the one owner', async () => {
        const second = new DictionaryDatabaseSqlite(new DeflatePayloadCodec());
        await second.prepare();
        try {
            // If this saw a different connection, the SAH-Pool would have refused it outright.
            const info = await second.getDictionaryInfo();
            if (info.length !== 1) { throw new Error(`second client saw ${info.length} dictionaries`); }
        } finally {
            second.close();
        }
    });

    await check('proxy cleanup', async () => {
        await db.purge();
        db.close();
    });

    return checks;
}
