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

import {NativeEngineClient} from './native-engine-client.js';

/**
 * The options/profile store, as the extension sees it once the settings live in the app container.
 *
 * A pair of host actions (`optionsLoad`/`optionsSave`) reading and writing one JSON file — not
 * engine actions, because they never touch the dictionary engine and a dictionary install replaces
 * that database wholesale, which options must outlive (plan/native-protocol.md → Host actions).
 * `OptionsUtil` keeps every line of the versioned migration; this only moves the bytes off
 * `chrome.storage.local` and into the container, where a standalone app can read them.
 */
export class NativeOptionsStore {
    /**
     * @param {?NativeEngineClient} [client] Injected by tests; the extension uses the default.
     */
    constructor(client = null) {
        /** @type {NativeEngineClient} */
        this._client = client ?? new NativeEngineClient();
    }

    /**
     * @returns {Promise<?string>} The stored options JSON string, or `null` if the host has none
     *   yet — the caller's cue to migrate from the legacy store or fall back to defaults.
     */
    async load() {
        const response = await this._client.invokeHost('optionsLoad');
        return typeof response.options === 'string' ? response.options : null;
    }

    /**
     * @param {string} optionsJson The options serialized to a JSON string.
     * @returns {Promise<void>}
     */
    async save(optionsJson) {
        await this._client.invokeHost('optionsSave', {options: optionsJson});
    }
}
