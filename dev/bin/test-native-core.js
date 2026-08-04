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
 * The JavaScriptCore equivalence gate (plan/native-rewrite.md → Testing, layer 2).
 *
 * vitest proves the engine is correct in node. It cannot prove any of the things that only go wrong
 * once the engine is hosted natively:
 *
 * - that the **bundled** engine evaluates at all in JavaScriptCore (no module loader, no DOM),
 * - that every platform shim it reaches for is actually installed,
 * - that the **Swift SQLite binding** returns what the WASM one returned — in particular that BLOBs
 *   survive as `Uint8Array` and integers do not arrive as REAL,
 * - that the compiled-at-build-time database is readable by the shipping code path.
 *
 * So this runs the same requests twice — once through `NativeCore` in node over SQLite-WASM, once
 * through the real Swift host over system libsqlite3 — and requires the answers to be identical.
 * A divergence here is the difference between "works on my machine" and "works in the app".
 *
 * Everything it needs is built on demand, so `npm run test:jsc` is the whole command.
 */

import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {createDictionaryArchiveData} from '../dictionary-archive-util.js';
import {parseJson} from '../json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..', '..');
const buildDir = path.join(repoRoot, 'builds/native');
const bundlePath = path.join(repoRoot, 'native/Resources/yomitan-core.js');
const harnessPath = path.join(buildDir, 'jsc-harness');
const fixtureDirectory = path.join(repoRoot, 'test/data/dictionaries/valid-dictionary1');
const fixtureTitle = 'Test Dictionary 2';

/**
 * The requests both hosts must answer identically.
 *
 * Chosen to cover each distinct marshalling path rather than each action: a compressed payload BLOB
 * (`findTermsBulk`), an integer key that must not become a float (`findTermsBySequenceBulk`), a JSON
 * text column (`findTermMetaBulk`), a base64 round trip of real binary (`getMedia`), and a query
 * that must return nothing rather than everything when the dictionary set is empty.
 * @type {import('native-bridge').NativeRequest[]}
 */
/**
 * A minimal Japanese `LanguageSummary`; the jpod101 audio handler only reads a couple of fields, but
 * the whole object crosses the bridge, so it is spelled out rather than faked as `{}`.
 * @type {import('language').LanguageSummary}
 */
const JAPANESE_SUMMARY = {name: 'Japanese', iso: 'ja', iso639_3: 'jpn', exampleText: ''};

/**
 * The `host.fetch` fixture: every URL the audio requests reach, mapped to a canned response, so
 * `getTermAudioInfoList`/`downloadTermAudio` run identically in both hosts without the network. The
 * one entry is the jpod101 audio URL `getTermAudioInfoList` produces for 打つ/うつ; its body is
 * arbitrary bytes that must survive base64 both ways.
 * @type {{[url: string]: {status?: number, headers?: {[key: string]: string}, body?: string, bodyBase64?: string}}}
 */
const FETCH_FIXTURE = {
    'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=%E6%89%93%E3%81%A4&kana=%E3%81%86%E3%81%A4': {
        status: 200,
        headers: {'Content-Type': 'audio/mpeg'},
        bodyBase64: Buffer.from('FAKE-MP3-AUDIO-BYTES').toString('base64'),
    },
};

const REQUESTS = [
    {action: 'prepare', params: {}},
    {action: 'getDictionaryInfo', params: {}},
    {action: 'dictionaryExists', params: {title: fixtureTitle}},
    {action: 'getDictionaryCounts', params: {dictionaryNames: [fixtureTitle], getTotal: true}},
    {action: 'findTermsBulk', params: {termList: ['打つ'], dictionaries: [fixtureTitle], matchType: 'exact'}},
    {action: 'findTermsBulk', params: {termList: ['打つ'], dictionaries: [], matchType: 'exact'}},
    {action: 'findTermsExactBulk', params: {termList: [{term: '打つ', reading: 'うつ'}], dictionaries: [fixtureTitle]}},
    {action: 'findTermsBySequenceBulk', params: {items: [{query: 3, dictionary: fixtureTitle}]}},
    {action: 'findTermMetaBulk', params: {termList: ['打つ'], dictionaries: [fixtureTitle]}},
    {action: 'findKanjiBulk', params: {kanjiList: ['打'], dictionaries: [fixtureTitle]}},
    {action: 'findKanjiMetaBulk', params: {kanjiList: ['打'], dictionaries: [fixtureTitle]}},
    {action: 'findTagMetaBulk', params: {items: [{query: 'E1', dictionary: fixtureTitle}]}},
    {action: 'findTagForTitle', params: {name: 'E1', dictionary: fixtureTitle}},
    {action: 'getMedia', params: {items: [{path: 'img.png', dictionary: fixtureTitle}]}},
    // The translator, which is the whole of stage N3: deinflection, result assembly and every query
    // it issues run inside the engine. This is also the single richest result shape on the bridge,
    // so it is the best check that the JSON envelope survives real data.
    {action: 'termsFind', params: {mode: 'group', text: '打つ', options: createFindTermsOptions()}},
    {action: 'termsFind', params: {mode: 'split', text: '打った', options: createFindTermsOptions()}},
    {action: 'termsFind', params: {mode: 'simple', text: 'ありません', options: createFindTermsOptions()}},
    {action: 'kanjiFind', params: {text: '打', options: createFindKanjiOptions()}},
    {action: 'getTermFrequencies', params: {termReadingList: [{term: '打つ', reading: null}], dictionaries: [fixtureTitle]}},
    {action: 'clearDatabaseCaches', params: {}},
    // Audio moved native in stage N4. These exercise the whole seam the move introduced: the
    // URLSearchParams shim (getTermAudioInfoList builds a query with no network), then the native
    // fetch, the fetch-Response shim, `crypto.subtle.digest` and `btoa` (downloadTermAudio pulls the
    // bytes). node answers with its *real* URL/crypto/base64, the JSC host with the shims, so a
    // divergence in any shim shows up here. Both read the same fetch fixture, so nothing hits the
    // network.
    {action: 'getTermAudioInfoList', params: {source: {type: 'jpod101', url: '', voice: ''}, term: '打つ', reading: 'うつ', languageSummary: JAPANESE_SUMMARY}},
    {action: 'downloadTermAudio', params: {sources: [{type: 'jpod101', url: '', voice: ''}], preferredAudioIndex: null, term: '打つ', reading: 'うつ', idleTimeout: null, languageSummary: JAPANESE_SUMMARY, enableDefaultAudioSources: false}},
    // Playback fetch: the display plays these bytes from a blob URL because the in-page overlay
    // cannot load the remote URL directly under Safari. Reads the same fetch fixture, so node's real
    // fetch and the JSC host's shimmed one must return identical bytes and content type.
    {action: 'getAudioUrlBytes', params: {url: 'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=%E6%89%93%E3%81%A4&kana=%E3%81%86%E3%81%A4'}},
    {action: 'noSuchAction', params: {}},
];

/**
 * A realistic term-lookup options object, already transport-encoded.
 *
 * Written out rather than defaulted because the three fields that cannot survive `JSON.stringify` —
 * the dictionary `Map`, the exclusion `Set` and the `RegExp`s in `textReplacements` — are exactly
 * the ones a test would omit, and omitting them is silent: the lookup returns nothing rather than
 * failing. `textReplacements` carries a real pattern so the rebuild-on-the-far-side path is
 * exercised too.
 * @returns {import('native-bridge').EncodedFindTermsOptions}
 */
function createFindTermsOptions() {
    return {
        matchType: 'exact',
        deinflect: true,
        primaryReading: '',
        mainDictionary: fixtureTitle,
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'ascending',
        removeNonJapaneseCharacters: false,
        textReplacements: [null, [{pattern: '\\s+', flags: 'g', replacement: ''}]],
        enabledDictionaryMap: [[fixtureTitle, {index: 0, alias: fixtureTitle, allowSecondarySearches: false, partsOfSpeechFilter: true, useDeinflections: true}]],
        excludeDictionaryDefinitions: null,
        searchResolution: 'letter',
        language: 'ja',
    };
}

/**
 * @returns {import('native-bridge').EncodedFindKanjiOptions}
 */
function createFindKanjiOptions() {
    return {
        enabledDictionaryMap: [[fixtureTitle, {index: 0, alias: fixtureTitle}]],
        removeNonJapaneseCharacters: false,
    };
}

/**
 * The node side of `host.fetch`: the same lookup the Swift fixture fetcher does, over the same
 * `FETCH_FIXTURE`. A missing URL is a 404 rather than a throw, matching the harness.
 * @param {string} url
 * @returns {{status: number, url: string, headers: {[key: string]: string}, bodyBase64: string}}
 */
function fetchFromFixture(url) {
    const entry = FETCH_FIXTURE[url];
    if (typeof entry === 'undefined') {
        return {status: 404, url, headers: {}, bodyBase64: ''};
    }
    let bodyBase64 = '';
    if (typeof entry.bodyBase64 === 'string') {
        bodyBase64 = entry.bodyBase64;
    } else if (typeof entry.body === 'string') {
        bodyBase64 = Buffer.from(entry.body, 'utf8').toString('base64');
    }
    return {status: entry.status ?? 200, url, headers: entry.headers ?? {}, bodyBase64};
}

/**
 * @param {string} message
 * @returns {void}
 */
function log(message) {
    process.stdout.write(`${message}\n`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function run(command, args) {
    return execFileSync(command, args, {cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
}

/**
 * Compiles the fixture dictionary to a real `.sqlite3`, through the same script the app's
 * dictionaries are built with.
 * @param {string} workingDirectory
 * @returns {Promise<string>}
 */
async function compileFixtureDatabase(workingDirectory) {
    const archivePath = path.join(workingDirectory, 'fixture.zip');
    const databasePath = path.join(workingDirectory, 'fixture.sqlite3');
    const archive = await createDictionaryArchiveData(fixtureDirectory, fixtureTitle);
    fs.writeFileSync(archivePath, Buffer.from(archive));
    run(process.execPath, [path.join(repoRoot, 'dev/bin/compile-dictionary.js'), archivePath, '--out', databasePath]);
    return databasePath;
}

/**
 * Answers every request through the engine running in node, over SQLite-WASM reading the same file.
 *
 * The database is loaded into the WASM build with `sqlite3_js_posix_create_file` so that both sides
 * genuinely read the *same compiled bytes*; importing the fixture separately here would compare two
 * imports rather than two hosts, and would hide exactly the class of bug this exists to catch.
 * @param {string} databasePath
 * @returns {Promise<string[]>}
 */
async function answerInNode(databasePath) {
    const {default: sqlite3InitModule} = await import('@sqlite.org/sqlite-wasm');
    const {NativeCore} = await import('../../ext/js/native/native-core.js');
    const pakoNamespace = await import('pako');
    const pako = typeof (/** @type {{deflateRaw?: unknown}} */ (pakoNamespace)).deflateRaw === 'function' ? pakoNamespace : pakoNamespace.default;

    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module & {capi: {sqlite3_js_posix_create_file: (name: string, bytes: Uint8Array) => void}}} */ (
        /** @type {unknown} */ (await sqlite3InitModule())
    );
    const virtualPath = '/fixture.sqlite3';
    sqlite3.capi.sqlite3_js_posix_create_file(virtualPath, new Uint8Array(fs.readFileSync(databasePath)));

    const {createHash} = await import('node:crypto');
    /** @type {import('native-bridge').NativeHost} */
    const host = {
        openDatabase: (/** @type {string} */ openPath) => new sqlite3.oo1.DB(openPath),
        databasePath: () => virtualPath,
        log: () => {},
        now: () => Date.now(),
        // The audio host surface. `fetch` answers from the same fixture the JSC harness reads, so the
        // two hosts see identical bytes; `resolveUrl`/`sha256` mirror what Foundation/CryptoKit do on
        // the Swift side — they are only reached in the JSC host (node uses its real URL/crypto), but
        // are implemented here so the host is complete rather than stubbed.
        fetch: (request) => fetchFromFixture(request.url),
        resolveUrl: (url, base) => {
            try {
                return base ? new URL(url, base).href : new URL(url).href;
            } catch (e) {
                return url;
            }
        },
        sha256: (base64) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64'),
    };
    const core = new NativeCore(host, {pako: /** @type {import('pako')} */ (pako), databasePath: virtualPath});

    /** @type {string[]} */
    const responses = [];
    for (const {action, params} of REQUESTS) {
        try {
            const result = await core.invoke(action, params);
            responses.push(JSON.stringify({result: typeof result === 'undefined' ? null : result}));
        } catch (e) {
            responses.push(JSON.stringify({error: {message: e instanceof Error ? e.message : `${e}`}}));
        }
    }
    return responses;
}

/**
 * Answers every request through the real Swift host, in a real `JSContext`, over system libsqlite3.
 * @param {string} databasePath
 * @param {string} fetchFixturePath The `host.fetch` fixture, so the audio requests hit no network.
 * @returns {string[]}
 */
function answerInJavaScriptCore(databasePath, fetchFixturePath) {
    /** @type {string[]} */
    const args = ['--bundle', bundlePath, '--database', databasePath, '--fetch-fixture', fetchFixturePath];
    for (const request of REQUESTS) {
        args.push('--request', JSON.stringify(request));
    }
    return run(harnessPath, args).split('\n').filter((line) => line.length > 0);
}

/**
 * Only the message is compared for errors: the two hosts legitimately produce different stacks, and
 * requiring those to match would be testing the transport's cosmetics.
 * @param {string} responseJson
 * @returns {unknown}
 */
function normalize(responseJson) {
    const response = /** @type {import('native-bridge').NativeResponse} */ (parseJson(responseJson));
    if (typeof response.error !== 'undefined') {
        return {error: response.error.message};
    }
    return {result: response.result};
}

/**
 * @returns {Promise<void>}
 * @throws {Error} On any divergence between the two hosts.
 */
async function main() {
    fs.mkdirSync(buildDir, {recursive: true});
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-jsc-'));
    try {
        log('==> building the engine bundle');
        run(process.execPath, [path.join(repoRoot, 'dev/bin/build-native-core.js')]);

        log('==> building the JavaScriptCore harness');
        run('swiftc', [
            '-O',
            '-o',
            harnessPath,
            path.join(repoRoot, 'native/Tools/jsc-harness/main.swift'),
            path.join(repoRoot, 'native/Sources/YomitanNative/SqliteBridge.swift'),
            path.join(repoRoot, 'native/Sources/YomitanNative/NativeEngineHost.swift'),
        ]);

        log('==> compiling the fixture dictionary');
        const databasePath = await compileFixtureDatabase(workingDirectory);

        const fetchFixturePath = path.join(workingDirectory, 'fetch-fixture.json');
        fs.writeFileSync(fetchFixturePath, JSON.stringify(FETCH_FIXTURE));

        log('==> answering in node (SQLite-WASM) and in JavaScriptCore (libsqlite3)');
        const nodeResponses = await answerInNode(databasePath);
        const jscResponses = answerInJavaScriptCore(databasePath, fetchFixturePath);

        if (nodeResponses.length !== jscResponses.length) {
            throw new Error(`Response count differs: node ${nodeResponses.length}, JavaScriptCore ${jscResponses.length}`);
        }

        /** @type {string[]} */
        const failures = [];
        for (let i = 0; i < REQUESTS.length; ++i) {
            const expected = JSON.stringify(normalize(nodeResponses[i]));
            const actual = JSON.stringify(normalize(jscResponses[i]));
            const label = REQUESTS[i].action;
            if (expected === actual) {
                log(`    ok   ${label}`);
            } else {
                log(`    FAIL ${label}`);
                failures.push(`${label}\n      node: ${expected}\n      jsc:  ${actual}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(`The native host diverged from node on ${failures.length} request(s):\n  ${failures.join('\n  ')}`);
        }
        log(`==> ${REQUESTS.length}/${REQUESTS.length} identical`);
    } finally {
        fs.rmSync(workingDirectory, {recursive: true, force: true});
    }
}

await main();
