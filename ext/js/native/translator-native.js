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
import {encodeFindKanjiOptions, encodeFindTermsOptions} from './native-protocol.js';

/**
 * The translator, as the backend sees it once deinflection lives in the app.
 *
 * Same method names and semantics as `Translator`, so `Backend` is unchanged by the move. What
 * changes is where the work happens: `findTerms` used to run here and issue half a dozen separate
 * database calls — one per deinflection batch, plus term meta, plus tags — each of which would now
 * be a bridge round trip carrying every candidate that was considered. Running the translator in
 * the app makes a lookup **one** call carrying only the entries that survived it.
 *
 * There is deliberately no local cache. The translator's own `_tagCache` moved with it, and a cache
 * on this side would be a second place where dictionary state could go stale — which is exactly
 * what `clearDatabaseCaches` exists to prevent.
 */
export class TranslatorNative {
    /**
     * @param {?NativeEngineClient} [client] Injected by tests; the extension uses the default.
     */
    constructor(client = null) {
        /** @type {NativeEngineClient} */
        this._client = client ?? new NativeEngineClient();
    }

    /**
     * Present because `Backend` calls it, and because `Translator.prepare()` (loading the language
     * text processors and reading normalizers) is a real step — it just happens in the engine now,
     * as part of opening the database.
     * @returns {void}
     */
    prepare() {
        // Intentionally empty.
    }

    /**
     * @param {import('translator').FindTermsMode} mode
     * @param {string} text
     * @param {import('translation').FindTermsOptions} options
     * @returns {Promise<{dictionaryEntries: import('dictionary').TermDictionaryEntry[], originalTextLength: number}>}
     */
    findTerms(mode, text, options) {
        return this._client.invoke('termsFind', {mode, text, options: encodeFindTermsOptions(options)});
    }

    /**
     * @param {string} text
     * @param {import('translation').FindKanjiOptions} options
     * @returns {Promise<import('dictionary').KanjiDictionaryEntry[]>}
     */
    findKanji(text, options) {
        return this._client.invoke('kanjiFind', {text, options: encodeFindKanjiOptions(options)});
    }

    /**
     * @param {import('translator').TermReadingList} termReadingList
     * @param {string[]} dictionaries
     * @returns {Promise<import('translator').TermFrequencySimple[]>}
     */
    getTermFrequencies(termReadingList, dictionaries) {
        return this._client.invoke('getTermFrequencies', {termReadingList, dictionaries});
    }

    /**
     * Drops the engine's tag cache after the dictionary set changes.
     *
     * Fire-and-forget, matching the synchronous `Translator.clearDatabaseCaches()` the callers were
     * written against. A failure here means a stale tag on a subsequent lookup, not a broken one,
     * and making every caller await a cache invalidation would be worse than that.
     * @returns {void}
     */
    clearDatabaseCaches() {
        void this._client.invoke('clearDatabaseCaches', {}).catch(() => {});
    }
}
