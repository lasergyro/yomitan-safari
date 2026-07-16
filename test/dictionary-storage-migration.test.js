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

import {IDBKeyRange, indexedDB} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {deleteLegacyIndexedDbDictionary, legacyIndexedDbDictionaryExists, requestPersistentStorage} from '../ext/js/dictionary/sqlite/dictionary-storage-migration.js';

/**
 * @param {{withData: boolean}} options
 * @returns {Promise<void>}
 */
function createLegacyDatabase({withData}) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('dict', 60);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('dictionaries', {autoIncrement: true, keyPath: 'id'});
            db.createObjectStore('terms', {autoIncrement: true, keyPath: 'id'});
        };
        request.onsuccess = () => {
            const db = request.result;
            if (!withData) {
                db.close();
                resolve();
                return;
            }
            const transaction = db.transaction(['dictionaries'], 'readwrite');
            transaction.objectStore('dictionaries').add({title: 'Legacy Dictionary', version: 3});
            transaction.oncomplete = () => {
                db.close();
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        };
    });
}

describe('dictionary storage migration helpers', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', indexedDB);
        vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    });
    afterEach(async () => {
        await deleteLegacyIndexedDbDictionary();
        vi.unstubAllGlobals();
    });

    test('reports no legacy store when none exists', async () => {
        expect(await legacyIndexedDbDictionaryExists()).toBe(false);
    });

    test('does not leave an empty database behind after probing', async () => {
        await legacyIndexedDbDictionaryExists();
        if (typeof indexedDB.databases === 'function') {
            const databases = await indexedDB.databases();
            expect(databases.some((info) => info.name === 'dict')).toBe(false);
        }
    });

    test('reports false for an empty legacy store (stores but no dictionaries rows)', async () => {
        await createLegacyDatabase({withData: false});
        expect(await legacyIndexedDbDictionaryExists()).toBe(false);
    });

    test('detects a legacy store that holds imported dictionaries', async () => {
        await createLegacyDatabase({withData: true});
        expect(await legacyIndexedDbDictionaryExists()).toBe(true);
    });

    test('deletes the legacy store', async () => {
        await createLegacyDatabase({withData: true});
        expect(await legacyIndexedDbDictionaryExists()).toBe(true);
        await deleteLegacyIndexedDbDictionary();
        expect(await legacyIndexedDbDictionaryExists()).toBe(false);
    });

    test('requestPersistentStorage returns false when the API is unavailable', async () => {
        vi.stubGlobal('navigator', {});
        expect(await requestPersistentStorage()).toBe(false);
        vi.stubGlobal('navigator', {storage: {persist: async () => true}});
        expect(await requestPersistentStorage()).toBe(true);
    });
});
