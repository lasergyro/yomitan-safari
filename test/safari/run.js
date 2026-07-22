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
 * Runs the SQLite/OPFS backend checks in **real Safari**, in the background.
 *
 * Node can't verify the things that actually gate the backend: the OPFS SAH-Pool VFS, the vendored
 * `ext/lib/sqlite3.js` + `sqlite3.wasm` loading over HTTP, and WebKit's own WASM behavior. This
 * serves the repo over `http://127.0.0.1` (a secure context, so OPFS is available), opens the
 * harness with `open -g` — which launches/uses Safari **without bringing it to the foreground**, so
 * it never steals focus — and waits for the in-page worker to POST its results back.
 *
 * Usage: `npm run test:safari` (optionally `PORT=9001 KEEP_OPEN=1 npm run test:safari`).
 */

import {execFile} from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseJson} from '../../dev/json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '..', '..');
const port = Number.parseInt(process.env.PORT ?? '8730', 10);
const timeoutMs = Number.parseInt(process.env.TIMEOUT_MS ?? '120000', 10);

/** @type {Map<string, string>} */
const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.css', 'text/css; charset=utf-8'],
]);

/**
 * @param {import('http').IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}

/**
 * @typedef {{name: string, ok: boolean, error?: string, info?: string}} SafariCheck
 */

/**
 * @param {SafariCheck[]} checks
 * @returns {boolean} Whether every check passed.
 */
function report(checks) {
    let failed = 0;
    for (const check of checks) {
        if (check.ok) {
            console.log(`  [32m✔[0m ${check.name}${typeof check.info === 'string' ? ` [2m— ${check.info}[0m` : ''}`);
        } else {
            ++failed;
            console.log(`  [31m✘[0m ${check.name}\n      ${check.error}`);
        }
    }
    console.log(`\n${checks.length - failed}/${checks.length} checks passed in real Safari.`);
    return failed === 0;
}

/** Entry point. */
async function main() {
    /** @type {(value: SafariCheck[]) => void} */
    let resolveResults = () => {};
    /** @type {Promise<SafariCheck[]>} */
    const results = new Promise((resolve) => { resolveResults = resolve; });

    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

        if (request.method === 'POST' && url.pathname === '/results') {
            void readBody(request).then((body) => {
                response.setHeader('access-control-allow-origin', '*');
                response.end('ok');
                resolveResults(/** @type {SafariCheck[]} */ (parseJson(body)));
            });
            return;
        }

        if (url.pathname === '/log') {
            void readBody(request).then((body) => {
                console.log(`  [2m[safari] ${body}[0m`);
                response.end('ok');
            });
            return;
        }

        const requestPath = url.pathname === '/' ? '/test/safari/harness.html' : url.pathname;

        // Serve the backend flag as ON regardless of what is committed. The page-side checks build a
        // DictionaryDatabaseSqlite explicitly, but the worker that owns the connection picks its
        // backend through createDictionaryDatabase() — so with the flag off the owner would come up
        // as IndexedDB and the two halves would not match. Overriding here keeps these checks
        // exercising the shipping configuration on either side of the flag flip.
        if (requestPath === '/ext/js/dictionary/dictionary-backend-config.js') {
            response.setHeader('content-type', 'text/javascript');
            response.end('export const USE_SQLITE_BACKEND = true;\n');
            return;
        }

        const filePath = path.join(repoRoot, path.normalize(requestPath));
        if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.statusCode = 404;
            response.end('not found');
            return;
        }
        response.setHeader('content-type', contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream');
        // OPFS needs a secure context; 127.0.0.1 qualifies, so no COOP/COEP is required for the
        // SAH-Pool VFS (that is the whole reason we use SAH-Pool over the default OPFS VFS).
        fs.createReadStream(filePath).pipe(response);
    });

    await new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => { resolve(void 0); });
    });

    const url = `http://127.0.0.1:${port}/?t=${Date.now()}`;
    console.log(`Serving ${repoRoot}\nOpening ${url} in Safari (backgrounded, focus is not taken)…\n`);
    // `-g` keeps Safari in the background; `-a Safari` targets the real browser (not a WebKit build).
    execFile('open', ['-g', '-a', 'Safari', url], (error) => {
        if (error) { console.error('Failed to open Safari:', error.message); }
    });

    /** @type {Promise<null>} */
    const timeout = new Promise((resolve) => {
        setTimeout(() => { resolve(null); }, timeoutMs);
    });
    const checks = await Promise.race([results, timeout]);
    server.close();

    if (checks === null) {
        console.error(`\nTimed out after ${timeoutMs}ms with no results from Safari.`);
        console.error('Is Safari blocked from loading 127.0.0.1, or did the worker fail to start?');
        process.exit(1);
    }

    const ok = report(checks);
    if (process.env.KEEP_OPEN !== '1') {
        console.log('[2m(The Safari tab stays open; close it or run with KEEP_OPEN=1 to keep quiet about it.)[0m');
    }
    process.exit(ok ? 0 : 1);
}

void main();
