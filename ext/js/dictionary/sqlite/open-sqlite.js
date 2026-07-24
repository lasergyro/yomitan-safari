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
 * Opens the dictionary database and ensures its schema exists.
 *
 * The `sqlite3` module is injected by the caller rather than imported here, and that seam is what
 * lets one engine serve three hosts unchanged (plan/design.md → Integration):
 *
 * - `vfs: 'native'` — the Safari app extension. `sqlite3` is a Swift binding over the system
 *   libsqlite3 and `path` is a real file in the app container. This is the shipping path; it exists
 *   because Safari rotates the extension origin on every launch, so nothing origin-partitioned can
 *   hold a dictionary (plan/safari-opfs-blocker.md).
 * - `vfs: 'memory'` — node tests, against `:memory:`.
 * - `vfs: 'memory'` with a `path` — the build-time dictionary compiler, which writes a real file
 *   through the `@sqlite.org/sqlite-wasm` node build.
 * @param {import('sqlite-wasm').Sqlite3Module} sqlite3 The initialized sqlite3 module.
 * @param {{vfs: import('sqlite-wasm').SqliteVfs, path?: string}} options
 * @returns {Promise<import('sqlite-wasm').SqliteDatabaseHandle>}
 */
export async function openDictionaryDatabaseHandle(sqlite3, {vfs, path}) {
    /** @type {import('sqlite-wasm').SqliteDatabaseHandle} */
    const db = new sqlite3.oo1.DB(vfs === 'native' || typeof path === 'string' ? /** @type {string} */ (path) : ':memory:');
    // Larger pages suit the big BLOB-heavy rows; must be set before the schema (any write) is
    // created to take effect on a fresh database without a VACUUM.
    db.exec('PRAGMA page_size = 8192');
    // One connection, and the store is rebuilt from the compiler rather than repaired, so favor
    // throughput over the durability guarantee that FULL would buy.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    createDictionarySchema(db);
    return db;
}
