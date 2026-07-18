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

import {createDictionarySchema} from './dictionary-sqlite-schema.js';

/**
 * Opens the dictionary database and ensures its schema exists. The `sqlite3` module is injected
 * by the caller rather than imported here, so the same logic serves both environments: the
 * extension DB worker builds `sqlite3` from the vendored `/lib/sqlite3.js` browser build and
 * passes `vfs: 'opfs'` (persistent, OPFS SAH-Pool VFS, no COOP/COEP required); node tests build
 * it from the `@sqlite.org/sqlite-wasm` package and pass `vfs: 'memory'` (`:memory:`). See
 * plan/design.md → Storage model.
 * @param {import('sqlite-wasm').Sqlite3Module} sqlite3 The initialized sqlite3 module.
 * @param {{vfs: import('sqlite-wasm').SqliteVfs, path?: string, initialCapacity?: number}} options
 * @returns {Promise<import('sqlite-wasm').SqliteDatabaseHandle>}
 */
export async function openDictionaryDatabaseHandle(sqlite3, {vfs, path = '/dict.sqlite3', initialCapacity = 8}) {
    /** @type {import('sqlite-wasm').SqliteDatabaseHandle} */
    let db;
    if (vfs === 'opfs') {
        const pool = await sqlite3.installOpfsSAHPoolVfs({name: 'yomitan-dict', initialCapacity});
        db = new pool.OpfsSAHPoolDb(path);
    } else {
        db = new sqlite3.oo1.DB(':memory:');
    }
    // Larger pages suit the big BLOB-heavy rows; must be set before the schema (any write) is
    // created to take effect on a fresh database without a VACUUM.
    db.exec('PRAGMA page_size = 8192');
    // Single-connection worker model, and the store is re-importable, so favor import speed.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    createDictionarySchema(db);
    return db;
}
