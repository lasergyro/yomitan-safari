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

import {DeflatePayloadCodec} from './deflate-payload-codec.js';
import {USE_SQLITE_BACKEND} from './dictionary-backend-config.js';
import {DictionaryDatabase} from './dictionary-database.js';
import {DictionaryDatabaseSqlite} from './sqlite/dictionary-database-sqlite.js';

/**
 * Constructs the (unprepared) dictionary database backend selected by the `USE_SQLITE_BACKEND`
 * flag. Both backends share the public API and a no-argument `prepare()`, so callers keep doing
 * `const db = createDictionaryDatabase(); await db.prepare();` unchanged. The SQLite backend is
 * cast to `DictionaryDatabase` here (they implement the same surface but are separate classes; a
 * shared interface is a follow-up). When the flag is off this returns exactly the IndexedDB backend
 * with no SQLite/WASM/pako touched at runtime — everything they need is dynamically imported inside
 * the SQLite `prepare()`.
 *
 * The write codec is **deflate** (plan/decisions.md #26): measured on the real `kty-de-en` it
 * gives a ~150 MB database against ~700 MB of IndexedDB, for no build step and no extra RAM. zstd
 * was built and measured and did not justify itself — see plan/history/zstd.md.
 * @returns {DictionaryDatabase}
 */
export function createDictionaryDatabase() {
    if (USE_SQLITE_BACKEND) {
        // pako is left to the codec's own prepare() so that it is not pulled into the module graph
        // when the flag is off.
        return /** @type {DictionaryDatabase} */ (/** @type {unknown} */ (
            new DictionaryDatabaseSqlite(new DeflatePayloadCodec())
        ));
    }
    return new DictionaryDatabase();
}
