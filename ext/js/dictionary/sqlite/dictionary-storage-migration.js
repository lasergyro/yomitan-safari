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

// Migration helpers for moving off the legacy IndexedDB `dict` store (see plan/design.md §8.4).
// The SQLite backend uses a new OPFS file and does not read the old IndexedDB; the decision is
// "require re-import". These helpers detect a legacy store with data (so the UI can prompt for a
// re-import), delete it to reclaim the ~1.2 GB after re-import, and request persistent storage.

const LEGACY_DATABASE_NAME = 'dict';

/**
 * Detects whether the legacy IndexedDB `dict` store exists and holds imported data (a non-empty
 * `dictionaries` store). Opening a non-existent database would create an empty one, so this checks
 * `indexedDB.databases()` first when available and otherwise opens read-only and inspects the
 * stores, deleting the throwaway empty database it may have created.
 * @returns {Promise<boolean>}
 */
export async function legacyIndexedDbDictionaryExists() {
    if (typeof indexedDB === 'undefined') { return false; }

    if (typeof indexedDB.databases === 'function') {
        const databases = await indexedDB.databases();
        if (!databases.some((info) => info.name === LEGACY_DATABASE_NAME)) { return false; }
    }

    return new Promise((resolve) => {
        let createdEmpty = false;
        const request = indexedDB.open(LEGACY_DATABASE_NAME);
        // Fires only when the database did not already exist (opened at version 1 with no stores).
        request.onupgradeneeded = () => { createdEmpty = true; };
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
            const db = request.result;
            if (createdEmpty || !db.objectStoreNames.contains('dictionaries')) {
                db.close();
                // Remove the throwaway empty database we may have just created while probing.
                if (createdEmpty) { indexedDB.deleteDatabase(LEGACY_DATABASE_NAME); }
                resolve(false);
                return;
            }
            const countRequest = db.transaction(['dictionaries'], 'readonly').objectStore('dictionaries').count();
            countRequest.onerror = () => {
                db.close();
                resolve(false);
            };
            countRequest.onsuccess = () => {
                const hasData = countRequest.result > 0;
                db.close();
                resolve(hasData);
            };
        };
    });
}

/**
 * Deletes the legacy IndexedDB `dict` store to reclaim its space after a re-import.
 * @returns {Promise<void>}
 */
export function deleteLegacyIndexedDbDictionary() {
    if (typeof indexedDB === 'undefined') { return Promise.resolve(); }
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
        request.onsuccess = () => resolve();
    });
}

/**
 * Requests persistent storage so the OPFS-backed database is less likely to be evicted.
 * @returns {Promise<boolean>} Whether storage is persisted (false if the API is unavailable).
 */
export async function requestPersistentStorage() {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
        return false;
    }
    return navigator.storage.persist();
}
