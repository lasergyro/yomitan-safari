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

import {parseJson} from '../core/json.js';

/**
 * A `PayloadCodec` serializes and (optionally) compresses a term row's non-indexed payload
 * -- the positional array `[definitionTags, rules, score, glossary, termTags]` -- into a
 * single byte blob for the SQLite `terms.payload` column, and decodes it back on read.
 *
 * Implementations may use a per-dictionary shared dictionary (trained on that dictionary's own
 * payloads) so that strings repeated across rows (structured-content keys/tags, common tokens)
 * are stored once. The shared dictionary is produced by `train()` at import time, stored
 * alongside the dictionary, and passed back to `encode`/`decode`. Codecs that do not use a
 * dictionary ignore that argument and `train()` returns an empty buffer.
 *
 * See plan/design.md (sections 6 and 8.2) for the rollout: `identity` (no compression,
 * correctness baseline) -> `deflate` (pako + preset dict) -> `zstd` (trained dict). The
 * `PayloadCodec` type lives in types/ext/payload-codec.d.ts.
 * @typedef {import('payload-codec').PayloadCodec} PayloadCodec
 */

/**
 * The baseline codec: JSON serialization with no compression and no shared dictionary. It
 * exists so the SQLite backend can be built and verified for correctness before a compressing
 * codec is wired in; `encode`/`decode` are an exact round-trip.
 * @implements {PayloadCodec}
 */
export class IdentityPayloadCodec {
    /** @returns {import('dictionary-database').PayloadCodecName} */
    get name() {
        return 'identity';
    }

    /**
     * @param {unknown[][]} _payloadSamples
     * @returns {Promise<Uint8Array>}
     */
    async train(_payloadSamples) {
        return new Uint8Array(0);
    }

    /**
     * @param {unknown[]} payload
     * @param {?Uint8Array} _dictionary
     * @returns {Uint8Array}
     */
    encode(payload, _dictionary) {
        return new TextEncoder().encode(JSON.stringify(payload));
    }

    /**
     * @param {Uint8Array} blob
     * @param {?Uint8Array} _dictionary
     * @returns {unknown[]}
     */
    decode(blob, _dictionary) {
        const parsed = parseJson(new TextDecoder().decode(blob));
        return Array.isArray(parsed) ? parsed : [];
    }
}
