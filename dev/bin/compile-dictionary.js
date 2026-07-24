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
 * Compiles Yomitan dictionary archives into the finished `.sqlite3` the native app installs
 * (plan/native-rewrite.md → The dictionary pipeline).
 *
 * This is the step that removes the most complexity from the extension. Importing in the browser
 * meant an importer, an import worker, a trained-codec handshake, a single-connection handoff and
 * ~152 seconds of pako per dictionary — all of it repeated on every machine. Doing it once, here,
 * turns installation into a file copy.
 *
 * It is not a reimplementation: it drives the **real** `DictionaryImporter` against the **real**
 * `DictionaryDatabaseSqlite`, so what it emits is what the tests cover. The only thing that differs
 * from a browser import is where the bytes end up.
 *
 * Usage:
 *   node dev/bin/compile-dictionary.js <dictionary.zip>... [--out <file.sqlite3>]
 *   node dev/bin/compile-dictionary.js kty-de-en.zip jmdict.zip --out dictionaries.sqlite3
 *
 * Several archives may be given; they are imported into one database, exactly as enabling several
 * dictionaries in the extension would produce.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import fs from 'fs';
import * as pakoNamespace from 'pako';
import path from 'path';
import {fileURLToPath} from 'url';
import {DeflatePayloadCodec} from '../../ext/js/dictionary/deflate-payload-codec.js';
import {DictionaryImporter} from '../../ext/js/dictionary/dictionary-importer.js';
import {DICTIONARY_SQLITE_SCHEMA_VERSION} from '../../ext/js/dictionary/sqlite/dictionary-sqlite-schema.js';
import {DictionaryDatabaseSqlite} from '../../ext/js/dictionary/sqlite/dictionary-database-sqlite.js';

// pako is CommonJS. Under a plain node ESM import its functions can land on `.default` rather than
// as named exports (which is exactly how the first run of this script failed, with
// `deflateRaw is not a function` reported once per bank and an *identity*-encoded database written
// anyway). Normalizing here rather than at the call site keeps the failure impossible to repeat.
const pako = /** @type {import('pako')} */ (
    typeof (/** @type {{deflateRaw?: unknown}} */ (pakoNamespace)).deflateRaw === 'function' ?
        pakoNamespace :
        /** @type {{default: import('pako')}} */ (/** @type {unknown} */ (pakoNamespace)).default
);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..', '..');

/**
 * @param {string[]} argv
 * @returns {{archives: string[], outFile: string}}
 * @throws {Error} When no archive is given, or an argument is not recognized.
 */
function parseArguments(argv) {
    /** @type {string[]} */
    const archives = [];
    let outFile = path.join(repoRoot, 'builds/dictionaries.sqlite3');
    for (let i = 0; i < argv.length; ++i) {
        const argument = argv[i];
        switch (argument) {
            case '--out':
            case '-o':
                outFile = path.resolve(argv[++i]);
                break;
            default:
                if (argument.startsWith('-')) { throw new Error(`Unknown argument: ${argument}`); }
                archives.push(path.resolve(argument));
                break;
        }
    }
    if (archives.length === 0) {
        throw new Error('At least one dictionary archive is required');
    }
    return {archives, outFile};
}

/**
 * The importer wants a media loader for the images structured content references. In node there is
 * no canvas, and the app does not need decoded dimensions to store the bytes, so this reports the
 * media as-is rather than pulling in a DOM.
 * @returns {import('dictionary-importer-media-loader').GenericMediaLoader}
 */
function createMediaLoader() {
    return {
        // Width and height are only used by the display to reserve layout space, and node has no
        // canvas to measure with. Refusing to compile a dictionary because an image could not be
        // decoded would be much worse than reporting zero, which the display already treats as
        // "unknown".
        getImageDetails: async (content) => ({content, width: 0, height: 0}),
    };
}

/**
 * @param {string} message
 * @returns {void}
 */
function log(message) {
    process.stdout.write(`${message}\n`);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mb(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * @param {{archives: string[], outFile: string}} options
 * @returns {Promise<void>}
 * @throws {Error} When an archive fails to import; a partially imported database is never written.
 */
async function compile({archives, outFile}) {
    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module} */ (/** @type {unknown} */ (await sqlite3InitModule()));
    // deflate with a per-dictionary trained preset dictionary — the codec the app reads
    // (plan/decisions.md #26). The compiled file is only usable by a build that agrees about this,
    // which is what the `codec` column in the schema records per dictionary.
    const database = new DictionaryDatabaseSqlite(new DeflatePayloadCodec(pako));
    await database.prepare({sqlite3, vfs: 'memory'});

    const importer = new DictionaryImporter(createMediaLoader());
    for (const archive of archives) {
        const started = Date.now();
        log(`==> importing ${path.basename(archive)}`);
        const content = fs.readFileSync(archive);
        const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
        const {errors, result} = await importer.importDictionary(
            /** @type {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
            buffer,
            {prefixWildcardsSupported: true, yomitanVersion: '0.0.0.0'},
        );
        for (const error of errors) { process.stderr.write(`    ${error.message}\n`); }
        if (result === null) {
            throw new Error(`Failed to import ${archive}`);
        }
        log(`    ${result.title} (${result.revision}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    // Induces the inflection rules, drops the derivable form-of rows, then ANALYZE + VACUUM. This is
    // where 90% of the rows go away — it is the single largest size lever in the whole design
    // (plan/design.md → Inflection synthesis), and doing it here means no user ever pays for it.
    log('==> finalizing (inflection synthesis, ANALYZE, VACUUM)');
    const finalizeStarted = Date.now();
    await database.finalizeImport();
    log(`    finalized in ${((Date.now() - finalizeStarted) / 1000).toFixed(1)}s`);

    // The WASM build's `oo1.DB` writes into Emscripten's in-memory filesystem, not the host's, so
    // the finished database is exported as bytes and written here rather than opened at `outFile`.
    const capi = /** @type {{capi: {sqlite3_js_db_export: (db: unknown) => Uint8Array}}} */ (/** @type {unknown} */ (sqlite3)).capi;
    const internal = /** @type {{_require: () => unknown}} */ (/** @type {unknown} */ (database));
    // eslint-disable-next-line no-underscore-dangle
    const bytes = capi.sqlite3_js_db_export(internal._require());
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    fs.writeFileSync(outFile, bytes);
    database.close();

    log(`==> ${path.relative(repoRoot, outFile)}: ${mb(bytes.length)}, schema v${DICTIONARY_SQLITE_SCHEMA_VERSION}`);
}

await compile(parseArguments(process.argv.slice(2)));
