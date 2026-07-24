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

/**
 * `TextEncoder`/`TextDecoder` for JavaScriptCore.
 *
 * They are Web IDL, supplied by WebCore — bare `JSContext` has neither, and the payload codec uses
 * both on every row it touches. Rather than bridge each call into Swift (a JSC boundary crossing per
 * row, on the hover path) these are pure JS, so they are also unit-testable in node against the real
 * platform implementations. `test/native/text-codec-shim.test.js` does exactly that, including the
 * cases hand-written UTF-8 usually gets wrong: surrogate pairs, lone surrogates, and truncated
 * multi-byte sequences.
 *
 * Only the subset the engine uses is implemented: UTF-8, no streaming, no `encodeInto`, no `fatal`
 * or `ignoreBOM` options. Anything else throws rather than silently behaving differently from the
 * browser.
 */

/**
 * How many code units to build before flushing into the result. `String.fromCharCode.apply` with a
 * very large array overflows the argument limit, and appending one character at a time is markedly
 * slower on the glossary-sized strings the codec decodes.
 * @type {number}
 */
const CHUNK_SIZE = 4096;

/** How many of a lead byte's bits carry code-point data, indexed by continuation-byte count. */
const LEAD_MASK = [0x7f, 0x1f, 0x0f, 0x07];

/** Minimal UTF-8 `TextEncoder`. */
export class TextEncoderShim {
    /** @returns {string} */
    get encoding() {
        return 'utf-8';
    }

    /**
     * @param {string} [input]
     * @returns {Uint8Array}
     */
    encode(input = '') {
        const {length} = input;
        // Worst case is 3 bytes per code unit (a BMP character); a surrogate pair is 2 units and 4
        // bytes, so it can never exceed this. Allocating the bound once and subarray-ing at the end
        // beats growing, and beats a counting pre-pass.
        const bytes = new Uint8Array(length * 3);
        let at = 0;
        for (let i = 0; i < length; ++i) {
            let code = input.charCodeAt(i);
            if (code < 0x80) {
                bytes[at++] = code;
                continue;
            }
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < length) {
                const low = input.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                    ++i;
                }
            }
            if (code < 0x800) {
                bytes[at++] = 0xc0 | (code >> 6);
                bytes[at++] = 0x80 | (code & 0x3f);
            } else if (code < 0x10000) {
                // An unpaired surrogate reaches here and must be encoded as U+FFFD, not as its raw
                // code point: WTF-8 is not UTF-8, and a lone surrogate that survived encoding would
                // decode back to a different string.
                if (code >= 0xd800 && code <= 0xdfff) { code = 0xfffd; }
                bytes[at++] = 0xe0 | (code >> 12);
                bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
                bytes[at++] = 0x80 | (code & 0x3f);
            } else {
                bytes[at++] = 0xf0 | (code >> 18);
                bytes[at++] = 0x80 | ((code >> 12) & 0x3f);
                bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
                bytes[at++] = 0x80 | (code & 0x3f);
            }
        }
        return bytes.subarray(0, at);
    }
}

/** Minimal UTF-8 `TextDecoder`. */
export class TextDecoderShim {
    /**
     * @param {string} [label]
     * @throws {RangeError} For any encoding other than UTF-8 — silently decoding as UTF-8 instead
     *   would be a subtler failure than not supporting it.
     */
    constructor(label = 'utf-8') {
        const normalized = label.toLowerCase();
        if (normalized !== 'utf-8' && normalized !== 'utf8' && normalized !== 'unicode-1-1-utf-8') {
            throw new RangeError(`The native host only implements UTF-8, not "${label}"`);
        }
    }

    /** @returns {string} */
    get encoding() {
        return 'utf-8';
    }

    /**
     * @param {Uint8Array|ArrayBuffer} [input]
     * @returns {string}
     */
    decode(input) {
        if (typeof input === 'undefined') { return ''; }
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const {length} = bytes;
        let result = '';
        /** @type {number[]} */
        const units = [];
        let i = 0;
        // A UTF-8 BOM is stripped, matching the default (`ignoreBOM: false`) TextDecoder.
        if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { i = 3; }
        while (i < length) {
            const lead = bytes[i];
            if (lead < 0x80) {
                units.push(lead);
                ++i;
                if (units.length >= CHUNK_SIZE) {
                    result += String.fromCharCode(...units);
                    units.length = 0;
                }
                continue;
            }
            // WHATWG's decoder, not a simplification of it. The subtlety that a naive version gets
            // wrong is **how far to skip after a malformed sequence**: only the bytes that were
            // valid continuations are consumed, and the byte that broke the sequence is reconsidered
            // as a fresh lead. `[0x61, 0xc3, 0x62]` is the case that shows it — the platform decoder
            // yields `a\uFFFDb`, and eating the `0x62` as part of the broken sequence would silently
            // drop a character from a payload rather than fail.
            let needed = -1;
            if (lead >= 0xf0) {
                needed = 3;
            } else if (lead >= 0xe0) {
                needed = 2;
            } else if (lead >= 0xc2) {
                needed = 1;
            }
            // 0x80-0xC1 never start a sequence (0xC0/0xC1 would only ever be overlong), and 0xF5-0xFF
            // are past the Unicode range.
            if (needed < 0 || lead > 0xf4) {
                units.push(0xfffd);
                ++i;
                continue;
            }
            // The first continuation byte carries the constraint that rejects overlong forms,
            // surrogates and out-of-range code points before they are ever assembled.
            let lowerBound = 0x80;
            let upperBound = 0xbf;
            switch (lead) {
                case 0xe0: lowerBound = 0xa0; break;
                case 0xed: upperBound = 0x9f; break;
                case 0xf0: lowerBound = 0x90; break;
                case 0xf4: upperBound = 0x8f; break;
                default: break;
            }
            const leadMask = LEAD_MASK[needed];
            let code = lead & leadMask;
            let seen = 0;
            let at = i + 1;
            while (seen < needed && at < length) {
                const byte = bytes[at];
                const low = seen === 0 ? lowerBound : 0x80;
                const high = seen === 0 ? upperBound : 0xbf;
                if (byte < low || byte > high) { break; }
                code = (code << 6) | (byte & 0x3f);
                ++at;
                ++seen;
            }
            if (seen < needed) {
                units.push(0xfffd);
                // `at` is the first byte that did not belong to this sequence, so it gets its own
                // turn as a lead on the next iteration.
                i = at;
            } else {
                i = at;
                if (code < 0x10000) {
                    units.push(code);
                } else {
                    const offset = code - 0x10000;
                    units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
                }
            }
            if (units.length >= CHUNK_SIZE) {
                result += String.fromCharCode(...units);
                units.length = 0;
            }
        }
        if (units.length > 0) { result += String.fromCharCode(...units); }
        return result;
    }
}
