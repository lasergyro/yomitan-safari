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

import {beforeAll, describe, expect, test} from 'vitest';
import {IdentityPayloadCodec} from '../ext/js/dictionary/payload-codec.js';
import {ZstdPayloadCodec} from '../ext/js/dictionary/zstd-payload-codec.js';
import {loadZstdInitModule} from '../dev/zstd/load.js';

/**
 * The WASM module is injected rather than self-loaded, mirroring sqlite3/pako
 * (plan/02-decisions.md #10).
 * @param {{level?: number, dictionaryCapacity?: number}} [options]
 * @returns {Promise<ZstdPayloadCodec>}
 */
async function createCodec(options) {
    const codec = new ZstdPayloadCodec(await loadZstdInitModule(), options);
    await codec.prepare();
    return codec;
}

/** Representative payloads mirroring DatabaseTermEntryPayload: [definitionTags, rules, score, glossary, termTags]. */
const samplePayloads = [
    ['n', 'v5', 0, ['a simple gloss'], 'tag1'],
    [null, '', -3, [{type: 'structured-content', content: [{tag: 'div', content: 'hallo welt'}]}, 'zweite'], void 0],
    ['adj', 'v1 vt', 42, [{type: 'text', text: 'text node'}], ''],
    ['n', 'v5', 5, [], null],
    ['name', '', 0, [{type: 'image', path: 'img/x.png', width: 10, height: 10}], 'proper'],
];

/**
 * JSON round-trip turns `undefined` array elements into `null`; the codecs all go through JSON, so
 * normalize the expected value the same way.
 * @param {unknown[]} payload
 * @returns {unknown[]}
 */
function jsonNormalized(payload) {
    return payload.map((value) => (typeof value === 'undefined' ? null : value));
}

/**
 * ZDICT needs a corpus with real size and variety before it will produce a dictionary, so the
 * training tests need more than the five handwritten payloads above.
 * @param {number} count
 * @returns {unknown[][]}
 */
function trainingCorpus(count) {
    const words = ['haus', 'strasse', 'zeit', 'kraft', 'licht', 'grund', 'blick', 'stein', 'feld', 'buch'];
    const glosses = ['house', 'road', 'time', 'power', 'light', 'ground', 'glance', 'stone', 'field', 'book'];
    const payloads = [];
    for (let i = 0; i < count; ++i) {
        const word = words[i % words.length];
        const gloss = glosses[(i * 7) % glosses.length];
        payloads.push([
            i % 3 === 0 ? 'n' : 'vt',
            i % 2 === 0 ? 'v5r' : '',
            (i % 200) - 100,
            [{type: 'structured-content',
                content: [
                    {tag: 'div', data: {content: 'glossary'}, content: `${gloss} ${i}: ${word}${i % 13}`},
                    {tag: 'ul', content: [{tag: 'li', content: `${word} ${gloss} beispiel ${i % 29}`}]},
                ]}],
            i % 5 === 0 ? 'common' : '',
        ]);
    }
    return payloads;
}

describe('ZstdPayloadCodec', () => {
    /** @type {ZstdPayloadCodec} */
    let codec;
    beforeAll(async () => {
        codec = await createCodec();
    });

    test('name is zstd', () => {
        expect(codec.name).toBe('zstd');
    });

    test('throws a clear error if used before prepare', async () => {
        const unprepared = new ZstdPayloadCodec(await loadZstdInitModule());
        expect(() => unprepared.encode(samplePayloads[0], null)).toThrow(/not prepared/);
    });

    test('prepare is idempotent', async () => {
        await codec.prepare();
        await codec.prepare();
        expect(codec.encode(samplePayloads[0], null)).toBeInstanceOf(Uint8Array);
    });

    test('round-trips every payload shape without a dictionary', () => {
        for (const payload of samplePayloads) {
            const blob = codec.encode(payload, null);
            expect(blob).toBeInstanceOf(Uint8Array);
            expect(codec.decode(blob, null)).toStrictEqual(jsonNormalized(payload));
        }
    });

    test('round-trips every payload shape with a trained dictionary', async () => {
        const dictionary = await codec.train(trainingCorpus(2000));
        expect(dictionary.length).toBeGreaterThan(0);
        for (const payload of samplePayloads) {
            const blob = codec.encode(payload, dictionary);
            expect(codec.decode(blob, dictionary)).toStrictEqual(jsonNormalized(payload));
        }
    });

    test('train produces a dictionary within the requested capacity', async () => {
        const small = await createCodec({dictionaryCapacity: 4096});
        const dictionary = await small.train(trainingCorpus(2000));
        expect(dictionary.length).toBeGreaterThan(0);
        expect(dictionary.length).toBeLessThanOrEqual(4096);
    });

    test('train returns an empty dictionary when the corpus is too small to train on', async () => {
        // ZDICT legitimately refuses corpora this small. The backend maps empty to "no dictionary",
        // so such a dictionary is simply stored uncompressed-by-dictionary rather than failing.
        const dictionary = await codec.train(samplePayloads.slice(0, 2));
        expect(dictionary).toBeInstanceOf(Uint8Array);
        expect(dictionary.length).toBe(0);
    });

    test('train on an empty sample set returns an empty dictionary', async () => {
        expect((await codec.train([])).length).toBe(0);
    });

    test('a trained dictionary beats no dictionary on small rows', async () => {
        const corpus = trainingCorpus(2000);
        const dictionary = await codec.train(corpus);
        const sample = corpus[0];
        const withDictionary = codec.encode(sample, dictionary).length;
        const withoutDictionary = codec.encode(sample, null).length;
        expect(withDictionary).toBeLessThan(withoutDictionary);
    });

    test('compresses relative to the identity codec', () => {
        const identity = new IdentityPayloadCodec();
        const payload = [null, '', 0, Array.from({length: 40}, (_v, i) => ({type: 'structured-content', content: [{tag: 'div', content: `entry ${i} common repeated text`}]})), null];
        expect(codec.encode(payload, null).length).toBeLessThan(identity.encode(payload, null).length);
    });

    test('decode rejects a blob that is not a zstd frame', () => {
        expect(() => codec.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), null)).toThrow();
    });

    test('dictionary handles are reused across calls for the same dictionary instance', async () => {
        // The backend hands back the same Uint8Array instance per dictionary; encoding many rows
        // must not rebuild the CDict each time. Exercised for correctness under repetition here --
        // a rebuild-per-row would still be correct, just slow, so this guards the round-trip.
        const dictionary = await codec.train(trainingCorpus(2000));
        for (const payload of trainingCorpus(50)) {
            expect(codec.decode(codec.encode(payload, dictionary), dictionary)).toStrictEqual(jsonNormalized(payload));
        }
    });
});
