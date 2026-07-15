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

import {readFileSync} from 'fs';
import {fileURLToPath} from 'node:url';
import path from 'path';
import {describe, expect, test} from 'vitest';
import {parseJson} from '../dev/json.js';
import {createTranslatorContext} from './fixtures/translator-test.js';
import {setupStubs} from './utilities/database.js';
import {createFindKanjiOptions, createFindTermsOptions} from './utilities/translator.js';

// End-to-end parity: run the same translator fixtures used by dictionary-data.test.js through the
// full pipeline (real DictionaryImporter + Translator) but backed by the SQLite-WASM backend, and
// assert the resulting dictionaryEntries match the canonical expected results the IndexedDB backend
// produces. This exercises the whole DictionaryDatabaseSqlite surface (import of every store, plus
// findTerms/findKanji/meta/tag/media reads) against real dictionary data.
//
// Runs in the plain node environment (no jsdom): the DOM is only needed by the anki-note/render
// assertions in dictionary-data.test.js, not by findTerms/findKanji, and vitest's jsdom setup swaps
// the global typed-array constructors mid-test, which breaks sqlite-wasm's WASM heap views.

setupStubs();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dictionaryName = 'Test Dictionary 2';
const {translator} = await createTranslatorContext(path.join(dirname, 'data/dictionaries/valid-dictionary1'), dictionaryName, 'sqlite');

describe('Dictionary data (SQLite backend)', () => {
    const testInputsFilePath = path.join(dirname, 'data/translator-test-inputs.json');
    /** @type {import('test/translator').TranslatorTestInputs} */
    const {optionsPresets, tests} = parseJson(readFileSync(testInputsFilePath, {encoding: 'utf8'}));

    const testResults1FilePath = path.join(dirname, 'data/translator-test-results.json');
    /** @type {import('test/translator').TranslatorTestResults} */
    const expectedResults1 = parseJson(readFileSync(testResults1FilePath, {encoding: 'utf8'}));

    const testCases = tests.map((data, i) => ({data, expected1: expectedResults1[i]}));

    describe.each(testCases)('Test %#: $data.name', ({data, expected1}) => {
        test('Test', async () => {
            switch (data.func) {
                case 'findTerms':
                    {
                        const {mode, text} = data;
                        const options = createFindTermsOptions(dictionaryName, optionsPresets, data.options);
                        const {dictionaryEntries, originalTextLength} = await translator.findTerms(mode, text, options);
                        expect.soft(originalTextLength).toStrictEqual(expected1.originalTextLength);
                        expect.soft(dictionaryEntries).toStrictEqual(expected1.dictionaryEntries);
                    }
                    break;
                case 'findKanji':
                    {
                        const {text} = data;
                        const options = createFindKanjiOptions(dictionaryName, optionsPresets, data.options);
                        const dictionaryEntries = await translator.findKanji(text, options);
                        expect.soft(dictionaryEntries).toStrictEqual(expected1.dictionaryEntries);
                    }
                    break;
            }
        });
    });
});
