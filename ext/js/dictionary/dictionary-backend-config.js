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

/**
 * Feature flag for the storage-backend migration (see plan/01-design.md). When `true`, the dictionary
 * store uses the SQLite-WASM/OPFS backend; when `false`, the legacy IndexedDB backend. Kept as
 * a single module constant so the main-thread facade and the DB worker read the same value.
 * Stays `false` until the SQLite backend reaches parity, then this flag (and the IndexedDB
 * path) are removed.
 * @type {boolean}
 */
export const USE_SQLITE_BACKEND = false;
