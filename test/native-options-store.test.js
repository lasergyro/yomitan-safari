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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {parseJson} from '../ext/js/core/json.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {NativeOptionsStore} from '../ext/js/native/native-options-store.js';
import {chrome, fetch} from './mocks/common.js';

/**
 * A `NativeEngineClient` stand-in that records the host actions it was asked for and returns a
 * canned reply. Only `invokeHost` is exercised — `NativeOptionsStore` never touches the engine.
 * @param {{[key: string]: unknown}} reply
 * @returns {{calls: {action: string, params: {[key: string]: unknown}}[], invokeHost: (action: string, params?: {[key: string]: unknown}) => Promise<{[key: string]: unknown}>}}
 */
function createFakeClient(reply) {
    /** @type {{action: string, params: {[key: string]: unknown}}[]} */
    const calls = [];
    return {
        calls,
        /**
         * @param {string} action
         * @param {{[key: string]: unknown}} [params]
         * @returns {Promise<{[key: string]: unknown}>}
         */
        invokeHost(action, params = {}) {
            calls.push({action, params});
            return Promise.resolve(reply);
        },
    };
}

describe('NativeOptionsStore', () => {
    test('load returns the stored JSON string', async () => {
        const client = createFakeClient({ok: true, options: '{"version":1}'});
        const store = new NativeOptionsStore(/** @type {import('../ext/js/native/native-engine-client.js').NativeEngineClient} */ (/** @type {unknown} */ (client)));
        expect(await store.load()).toBe('{"version":1}');
        expect(client.calls).toEqual([{action: 'optionsLoad', params: {}}]);
    });

    test('load returns null when the host omits options (no file yet)', async () => {
        const client = createFakeClient({ok: true});
        const store = new NativeOptionsStore(/** @type {import('../ext/js/native/native-engine-client.js').NativeEngineClient} */ (/** @type {unknown} */ (client)));
        expect(await store.load()).toBeNull();
    });

    test('save forwards the JSON string under the options field', async () => {
        const client = createFakeClient({ok: true, bytesWritten: 12});
        const store = new NativeOptionsStore(/** @type {import('../ext/js/native/native-engine-client.js').NativeEngineClient} */ (/** @type {unknown} */ (client)));
        await store.save('{"version":2}');
        expect(client.calls).toEqual([{action: 'optionsSave', params: {options: '{"version":2}'}}]);
    });
});

/**
 * An in-memory `OptionsStorage`, so the migration and round-trip logic is testable without a host.
 * @param {?string} [initial]
 * @returns {{state: {value: ?string, saves: string[]}, load: () => Promise<?string>, save: (optionsJson: string) => Promise<void>}}
 */
function createFakeStorage(initial = null) {
    /** @type {{value: ?string, saves: string[]}} */
    const state = {value: initial, saves: []};
    return {
        state,
        /** @returns {Promise<?string>} */
        load() { return Promise.resolve(state.value); },
        /**
         * @param {string} optionsJson
         * @returns {Promise<void>}
         */
        save(optionsJson) {
            state.value = optionsJson;
            state.saves.push(optionsJson);
            return Promise.resolve();
        },
    };
}

describe('OptionsUtil storage seam', () => {
    // `prepare()` fetches the schema through `chrome.runtime.getURL`; the base mock has no
    // `storage`, so the legacy-migration read finds nothing unless a test stubs one in.
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('chrome', chrome);

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('chrome', chrome);
    });

    test('save serializes options into the injected storage', async () => {
        const storage = createFakeStorage();
        const optionsUtil = new OptionsUtil(storage);
        await optionsUtil.prepare();
        const options = optionsUtil.getDefault();
        await optionsUtil.save(options);
        expect(storage.state.saves).toHaveLength(1);
        expect(parseJson(/** @type {string} */ (storage.state.value))).toEqual(options);
    });

    test('load reads and persists back through the storage', async () => {
        const storage = createFakeStorage();
        const optionsUtil = new OptionsUtil(storage);
        await optionsUtil.prepare();
        const seed = optionsUtil.getDefault();
        storage.state.value = JSON.stringify(seed);

        const loaded = await optionsUtil.load();
        expect(loaded.version).toBe(seed.version);
        // load() rewrites the migrated/updated options; the store must end up holding them.
        expect(storage.state.saves).toHaveLength(1);
    });

    test('load falls back to defaults when nothing is stored and no legacy copy exists', async () => {
        // No chrome global, so the legacy read finds nothing to migrate.
        const storage = createFakeStorage();
        const optionsUtil = new OptionsUtil(storage);
        await optionsUtil.prepare();
        const loaded = await optionsUtil.load();
        expect(loaded).toEqual(optionsUtil.getDefault());
        // Defaults are not persisted, matching the pre-move behaviour.
        expect(storage.state.saves).toHaveLength(0);
    });

    test('load migrates a legacy chrome.storage.local copy into the native store once', async () => {
        const storage = createFakeStorage();
        const optionsUtil = new OptionsUtil(storage);
        await optionsUtil.prepare();
        const legacy = optionsUtil.getDefault();
        legacy.profiles[0].name = 'migrated';

        vi.stubGlobal('chrome', {
            runtime: chrome.runtime,
            storage: {
                local: {
                    /**
                     * @param {string[]} _keys
                     * @param {(store: {options: string}) => void} callback
                     */
                    get(_keys, callback) { callback({options: JSON.stringify(legacy)}); },
                },
            },
        });

        const loaded = await optionsUtil.load();
        expect(loaded.profiles[0].name).toBe('migrated');
        // The migrated options are written into the native store, so the next launch reads them there.
        expect(storage.state.saves).toHaveLength(1);
        const stored = /** @type {import('settings').Options} */ (parseJson(/** @type {string} */ (storage.state.value)));
        expect(stored.profiles[0].name).toBe('migrated');
    });
});
