/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import esbuild from 'esbuild';
import fs from 'fs';
import {createRequire} from 'module';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseJson} from './json.js';

const require = createRequire(import.meta.url);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(dirname, '..', 'ext');

/**
 * @param {string} out
 */
async function copyWasm(out) {
    // copy from node modules '@resvg/resvg-wasm/index_bg.wasm' to out
    const resvgWasmPath = path.dirname(require.resolve('@resvg/resvg-wasm'));
    const wasmPath = path.join(resvgWasmPath, 'index_bg.wasm');
    fs.copyFileSync(wasmPath, path.join(out, 'resvg.wasm'));
}

/**
 * Vendors the SQLite-WASM ESM build for the dictionary storage backend. The ESM entry is
 * copied verbatim as `sqlite3.js`; it locates `sqlite3.wasm` next to itself at runtime, so
 * both must sit in the same directory (`ext/lib`). Used from the DB worker via the OPFS
 * SAH-Pool VFS. See plan/01-design.md.
 * @param {string} out
 */
async function copySqlite(out) {
    const distDir = path.dirname(require.resolve('@sqlite.org/sqlite-wasm'));
    // Copied verbatim (not bundled), so prepend the same `@ts-nocheck` banner the esbuild-bundled
    // libs get — the backend dynamically imports this from the tsc project graph.
    const source = fs.readFileSync(path.join(distDir, 'index.mjs'), {encoding: 'utf8'});
    fs.writeFileSync(path.join(out, 'sqlite3.js'), `// @ts-nocheck\n${source}`);
    fs.copyFileSync(path.join(distDir, 'sqlite3.wasm'), path.join(out, 'sqlite3.wasm'));
}


/**
 * Vendors the zstd + ZDICT WASM module for the zstd payload codec. Unlike the other libs this one
 * has no npm package behind it: no published zstd WASM build exposes `ZDICT_trainFromBuffer`, the
 * dictionary trainer, so it is built from zstd source by `dev/zstd/build.sh` (`npm run build:zstd`)
 * and the result is committed under `dev/vendor/`. That keeps emscripten out of the normal
 * build/CI path — this step is only a copy.
 *
 * The build embeds the wasm in the .js (`-sSINGLE_FILE`), so there is no sibling `.wasm` to place
 * and nothing here depends on Safari serving `application/wasm` correctly. See plan/zstd/README.md.
 * @param {string} out
 */
async function copyZstd(out) {
    const source = path.join(dirname, 'vendor', 'zstd', 'zstd.js');
    if (!fs.existsSync(source)) {
        throw new Error(`Missing vendored zstd build at ${source}; run 'npm run build:zstd' to regenerate it.`);
    }
    fs.copyFileSync(source, path.join(out, 'zstd.js'));
}


/**
 * @param {string} scriptPath
 */
async function buildLib(scriptPath) {
    await esbuild.build({
        entryPoints: [scriptPath],
        bundle: true,
        minify: false,
        sourcemap: true,
        target: 'es2020',
        format: 'esm',
        outfile: path.join(extDir, 'lib', path.basename(scriptPath)),
        external: ['fs'],
        banner: {
            js: '// @ts-nocheck',
        },
    });
}

/**
 * Bundles libraries.
 */
export async function buildLibs() {
    const devLibPath = path.join(dirname, 'lib');
    const files = await fs.promises.readdir(devLibPath, {
        withFileTypes: true,
    });
    for (const f of files) {
        if (f.isFile()) {
            await buildLib(path.join(devLibPath, f.name));
        }
    }

    const schemaDir = path.join(extDir, 'data/schemas/');
    const schemaFileNames = fs.readdirSync(schemaDir);
    const schemas = schemaFileNames.map((schemaFileName) => {
        /** @type {import('ajv').AnySchema} */
        // eslint-disable-next-line sonarjs/prefer-immediate-return
        const result = parseJson(fs.readFileSync(path.join(schemaDir, schemaFileName), {encoding: 'utf8'}));
        return result;
    });
    const ajv = new Ajv({
        schemas,
        code: {source: true, esm: true},
        allowUnionTypes: true,
    });
    const moduleCode = standaloneCode(ajv);

    // https://github.com/ajv-validator/ajv/issues/2209
    const patchedModuleCode = "// @ts-nocheck\nimport {ucs2length} from './ucs2length.js';" + moduleCode.replaceAll('require("ajv/dist/runtime/ucs2length").default', 'ucs2length');

    fs.writeFileSync(path.join(extDir, 'lib/validate-schemas.js'), patchedModuleCode);

    await copyWasm(path.join(extDir, 'lib'));
    await copySqlite(path.join(extDir, 'lib'));
    await copyZstd(path.join(extDir, 'lib'));
}
