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

import type * as DictionaryDatabase from './dictionary-database';

/**
 * A `PayloadCodec` serializes and (optionally) compresses a term row's non-indexed payload -- the
 * positional array `[definitionTags, rules, score, glossary, termTags]` -- into a single byte blob
 * for the SQLite `terms.payload` column, and decodes it back on read. Implementations may use a
 * per-dictionary shared dictionary produced by `train()`; codecs that do not ignore that argument
 * and `train()` returns an empty buffer. See payload-codec.js and plan/design.md → Payload codec.
 */
export type PayloadCodec = {
    name: DictionaryDatabase.PayloadCodecName;
    /**
     * Optional async initialization, awaited by `DictionaryDatabaseSqlite.prepare()` for every
     * registered codec before any row is read or written. It exists because `encode`/`decode` are
     * synchronous -- they sit inside sqlite's synchronous query and transaction paths -- while a
     * WASM-backed codec needs to load its module first, and a read of existing rows offers no other
     * async moment in which to do it. Codecs needing no setup simply omit this.
     */
    prepare?: () => Promise<void>;
    train: (payloadSamples: unknown[][]) => Promise<Uint8Array>;
    encode: (payload: unknown[], dictionary: Uint8Array | null) => Uint8Array;
    decode: (blob: Uint8Array, dictionary: Uint8Array | null) => unknown[];
};
