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
 * @typedef {import('payload-codec').PayloadCodec} PayloadCodec
 */

/**
 * Interim compressing codec (see plan/design.md §6): raw DEFLATE via pako with an optional 32 KB
 * preset dictionary trained from a sample of the dictionary's own payloads. Pure JS (no WASM), so
 * it works before the zstd WASM build lands; the payload stays randomly decodable (each row is an
 * independent DEFLATE stream sharing only the preset dictionary).
 *
 * pako is injected (browser: vendored `ext/lib/pako.js`; node tests: the `pako` package), mirroring
 * how sqlite3 is injected — see plan/decisions.md #9.
 * @implements {PayloadCodec}
 */
export class DeflatePayloadCodec {
    /**
     * @param {import('pako')} pako The pako module (needs `deflateRaw`/`inflateRaw`).
     * @param {{level?: number, dictionarySampleBytes?: number}} [options]
     */
    constructor(pako, {level = 6, dictionarySampleBytes = 32768} = {}) {
        /** @type {import('pako')} */
        this._pako = pako;
        /** @type {number} */
        this._level = level;
        /** @type {number} */
        this._dictionarySampleBytes = dictionarySampleBytes;
        /** @type {TextEncoder} */
        this._encoder = new TextEncoder();
        /** @type {TextDecoder} */
        this._decoder = new TextDecoder();
    }

    /** @returns {import('dictionary-database').PayloadCodecName} */
    get name() {
        return 'deflate';
    }

    /**
     * Builds a preset dictionary by concatenating serialized sample payloads up to
     * `dictionarySampleBytes`. DEFLATE resolves back-references into the preset dictionary, so the
     * strings shared across rows (structured-content keys/tags, common tokens) are stored once.
     * @param {unknown[][]} payloadSamples
     * @returns {Promise<Uint8Array>}
     */
    async train(payloadSamples) {
        const chunks = [];
        let total = 0;
        for (const sample of payloadSamples) {
            const bytes = this._encoder.encode(JSON.stringify(sample));
            chunks.push(bytes);
            total += bytes.length;
            if (total >= this._dictionarySampleBytes) { break; }
        }
        const size = Math.min(total, this._dictionarySampleBytes);
        const dictionary = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            const remaining = size - offset;
            if (remaining <= 0) { break; }
            const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
            dictionary.set(slice, offset);
            offset += slice.length;
        }
        return dictionary;
    }

    /**
     * @param {unknown[]} payload
     * @param {?Uint8Array} dictionary
     * @returns {Uint8Array}
     */
    encode(payload, dictionary) {
        const bytes = this._encoder.encode(JSON.stringify(payload));
        return this._pako.deflateRaw(bytes, this._deflateOptions(dictionary));
    }

    /**
     * @param {Uint8Array} blob
     * @param {?Uint8Array} dictionary
     * @returns {unknown[]}
     */
    decode(blob, dictionary) {
        const bytes = this._pako.inflateRaw(blob, this._inflateOptions(dictionary));
        const parsed = parseJson(this._decoder.decode(bytes));
        return Array.isArray(parsed) ? parsed : [];
    }

    /**
     * @param {?Uint8Array} dictionary
     * @returns {import('pako').DeflateFunctionOptions}
     */
    _deflateOptions(dictionary) {
        return dictionary !== null && dictionary.length > 0 ?
            {level: this._level, dictionary} :
            {level: this._level};
    }

    /**
     * @param {?Uint8Array} dictionary
     * @returns {import('pako').InflateFunctionOptions}
     */
    _inflateOptions(dictionary) {
        return dictionary !== null && dictionary.length > 0 ? {dictionary} : {};
    }
}
