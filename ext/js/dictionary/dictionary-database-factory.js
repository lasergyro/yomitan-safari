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

import {DictionaryDatabaseNative} from '../native/dictionary-database-native.js';
import {USE_NATIVE_BACKEND} from './dictionary-backend-config.js';
import {DictionaryDatabase} from './dictionary-database.js';

/**
 * Constructs the (unprepared) dictionary database backend for this build.
 *
 * Two, and only two:
 *
 * - **Native** (`USE_NATIVE_BACKEND`) — the Safari path. The extension stores nothing; every query
 *   crosses `sendNativeMessage` to the SQLite engine hosted in the app extension, reading a database
 *   in the app container. This exists because Safari rotates the extension origin on every launch,
 *   which strands anything origin-partitioned (plan/safari-opfs-blocker.md).
 * - **IndexedDB** — upstream Yomitan's backend, for every other browser.
 *
 * There used to be a third: the same SQLite engine running as WASM on OPFS inside the extension. It
 * worked and it was measured (~700 MB of IndexedDB → 49.4 MB), but it could not survive a restart,
 * so its storage binding was deleted rather than kept as a half-path. The engine itself was not
 * deleted — it is what runs natively now (plan/native-rewrite.md).
 *
 * All backends share the public API and a no-argument `prepare()`, so callers keep doing
 * `const db = createDictionaryDatabase(); await db.prepare();` unchanged.
 * @returns {DictionaryDatabase}
 */
export function createDictionaryDatabase() {
    if (USE_NATIVE_BACKEND) {
        // Nothing SQLite, WASM or pako-shaped is constructed on this side at all: the engine is in
        // the app, and this is a client for it.
        return /** @type {DictionaryDatabase} */ (/** @type {unknown} */ (new DictionaryDatabaseNative()));
    }
    return new DictionaryDatabase();
}
