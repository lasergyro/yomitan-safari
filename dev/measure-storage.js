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
 * Measures dictionary storage against the **real** `kty-de-en`, the dictionary the whole storage
 * refactor is sized around. The unit tests can only use the tiny fixture dictionary, and synthetic
 * corpora predict real ratios badly, so this is the only honest source of numbers. It is also what
 * found the 75 ms full table scan on every lookup (see plan/history/README.md → "Query plans").
 *
 * Usage:
 *   npm run measure:storage                 # payload codec ratios + decode cost
 *   npm run measure:storage -- --db         # ...and import into SQLite for a real total DB size
 *   npm run measure:storage -- --rows=50000 # cap rows (a fast smoke run)
 *
 * The dictionary (~24 MB) is downloaded on first use into `dictionaries/` (gitignored) and cached.
 *
 * Results and their interpretation live in plan/history/zstd.md; the headline is that ~78 MB of the
 * ~150 MB database is indexes, which no codec touches — so that, not compression, is where the
 * remaining weight now is.
 *
 * `--train=N` models buffering N rows before training the preset dictionary. deflate's dictionary is
 * capped at 32 KB (DEFLATE's window), so raising it past a few thousand rows changes nothing; the
 * knob is kept because it mattered for the zstd evaluation and would matter again for any codec with
 * a larger dictionary.
 */

import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseJson} from './json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..');
const dictionaryDir = path.join(repoRoot, 'dictionaries');
const archivePath = path.join(dictionaryDir, 'kty-de-en.zip');

const DICTIONARY_URL = 'https://github.com/yomidevs/wiktionary-to-yomitan/releases/download/v2025-04-08-10-54-36-00-00/kty-de-en.zip';
/** sha256 of the release asset, so a cached or re-downloaded copy is always the same data. */
const DICTIONARY_SHA256 = '787c7062e7f58223cbbf18510d8f83e4f8c11b2321ff10db030fb39d6badae16';

/**
 * Default trained-dictionary sample size: the importer's `maxTransactionLength`, which is all the
 * rows the real import can offer the trainer today (training happens on the first `bulkAdd` batch).
 * `--train=N` raises it to model buffering more of the import first.
 */
const DEFAULT_TRAIN_SAMPLE_SIZE = 1000;

/** Decode every Nth row rather than all of them; decode timing needs a sample, not the corpus. */
const DECODE_SAMPLE_EVERY = 20;

/** `DictionaryImporter.maxTransactionLength` — mirrored so training sees what production sees. */
const IMPORTER_BATCH_SIZE = 1000;

/** How many real lookups to time for the per-query cost. */
const QUERY_PROBE_COUNT = 200;

const encoder = new TextEncoder();

/**
 * @param {number} bytes
 * @returns {string}
 */
function mb(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * @param {string} message
 */
function log(message) {
    process.stdout.write(`${message}\n`);
}

/**
 * Downloads the dictionary if it is not already cached, and verifies its checksum either way.
 * @returns {Promise<void>}
 */
async function ensureDictionary() {
    if (!fs.existsSync(archivePath)) {
        log(`==> downloading kty-de-en (~24 MB) to ${path.relative(repoRoot, archivePath)}`);
        fs.mkdirSync(dictionaryDir, {recursive: true});
        const response = await fetch(DICTIONARY_URL);
        if (!response.ok) { throw new Error(`Download failed: ${response.status} ${response.statusText}`); }
        fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    }
    const {createHash} = await import('crypto');
    const actual = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (actual !== DICTIONARY_SHA256) {
        throw new Error(`Checksum mismatch for ${archivePath}\n  expected ${DICTIONARY_SHA256}\n  actual   ${actual}`);
    }
}

/**
 * Yields every term row, bank by bank, so the whole 626 MB of JSON is never resident at once. Rows
 * carry the real `expression`/`reading`/`sequence` as well as the payload, because the database
 * measurement needs genuine index content — synthetic keys would misreport the index size, which is
 * a large part of the answer.
 *
 * The payload shape is exactly `DictionaryImporter._packTermEntry`'s
 * `m: [definitionTags, rules, score, glossary, termTags]`.
 * @param {number} rowLimit
 * @yields {{expression: string, reading: string, sequence: number, m: unknown[]}[]} One bank's rows.
 * @returns {AsyncGenerator<{expression: string, reading: string, sequence: number, m: unknown[]}[]>}
 */
async function *readTermBanks(rowLimit) {
    const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
    const bankNames = Object.keys(zip.files)
        .filter((name) => /^term_bank_\d+\.json$/.test(name))
        .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
    let emitted = 0;
    for (const name of bankNames) {
        const file = zip.file(name);
        if (file === null) { continue; }
        /** @type {unknown[][]} */
        const bank = parseJson(await file.async('string'));
        /** @type {{expression: string, reading: string, sequence: number, m: unknown[]}[]} */
        const rows = [];
        for (const entry of bank) {
            // [expression, reading, definitionTags, rules, score, glossary, sequence, termTags]
            rows.push({
                expression: /** @type {string} */ (entry[0]),
                reading: /** @type {string} */ (entry[1]),
                sequence: typeof entry[6] === 'number' ? entry[6] : 0,
                m: [entry[2], entry[3], entry[4], entry[5], entry[7]],
            });
            if (++emitted >= rowLimit) { break; }
        }
        yield rows;
        if (emitted >= rowLimit) { return; }
    }
}

/**
 * Measures every codec in a **single** pass over the archive: re-reading it per codec would parse
 * 626 MB of JSON once per codec for no benefit. Rows are encoded codec-by-codec within each bank so
 * each codec's time is still measured over a contiguous run.
 * @param {{codec: import('payload-codec').PayloadCodec, label: string}[]} entries
 * @param {unknown[][]} trainSamples
 * @param {number} rowLimit
 * @returns {Promise<{label: string, bytes: number, ms: number, dictBytes: number, trainMs: number, decodeMs: number, decodeRows: number}[]>}
 */
async function measureCodecs(entries, trainSamples, rowLimit) {
    const prepared = [];
    for (const {codec, label} of entries) {
        if (typeof codec.prepare === 'function') { await codec.prepare(); }
        const trainStart = Date.now();
        const trained = await codec.train(trainSamples);
        prepared.push({
            codec,
            label,
            dictionary: trained.length > 0 ? trained : null,
            dictBytes: trained.length,
            trainMs: Date.now() - trainStart,
            bytes: 0,
            ms: 0,
            decodeMs: 0,
            decodeRows: 0,
        });
    }
    for await (const rows of readTermBanks(rowLimit)) {
        const payloads = rows.map((row) => row.m);
        for (const entry of prepared) {
            const start = Date.now();
            let bytes = 0;
            for (const payload of payloads) { bytes += entry.codec.encode(payload, entry.dictionary).length; }
            entry.bytes += bytes;
            entry.ms += Date.now() - start;

            // Decode is what a *lookup* pays, so measure it too: a codec that saves storage but
            // slows every query down is a bad trade. Sampled rather than run over every row, since
            // decoding the whole corpus per codec would dominate the run for no extra signal.
            const sample = payloads.filter((_payload, i) => i % DECODE_SAMPLE_EVERY === 0);
            const blobs = sample.map((payload) => entry.codec.encode(payload, entry.dictionary));
            const decodeStart = Date.now();
            for (const blob of blobs) { entry.codec.decode(blob, entry.dictionary); }
            entry.decodeMs += Date.now() - decodeStart;
            entry.decodeRows += blobs.length;
        }
    }
    return prepared;
}

/**
 * Imports every term through the real backend and reports the resulting database size, which is the
 * number the ~100 MB target is actually about — payload compression alone ignores the indexes.
 * @param {import('payload-codec').PayloadCodec} codec
 * @param {string} label
 * @param {number} rowLimit
 * @param {number} trainSampleSize
 * @returns {Promise<void>}
 */
async function measureDatabase(codec, label, rowLimit, trainSampleSize) {
    const {default: sqlite3InitModule} = await import('@sqlite.org/sqlite-wasm');
    const {DictionaryDatabaseSqlite} = await import('../ext/js/dictionary/sqlite/dictionary-database-sqlite.js');
    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
    const backend = new DictionaryDatabaseSqlite(codec, [], {trainSampleSize});
    await backend.prepare({sqlite3, vfs: 'memory'});

    const title = 'kty-de-en';
    /** @type {import('dictionary-importer').Summary} */
    const summary = {title, revision: 'r1', sequenced: false, version: 3, importDate: 0, prefixWildcardsSupported: false, styles: ''};
    await backend.bulkAdd('dictionaries', [summary], 0, 1);

    const start = Date.now();
    let rows = 0;
    /** @type {string[]} */
    const probeTerms = [];
    for await (const bank of readTermBanks(rowLimit)) {
        /** @type {import('dictionary-database').DatabaseTermEntryPacked[]} */
        const items = bank.map((row) => ({
            expression: row.expression,
            reading: row.reading,
            dictionary: title,
            sequence: row.sequence,
            m: /** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (row.m),
        }));
        // Import in the importer's own batch size, so training sees exactly what it sees in
        // production (it trains on the first batch).
        for (let i = 0; i < items.length; i += IMPORTER_BATCH_SIZE) {
            await backend.bulkAdd('terms', items, i, Math.min(IMPORTER_BATCH_SIZE, items.length - i));
        }
        if (probeTerms.length < QUERY_PROBE_COUNT) { probeTerms.push(items[0].expression, items[items.length >> 1].expression); }
        rows += items.length;
        process.stdout.write(`\r    ${label}: imported ${rows} rows…`);
    }
    await backend.finalizeImport();

    const internal = /** @type {{_require: () => {selectValue: (sql: string) => unknown}}} */ (/** @type {unknown} */ (backend));
    // eslint-disable-next-line no-underscore-dangle
    const db = internal._require();
    const dbBytes = Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'));
    const payloadBytes = Number(db.selectValue('SELECT sum(length(payload)) FROM terms'));
    const dictBytes = Number(db.selectValue('SELECT coalesce(sum(length(codec_dict)), 0) FROM dictionaries'));

    // A real lookup: findTermsBulk over the enabled dictionaries, decoding each matching row. Warmed
    // up first so statement preparation and page-cache warming don't land on the first probe.
    const dictionaries = new Set([title]);
    for (const term of probeTerms.slice(0, 10)) { await backend.findTermsBulk([term], dictionaries, 'exact'); }
    const queryStart = Date.now();
    let decoded = 0;
    for (const term of probeTerms) { decoded += (await backend.findTermsBulk([term], dictionaries, 'exact')).length; }
    const queryMs = (Date.now() - queryStart) / probeTerms.length;

    process.stdout.write('\r');
    log(
        `    ${label}: DB ${mb(dbBytes).padStart(9)} = payload ${mb(payloadBytes).padStart(9)} + dict ` +
        `${mb(dictBytes).padStart(8)} + rest ${mb(dbBytes - payloadBytes - dictBytes).padStart(9)} | ` +
        `${rows} rows, import ${((Date.now() - start) / 1000).toFixed(0)}s | lookup ${queryMs.toFixed(2)} ms ` +
        `(${(decoded / probeTerms.length).toFixed(1)} rows/lookup) | wasm heap ${mb(wasmHeapBytes(codec))}`,
    );
    backend.close();
}

/**
 * Resident size of a codec's WASM linear memory, which is the bulk of what a compressing codec costs
 * in RAM while the extension is idle: the module itself plus the compiled dictionary handles.
 * Returns 0 for codecs with no WASM behind them.
 * @param {import('payload-codec').PayloadCodec} codec
 * @returns {number}
 */
function wasmHeapBytes(codec) {
    // Reaches into the codec's private module deliberately: exposing a heap-size accessor on the
    // production API purely so a measurement script can read it would be the worse trade.
    // eslint-disable-next-line no-underscore-dangle
    const module = /** @type {{_module?: {HEAPU8?: Uint8Array}}} */ (/** @type {unknown} */ (codec))._module;
    return module?.HEAPU8?.byteLength ?? 0;
}

/** Entry point. */
async function main() {
    const args = process.argv.slice(2);
    /**
     * @param {string} name
     * @param {number} fallback
     * @returns {number}
     */
    const numberArg = (name, fallback) => {
        const arg = args.find((a) => a.startsWith(`--${name}=`));
        return typeof arg === 'string' ? Number.parseInt(arg.slice(name.length + 3), 10) : fallback;
    };
    const rowLimit = numberArg('rows', Number.POSITIVE_INFINITY);
    const trainSampleSize = numberArg('train', DEFAULT_TRAIN_SAMPLE_SIZE);
    const withDatabase = args.includes('--db');

    await ensureDictionary();

    const [{IdentityPayloadCodec}, {DeflatePayloadCodec}, pakoModule] = await Promise.all([
        import('../ext/js/dictionary/payload-codec.js'),
        import('../ext/js/dictionary/deflate-payload-codec.js'),
        import('pako'),
    ]);
    // pako is CJS: under a dynamic import node puts its exports on `.default`, where the tests' static
    // `import * as pako` sees them as named exports.
    const pako = /** @type {import('pako')} */ (pakoModule.default ?? pakoModule);

    log('==> reading term payloads');
    /** @type {unknown[][]} */
    const trainSamples = [];
    let rawBytes = 0;
    let rowCount = 0;
    for await (const rows of readTermBanks(rowLimit)) {
        const payloads = rows.map((row) => row.m);
        for (const payload of payloads) {
            rawBytes += encoder.encode(JSON.stringify(payload)).length;
            // The real import trains on the first batch it sees, so sample the same way rather than
            // sampling across the whole corpus — which would measure a dictionary we never build.
            if (trainSamples.length < trainSampleSize) { trainSamples.push(payload); }
        }
        rowCount += payloads.length;
        process.stdout.write(`\r    ${rowCount} rows, ${mb(rawBytes)} of payload…`);
    }
    process.stdout.write('\r');
    log(`    ${rowCount} term rows; payload ${mb(rawBytes)} of compact JSON (avg ${(rawBytes / rowCount).toFixed(0)} B/row)`);

    /** @type {{codec: import('payload-codec').PayloadCodec, label: string}[]} */
    const codecs = [
        {codec: new IdentityPayloadCodec(), label: 'identity (JSON)'},
        {codec: new DeflatePayloadCodec(pako), label: 'deflate + 32 KB dict'},
    ];

    log(`\n==> payload codecs (single pass; ${trainSamples.length} training samples)`);
    const results = await measureCodecs(codecs, trainSamples, rowLimit);
    log('    codec                     payload      ratio    encode    decode      dict   train');
    for (const {label, bytes, ms, decodeMs, decodeRows, dictBytes, trainMs} of results) {
        const ratio = rawBytes / bytes;
        const rate = (rawBytes / 1e6) / (ms / 1000);
        // Per-row decode latency is the number that matters for a lookup: a query decodes a handful
        // of rows, so throughput hides the per-call cost of a big dictionary.
        const perRowUs = (decodeMs * 1000) / decodeRows;
        log(
            `    ${label.padEnd(24)} ${mb(bytes).padStart(9)} ${`${ratio.toFixed(2)}x`.padStart(8)} ` +
            `${`${rate.toFixed(0)} MB/s`.padStart(9)} ${`${perRowUs.toFixed(1)} µs/row`.padStart(11)} ` +
            `${(dictBytes > 0 ? `${(dictBytes / 1024).toFixed(0)} KB` : '—').padStart(8)} ${`${(trainMs / 1000).toFixed(1)}s`.padStart(7)}`,
        );
    }

    if (withDatabase) {
        log('\n==> full SQLite import (real DB size, indexes included)');
        await measureDatabase(new IdentityPayloadCodec(), 'identity', rowLimit, trainSampleSize);
        await measureDatabase(new DeflatePayloadCodec(pako), 'deflate ', rowLimit, trainSampleSize);
    } else {
        log('\n(pass --db to also import into SQLite and measure the real database size)');
    }
}

await main();
