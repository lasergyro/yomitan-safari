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

/** @type {?Promise<import('pako')>} */
let vendoredPakoPromise = null;

/**
 * Loads the vendored browser build, memoized. Only reached when nothing is injected (the extension
 * path); the dynamic import keeps pako out of the module graph when the SQLite backend is not
 * selected.
 * @returns {Promise<import('pako')>}
 */
function loadVendoredPako() {
    if (vendoredPakoPromise === null) {
        vendoredPakoPromise = import('../../lib/pako.js');
    }
    return vendoredPakoPromise;
}

/**
 * The shipped compressing codec (plan/02-decisions.md #8, #26): raw DEFLATE via pako with a 32 KB
 * preset dictionary built from a sample of the dictionary's own payloads. Pure JS (no WASM), and the
 * payload stays randomly decodable — each row is an independent DEFLATE stream sharing only the
 * preset dictionary. Measured on the real `kty-de-en`: 3.55x on the payload, ~150 MB total database
 * against ~700 MB of IndexedDB.
 *
 * pako is injected (node tests pass the `pako` package); with nothing injected, `prepare()` loads the
 * vendored `ext/lib/pako.js` — the extension path, mirroring how sqlite3 is injected
 * (plan/02-decisions.md #10).
 * @implements {PayloadCodec}
 */
export class DeflatePayloadCodec {
    /**
     * @param {?import('pako')} [pako] The pako module (needs `deflateRaw`/`inflateRaw`). Omitted, the
     *   vendored build is loaded on `prepare()`.
     * @param {{level?: number, dictionarySampleBytes?: number}} [options]
     */
    constructor(pako = null, {level = 6, dictionarySampleBytes = 32768} = {}) {
        /** @type {?import('pako')} */
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
     * Loads the vendored pako when none was injected. Idempotent. `encode`/`decode` are synchronous
     * by interface contract, so the module has to be resolved before the first row is touched;
     * `DictionaryDatabaseSqlite.prepare()` awaits this for every registered codec.
     * @returns {Promise<void>}
     */
    async prepare() {
        if (this._pako === null) { this._pako = await loadVendoredPako(); }
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
        return this._require().deflateRaw(bytes, this._deflateOptions(dictionary));
    }

    /**
     * @param {Uint8Array} blob
     * @param {?Uint8Array} dictionary
     * @returns {unknown[]}
     */
    decode(blob, dictionary) {
        const bytes = this._require().inflateRaw(blob, this._inflateOptions(dictionary));
        const parsed = parseJson(this._decoder.decode(bytes));
        return Array.isArray(parsed) ? parsed : [];
    }

    /**
     * @returns {import('pako')}
     * @throws {Error} If `prepare()` has not completed.
     */
    _require() {
        if (this._pako === null) {
            throw new Error('DeflatePayloadCodec is not prepared; await prepare() before encode/decode');
        }
        return this._pako;
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
