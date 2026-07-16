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
 * The locally built module, which `build:libs` copies to `ext/lib/zstd.js`. Kept in a variable so
 * the specifier is not statically resolvable: the build is generated rather than committed
 * (plan/02-decisions.md #21), and a static import would make every type-check and unrelated test
 * fail on a fresh clone instead of just the zstd ones.
 */
const BUILD_PATH = '../vendor/zstd/zstd.js';

/**
 * Loads the locally built zstd WASM module for node-side consumers (the tests and
 * `dev/zstd/measure.js`), which inject it the way the browser injects `ext/lib/zstd.js` —
 * plan/02-decisions.md #10.
 * @returns {Promise<import('zstd').ZstdInitModule>}
 * @throws {Error} If the zstd build has not been generated yet.
 */
export async function loadZstdInitModule() {
    try {
        // BUILD_PATH is this module's own constant, not input: it is a variable purely to keep the
        // specifier out of the static module graph (see above).
        /** @type {unknown} */
        // eslint-disable-next-line no-unsanitized/method
        const module = await import(BUILD_PATH);
        const {default: zstdInitModule} = /** @type {{default: unknown}} */ (module);
        return /** @type {import('zstd').ZstdInitModule} */ (zstdInitModule);
    } catch (e) {
        throw new Error(
            "The zstd WASM build is missing. Run 'npm run build:zstd' (needs emscripten: " +
            '`brew install emscripten`). It is generated locally rather than committed, so a fresh ' +
            `clone has to build it once. Cause: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
}
