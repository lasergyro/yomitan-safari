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
 * Bundles the dictionary engine into the single script JavaScriptCore evaluates inside the app
 * extension (plan/native-rewrite.md → The JSC host).
 *
 * JavaScriptCore has no ES-module loader — `evaluateScript` takes one script and nothing can
 * `import` at runtime — so the engine's module graph has to be rolled up first. That is the only
 * reason this step exists; it is a packaging concern, not a transformation. The code that ends up
 * in the bundle is byte-for-byte the code vitest runs.
 *
 * Usage:
 *   node dev/bin/build-native-core.js                        # -> native/Resources/yomitan-core.js
 *   node dev/bin/build-native-core.js --out path/to/core.js
 *   node dev/bin/build-native-core.js --no-minify             # readable, for debugging in the harness
 */

import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..', '..');
const entryPoint = path.join(repoRoot, 'ext/js/native/native-core-main.js');
const defaultOutFile = path.join(repoRoot, 'native/Resources/yomitan-core.js');

/**
 * @param {string[]} argv
 * @returns {{outFile: string, minify: boolean, metafile: boolean}}
 * @throws {Error} On an unrecognized argument, rather than silently building the default.
 */
function parseArguments(argv) {
    let outFile = defaultOutFile;
    // Minified by default so that the bundle the equivalence gate exercises is byte-identical to
    // the one that ships. It also buys back a few ms of the app extension's cold start, which is
    // paid every time the process is reclaimed. Sizes and timings: plan/README.md -> The numbers,
    // once (kept there so a re-measure has one place to land).
    let minify = true;
    let metafile = false;
    for (let i = 0; i < argv.length; ++i) {
        const argument = argv[i];
        switch (argument) {
            case '--out':
            case '-o':
                outFile = path.resolve(argv[++i]);
                break;
            case '--minify':
                minify = true;
                break;
            case '--no-minify':
                minify = false;
                break;
            case '--metafile':
                metafile = true;
                break;
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return {outFile, minify, metafile};
}

/**
 * @param {{outFile: string, minify: boolean, metafile: boolean}} options
 * @returns {Promise<void>}
 */
async function build({outFile, minify, metafile}) {
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    const result = await esbuild.build({
        entryPoints: [entryPoint],
        outfile: outFile,
        bundle: true,
        // IIFE, not ESM: the host evaluates this as a classic script. The entry's side effects
        // (installing the shims and publishing `yomitanNative*`) are what the host looks for, so
        // there is nothing to export.
        format: 'iife',
        // JavaScriptCore in the OS versions this app supports is a current engine; there is no
        // reason to down-level, and down-levelling async functions in particular would replace the
        // native microtask scheduling the host's event loop is built around.
        target: 'es2022',
        // Neutral rather than 'browser' or 'node': the host is neither, and letting esbuild pick
        // browser conditions would resolve packages to builds that assume `window`.
        platform: 'neutral',
        mainFields: ['module', 'main'],
        conditions: ['import', 'default'],
        charset: 'utf8',
        legalComments: 'inline',
        sourcemap: false,
        minify,
        metafile,
        // Nothing may be left unresolved: an unbundled import would be a runtime failure inside an
        // app extension with no console attached, which is the worst place to discover one.
        external: [],
        logLevel: 'warning',
    });
    const bytes = fs.statSync(outFile).size;
    process.stdout.write(`native core bundle: ${path.relative(repoRoot, outFile)} (${(bytes / 1024).toFixed(0)} KiB)\n`);
    if (metafile && typeof result.metafile !== 'undefined') {
        const metaPath = `${outFile}.meta.json`;
        fs.writeFileSync(metaPath, JSON.stringify(result.metafile, null, 2));
        process.stdout.write(`  metafile: ${path.relative(repoRoot, metaPath)}\n`);
    }
}

await build(parseArguments(process.argv.slice(2)));
