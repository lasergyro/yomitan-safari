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
 * Default trained-dictionary size. zstd's own guidance is ~100 KB; the extra is headroom for the
 * structured-content vocabulary, and `train()` only ever returns what ZDICT actually fills.
 */
const DEFAULT_DICTIONARY_CAPACITY = 112640;

/**
 * Default compression level. Measured on a synthetic corpus of ~330-byte rows, the ratio plateaus
 * here: levels 15, 19 and 22 all land on the same ratio while 19 is ~3x slower to encode than 15.
 * That plateau is structural rather than a quirk of the sample -- rows this small give a longer
 * match search nothing extra to find, since essentially all of the redundancy is resolved against
 * the shared dictionary rather than within the row. See plan/zstd/README.md.
 */
const DEFAULT_LEVEL = 15;

/** @type {?Promise<import('zstd').ZstdModule>} */
let vendoredZstdPromise = null;

/**
 * Loads the vendored browser build. Memoized: the module owns a WASM heap and the cached
 * CDict/DDict handles are addresses into it, so a second instance would be pure waste (and the
 * sqlite equivalent of this mistake caused a real bug -- plan/02-decisions.md #11).
 * @returns {Promise<import('zstd').ZstdModule>}
 */
function loadVendoredZstd() {
    if (vendoredZstdPromise === null) {
        vendoredZstdPromise = (async () => {
            const {default: zstdInitModule} = await import('../../lib/zstd.js');
            return /** @type {import('zstd').ZstdModule} */ (/** @type {unknown} */ (await zstdInitModule()));
        })();
    }
    return vendoredZstdPromise;
}

/**
 * The target codec (plan/01-design.md §6, plan/zstd/README.md): zstd with a per-dictionary
 * dictionary trained by ZDICT from a sample of that dictionary's own payloads. Each row stays an
 * independent frame -- randomly decodable -- sharing only the trained dictionary, which is what
 * makes per-row compression of ~300-byte payloads worthwhile at all.
 *
 * The WASM module is injected (node tests pass the build from dev/vendor/zstd; the extension lets
 * `prepare()` self-load the vendored copy from ext/lib), mirroring sqlite3 and pako --
 * plan/02-decisions.md #10.
 *
 * `prepare()` must be awaited before `encode`/`decode`, which are synchronous by interface contract
 * while WASM init is not. `DictionaryDatabaseSqlite.prepare()` does this for every registered codec.
 * @implements {PayloadCodec}
 */
export class ZstdPayloadCodec {
    /**
     * @param {?import('zstd').ZstdInitModule} [initModule] The emscripten factory. Omitted, the
     *   vendored browser build is loaded on `prepare()` -- the extension path.
     * @param {{level?: number, dictionaryCapacity?: number}} [options]
     */
    constructor(initModule = null, {level = DEFAULT_LEVEL, dictionaryCapacity = DEFAULT_DICTIONARY_CAPACITY} = {}) {
        /** @type {?import('zstd').ZstdInitModule} */
        this._initModule = initModule;
        /** @type {?import('zstd').ZstdModule} */
        this._module = null;
        /** @type {number} */
        this._level = level;
        /** @type {number} */
        this._dictionaryCapacity = dictionaryCapacity;
        /**
         * Compiled dictionary handles, keyed by the dictionary bytes they were built from. Building
         * a CDict parses the dictionary and builds match tables, so this must not happen per row.
         * The backend caches one `Uint8Array` instance per dictionary and passes that same instance
         * back on every call, which is what makes an identity-keyed map effective here.
         * @type {WeakMap<Uint8Array, {cdict: import('zstd').ZstdDictHandle, ddict: import('zstd').ZstdDictHandle}>}
         */
        this._dictHandles = new WeakMap();
        /** @type {TextEncoder} */
        this._encoder = new TextEncoder();
        /** @type {TextDecoder} */
        this._decoder = new TextDecoder();
    }

    /** @returns {import('dictionary-database').PayloadCodecName} */
    get name() {
        return 'zstd';
    }

    /**
     * Loads the WASM module. Idempotent, and safe to call concurrently.
     * @returns {Promise<void>}
     */
    async prepare() {
        if (this._module !== null) { return; }
        this._module = this._initModule === null ?
            await loadVendoredZstd() :
            await this._initModule();
    }

    /**
     * Trains a dictionary with ZDICT over the sample payloads. Training is what separates this from
     * simply reusing raw sample bytes as a dictionary: ZDICT selects and orders the substrings that
     * actually pay off across the corpus.
     *
     * Returns an empty buffer when training is not possible -- ZDICT needs a corpus of a certain
     * size and variety, and legitimately fails on tiny dictionaries. The backend maps empty to
     * "no dictionary", so those rows are simply compressed without one.
     * @param {unknown[][]} payloadSamples
     * @returns {Promise<Uint8Array>}
     */
    async train(payloadSamples) {
        await this.prepare();
        const module = this._require();
        const samples = payloadSamples.map((sample) => this._encoder.encode(JSON.stringify(sample)));
        const totalBytes = samples.reduce((total, sample) => total + sample.length, 0);
        if (samples.length === 0 || totalBytes === 0) { return new Uint8Array(0); }

        const capacity = this._dictionaryCapacity;
        const samplesPointer = module._malloc(totalBytes);
        const sizesPointer = module._malloc(samples.length * 4);
        const dictionaryPointer = module._malloc(capacity);
        try {
            let offset = 0;
            for (const sample of samples) {
                module.HEAPU8.set(sample, samplesPointer + offset);
                offset += sample.length;
            }
            for (let i = 0; i < samples.length; ++i) {
                module.HEAPU32[(sizesPointer >> 2) + i] = samples[i].length;
            }
            const size = module._yz_train(dictionaryPointer, capacity, samplesPointer, sizesPointer, samples.length);
            if (size <= 0) { return new Uint8Array(0); }
            return module.HEAPU8.slice(dictionaryPointer, dictionaryPointer + size);
        } finally {
            module._free(samplesPointer);
            module._free(sizesPointer);
            module._free(dictionaryPointer);
        }
    }

    /**
     * @param {unknown[]} payload
     * @param {?Uint8Array} dictionary
     * @returns {Uint8Array}
     */
    encode(payload, dictionary) {
        const module = this._require();
        const bytes = this._encoder.encode(JSON.stringify(payload));
        const {cdict} = this._handlesFor(dictionary);
        const bound = module._yz_compress_bound(bytes.length);
        const sourcePointer = module._malloc(bytes.length);
        const destinationPointer = module._malloc(bound);
        try {
            module.HEAPU8.set(bytes, sourcePointer);
            const size = module._yz_compress(destinationPointer, bound, sourcePointer, bytes.length, cdict, this._level);
            if (size < 0) { throw new Error('zstd compression failed'); }
            return module.HEAPU8.slice(destinationPointer, destinationPointer + size);
        } finally {
            module._free(sourcePointer);
            module._free(destinationPointer);
        }
    }

    /**
     * @param {Uint8Array} blob
     * @param {?Uint8Array} dictionary
     * @returns {unknown[]}
     */
    decode(blob, dictionary) {
        const module = this._require();
        const {ddict} = this._handlesFor(dictionary);
        const sourcePointer = module._malloc(blob.length);
        try {
            module.HEAPU8.set(blob, sourcePointer);
            // Our frames are always written by the single-shot API, so the content size is in the
            // header and we never need a guess-and-grow loop.
            const contentSize = module._yz_frame_content_size(sourcePointer, blob.length);
            if (contentSize < 0) { throw new Error('zstd frame has no usable content size'); }
            const destinationPointer = module._malloc(contentSize);
            try {
                const size = module._yz_decompress(destinationPointer, contentSize, sourcePointer, blob.length, ddict);
                if (size < 0) { throw new Error('zstd decompression failed'); }
                // Copy out of the WASM heap before decoding rather than passing a subarray view of
                // it: Safari's TextDecoder rejects a view backed by the growable WASM memory with a
                // TypeError, while node accepts it happily. Caught by npm run test:safari.
                const text = this._decoder.decode(module.HEAPU8.slice(destinationPointer, destinationPointer + size));
                const parsed = parseJson(text);
                return Array.isArray(parsed) ? parsed : [];
            } finally {
                module._free(destinationPointer);
            }
        } finally {
            module._free(sourcePointer);
        }
    }

    /**
     * Returns the compiled dictionary handles for `dictionary`, building them once per distinct
     * dictionary. `{cdict: 0, ddict: 0}` means "no dictionary", which the shim accepts.
     * @param {?Uint8Array} dictionary
     * @returns {{cdict: import('zstd').ZstdDictHandle, ddict: import('zstd').ZstdDictHandle}}
     */
    _handlesFor(dictionary) {
        if (dictionary === null || dictionary.length === 0) { return {cdict: 0, ddict: 0}; }
        const cached = this._dictHandles.get(dictionary);
        if (typeof cached !== 'undefined') { return cached; }
        const module = this._require();
        const pointer = module._malloc(dictionary.length);
        try {
            module.HEAPU8.set(dictionary, pointer);
            const handles = {
                cdict: module._yz_cdict_create(pointer, dictionary.length, this._level),
                ddict: module._yz_ddict_create(pointer, dictionary.length),
            };
            // Failing here would silently fall back to dictionary-less coding for one of the two
            // directions, which is far worse than an error: encode and decode must agree, or rows
            // become unreadable.
            if (handles.cdict === 0 || handles.ddict === 0) {
                throw new Error('Failed to build zstd dictionary handles');
            }
            this._dictHandles.set(dictionary, handles);
            return handles;
        } finally {
            // The CDict/DDict copy the dictionary content, so the staging buffer is ours to release.
            module._free(pointer);
        }
    }

    /**
     * @returns {import('zstd').ZstdModule}
     * @throws {Error} If `prepare()` has not completed.
     */
    _require() {
        if (this._module === null) {
            throw new Error('ZstdPayloadCodec is not prepared; await prepare() before encode/decode');
        }
        return this._module;
    }
}
