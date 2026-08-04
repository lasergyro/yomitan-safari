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
 * Seeds a dictionary straight into the app-extension container, as if a user had imported and
 * enabled it — a build/dev convenience so a freshly installed extension already has, say, kty-de-en
 * active without a 49 MB import through the settings page every rebuild.
 *
 * It writes the two files the install-and-activate flow would have produced, to the same place that
 * flow writes them (`~/Library/Containers/<bundle-id>/…/Application Support/Yomitan/`):
 *
 * - `dictionaries.sqlite3` — the compiled database. The installer's chunked-and-staged transfer is
 *   for surviving an interrupted stream from the extension; a local file copy needs none of that.
 * - `options.json` — the profile store, with the dictionary added to every profile's enabled list.
 *   `OptionsUtil` produces (or migrates) it exactly as the extension would, so the version and shape
 *   match what the running extension expects to read back.
 *
 * Usage:
 *   node dev/bin/seed-dictionary.js <dictionary.zip|dictionary.sqlite3> [options]
 *     --language <iso>     also set each profile's scanning language (e.g. `de` for kty-de-en)
 *     --bundle-id <id>     appex bundle id (default dev.yomitan.safari.extension)
 *     --container <dir>    write here instead of deriving from the bundle id
 *     --print              print the options.json that would be written; touch nothing
 *
 * Driven by `SEED_DICTIONARY=<path> ./rebuild-safari.sh`; see DEV.md.
 */

import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseJson} from '../json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..', '..');

/**
 * Progress goes to stderr so `--print` can emit the options JSON alone on stdout.
 * @param {string} message
 * @returns {void}
 */
function log(message) {
    process.stderr.write(`${message}\n`);
}

/**
 * @param {string[]} argv
 * @returns {{input: string, language: ?string, bundleId: string, container: ?string, print: boolean}}
 * @throws {Error} On an unknown or missing argument.
 */
function parseArguments(argv) {
    /** @type {?string} */
    let input = null;
    /** @type {?string} */
    let language = null;
    let bundleId = 'dev.yomitan.safari.extension';
    /** @type {?string} */
    let container = null;
    let print = false;
    for (let i = 0; i < argv.length; ++i) {
        const arg = argv[i];
        switch (arg) {
            case '--language': language = argv[++i]; break;
            case '--bundle-id': bundleId = argv[++i]; break;
            case '--container': container = argv[++i]; break;
            case '--print': print = true; break;
            default:
                if (arg.startsWith('--')) { throw new Error(`Unknown argument: ${arg}`); }
                if (input !== null) { throw new Error(`Unexpected extra argument: ${arg}`); }
                input = arg;
        }
    }
    if (input === null) { throw new Error('A dictionary .zip or .sqlite3 is required'); }
    return {input, language, bundleId, container, print};
}

/**
 * Installs the tiny asset surface `OptionsUtil.prepare()` reaches for — it fetches the options schema
 * through `chrome.runtime.getURL` + `fetch`, exactly the shim the options unit tests use, here reading
 * the file straight off disk.
 * @returns {void}
 */
function installAssetShims() {
    const global = /** @type {{[key: string]: unknown}} */ (/** @type {unknown} */ (globalThis));
    global.chrome = {runtime: {getURL: (/** @type {string} */ url) => url}};
    global.fetch = async (/** @type {string} */ url) => {
        const file = path.join(repoRoot, 'ext', url.replace(/^\//, ''));
        const text = fs.readFileSync(file, 'utf8');
        return {
            ok: true,
            status: 200,
            json: async () => parseJson(text),
            text: async () => text,
        };
    };
}

/**
 * Compiles a `.zip` to a `.sqlite3` through the same tool the shipped databases are built with, or
 * passes a `.sqlite3` through untouched.
 * @param {string} input
 * @param {string} workingDirectory
 * @returns {string} Path to a compiled database.
 */
function resolveDatabase(input, workingDirectory) {
    if (input.endsWith('.sqlite3')) { return input; }
    const output = path.join(workingDirectory, 'seed.sqlite3');
    log('==> compiling the dictionary');
    execFileSync(
        process.execPath,
        [path.join(repoRoot, 'dev/bin/compile-dictionary.js'), input, '--out', output],
        {cwd: repoRoot, stdio: 'inherit'},
    );
    return output;
}

/**
 * Reads the dictionary summaries the *engine* will report for this database, so the options entry's
 * `name` matches the title lookups key off exactly. This is the same engine node runs in the
 * equivalence gate, over SQLite-WASM against the compiled file.
 * @param {string} databasePath
 * @returns {Promise<import('dictionary-importer').Summary[]>}
 */
async function readDictionarySummaries(databasePath) {
    const {default: sqlite3InitModule} = await import('@sqlite.org/sqlite-wasm');
    const {NativeCore} = await import('../../ext/js/native/native-core.js');
    const pakoNamespace = await import('pako');
    const pako = /** @type {import('pako')} */ (typeof (/** @type {{deflateRaw?: unknown}} */ (pakoNamespace)).deflateRaw === 'function' ? pakoNamespace : pakoNamespace.default);

    const sqlite3 = /** @type {import('sqlite-wasm').Sqlite3Module & {capi: {sqlite3_js_posix_create_file: (name: string, bytes: Uint8Array) => void}}} */ (
        /** @type {unknown} */ (await sqlite3InitModule())
    );
    const virtualPath = '/seed.sqlite3';
    sqlite3.capi.sqlite3_js_posix_create_file(virtualPath, new Uint8Array(fs.readFileSync(databasePath)));

    /** @type {import('native-bridge').NativeHost} */
    const host = {
        openDatabase: (/** @type {string} */ openPath) => new sqlite3.oo1.DB(openPath),
        databasePath: () => virtualPath,
        log: () => {},
        now: () => Date.now(),
        fetch: () => ({status: 0, url: '', headers: {}, bodyBase64: '', error: 'unused'}),
        resolveUrl: (/** @type {string} */ url) => url,
        sha256: () => '',
    };
    const core = new NativeCore(host, {pako, databasePath: virtualPath});
    return /** @type {import('dictionary-importer').Summary[]} */ (await core.invoke('getDictionaryInfo', {}));
}

/**
 * The default settings a dictionary gets when enabled through the UI — mirrored from
 * `dictionary-controller.js`, and identical to what `test-safari-e2e.js` writes when it registers a
 * dictionary over the bridge.
 * @param {string} name
 * @param {string} styles
 * @returns {import('settings').DictionaryOptions}
 */
function createDefaultDictionarySettings(name, styles) {
    return {name, alias: name, enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: true, useDeinflections: true, styles};
}

/**
 * Produces the options object to write: the container's existing one migrated to current, or a fresh
 * default, with each dictionary enabled in every profile and — if asked — the scanning language set.
 * @param {?string} existingOptionsJson
 * @param {import('dictionary-importer').Summary[]} summaries
 * @param {?string} language
 * @returns {Promise<import('settings').Options>}
 */
async function buildOptions(existingOptionsJson, summaries, language) {
    const {OptionsUtil} = await import('../../ext/js/data/options-util.js');
    const optionsUtil = new OptionsUtil();
    await optionsUtil.prepare();
    const options = existingOptionsJson !== null ?
        await optionsUtil.update(parseJson(existingOptionsJson)) :
        optionsUtil.getDefault();

    for (const profile of options.profiles) {
        if (language !== null) { profile.options.general.language = language; }
        for (const summary of summaries) {
            const existing = profile.options.dictionaries.find((dictionary) => dictionary.name === summary.title);
            if (typeof existing !== 'undefined') {
                existing.enabled = true;
            } else {
                profile.options.dictionaries.push(createDefaultDictionarySettings(summary.title, summary.styles ?? ''));
            }
        }
    }
    optionsUtil.validate(options);
    return options;
}

/**
 * Copies the compiled database over the container's live one, clearing any SQLite side files first —
 * a journal or WAL left from the old database would otherwise be recovered into the new one.
 * @param {string} databasePath
 * @param {string} destination
 * @returns {void}
 */
function installDatabase(databasePath, destination) {
    for (const suffix of ['-journal', '-wal', '-shm']) {
        fs.rmSync(destination + suffix, {force: true});
    }
    fs.copyFileSync(databasePath, destination);
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const {input, language, bundleId, container, print} = parseArguments(process.argv.slice(2));
    installAssetShims();

    const containerDir = container ?? path.join(os.homedir(), 'Library/Containers', bundleId, 'Data/Library/Application Support/Yomitan');
    const optionsPath = path.join(containerDir, 'options.json');
    const databaseDestination = path.join(containerDir, 'dictionaries.sqlite3');

    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-seed-'));
    try {
        const databasePath = resolveDatabase(input, workingDirectory);

        log('==> reading the dictionary summary from the compiled database');
        const summaries = await readDictionarySummaries(databasePath);
        if (summaries.length === 0) { throw new Error('The compiled database contains no dictionaries'); }
        log(`    ${summaries.map((s) => s.title).join(', ')}`);

        const existingRaw = fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath, 'utf8') : '';
        // An empty or blank file (e.g. one the extension has not written to yet) is treated as
        // absent, so we generate defaults rather than throwing on a parse of "".
        const existingOptionsJson = existingRaw.trim().length > 0 ? existingRaw : null;
        const options = await buildOptions(existingOptionsJson, summaries, language);

        if (print) {
            process.stdout.write(`${JSON.stringify(options, null, 4)}\n`);
            return;
        }

        fs.mkdirSync(containerDir, {recursive: true});
        installDatabase(databasePath, databaseDestination);
        fs.writeFileSync(optionsPath, JSON.stringify(options));
        log(`==> seeded ${databaseDestination}`);
        log(`==> ${existingOptionsJson === null ? 'wrote' : 'updated'} ${optionsPath}`);
        log('The extension picks these up on its next launch. On a first-ever install, open Safari once so the container exists.');
    } finally {
        fs.rmSync(workingDirectory, {recursive: true, force: true});
    }
}

await main();
