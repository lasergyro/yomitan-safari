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

import * as pako from 'pako';
import {describe, expect, test} from 'vitest';
import {DeflatePayloadCodec} from '../ext/js/dictionary/deflate-payload-codec.js';
import {IdentityPayloadCodec} from '../ext/js/dictionary/payload-codec.js';

/** Representative payloads mirroring DatabaseTermEntryPayload: [definitionTags, rules, score, glossary, termTags]. */
const samplePayloads = [
    ['n', 'v5', 0, ['a simple gloss'], 'tag1'],
    [null, '', -3, [{type: 'structured-content', content: [{tag: 'div', content: 'hallo welt'}]}, 'zweite'], void 0],
    ['adj', 'v1 vt', 42, [{type: 'text', text: 'text node'}], ''],
    ['n', 'v5', 5, [], null],
    ['name', '', 0, [{type: 'image', path: 'img/x.png', width: 10, height: 10}], 'proper'],
];

/**
 * JSON round-trip turns `undefined` array elements into `null`; the identity/deflate codecs both go
 * through JSON, so normalize the expected value the same way.
 * @param {unknown[]} payload
 * @returns {unknown[]}
 */
function jsonNormalized(payload) {
    return payload.map((value) => (typeof value === 'undefined' ? null : value));
}

describe('DeflatePayloadCodec', () => {
    test('name is deflate', () => {
        expect(new DeflatePayloadCodec(pako).name).toBe('deflate');
    });

    test('round-trips every payload shape without a dictionary', () => {
        const codec = new DeflatePayloadCodec(pako);
        for (const payload of samplePayloads) {
            const blob = codec.encode(payload, null);
            expect(blob).toBeInstanceOf(Uint8Array);
            expect(codec.decode(blob, null)).toStrictEqual(jsonNormalized(payload));
        }
    });

    test('round-trips with a trained preset dictionary', async () => {
        const codec = new DeflatePayloadCodec(pako);
        const dictionary = await codec.train(samplePayloads);
        expect(dictionary).toBeInstanceOf(Uint8Array);
        expect(dictionary.length).toBeGreaterThan(0);
        for (const payload of samplePayloads) {
            const blob = codec.encode(payload, dictionary);
            expect(codec.decode(blob, dictionary)).toStrictEqual(jsonNormalized(payload));
        }
    });

    test('compresses relative to the identity codec', () => {
        const identity = new IdentityPayloadCodec();
        const deflate = new DeflatePayloadCodec(pako);
        // A repetitive structured-content payload (the heavy, compressible case).
        const payload = [null, '', 0, Array.from({length: 40}, (_v, i) => ({type: 'structured-content', content: [{tag: 'div', content: `entry ${i} common repeated text`}]})), null];
        const identitySize = identity.encode(payload, null).length;
        const deflateSize = deflate.encode(payload, null).length;
        expect(deflateSize).toBeLessThan(identitySize);
    });

    test('train caps the dictionary at dictionarySampleBytes', async () => {
        const codec = new DeflatePayloadCodec(pako, {dictionarySampleBytes: 64});
        const big = Array.from({length: 500}, (_v, i) => [`tag${i}`, 'v5', i, [`gloss ${i}`], null]);
        const dictionary = await codec.train(big);
        expect(dictionary.length).toBeLessThanOrEqual(64);
    });
});
