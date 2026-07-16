# Decision log

Condensed record of the decisions behind this refactor, oldest first within each group.
Rationale/measurements in full are in [01-design.md](01-design.md). Format: **Decision** —
rationale — _status_.

## Architecture

1. **Replace IndexedDB with SQLite-WASM on OPFS**, behind the existing `DictionaryDatabase`
   facade. — IndexedDB forces indexed fields + their property names into every plain record and
   duplicates indexed values in its B-trees, so compression alone floors at ~290 MB; SQLite
   gives columnar rows (no per-row key names) + real indexes + a compressible BLOB column.
   Feasibility confirmed on macOS, iOS, and the extension worker. — _adopted._
2. **OPFS SAH-Pool VFS** (`installOpfsSAHPoolVfs`), not the default OPFS VFS. — It works on
   Safari without COOP/COEP (no `SharedArrayBuffer`/cross-origin-isolation), which is
   impractical to set in an extension. Single-connection, which is fine (DB lives in one
   worker). — _adopted._
3. **App-level zstd on the `payload` BLOB**, NOT `sqlite-zstd`. — `sqlite-zstd` is a Rust
   loadable extension with no WASM build, and SQLite-WASM can't load extensions dynamically
   (must be statically compiled in — bleeding-edge for Rust). App-level compression of the one
   heavy column gives the same result with a standard toolchain. — _adopted._
4. **Columnar schema + integer `dictionary_id` FK.** — Kills the two biggest "repeating string"
   costs: per-row JSON property names (~34 MB) and the dictionary title repeated per row
   (~8 MB). SQLite indexes serve every lookup the IndexedDB indexes did. — _adopted (schema in
   `dictionary-sqlite-schema.js`)._
5. **Do NOT hand-roll inverted indexes on IndexedDB.** — Considered as an alternative to reach
   "no repeating strings"; SQLite provides the indexing/query engine instead, better tested. —
   _rejected in favor of #1._

## Compression / codec

6. **`PayloadCodec` seam with `IdentityPayloadCodec` (JSON, no compression) first.** — Prove
   backend correctness before adding compression. — _adopted (`payload-codec.js`)._
7. **Rows are self-describing via the `codec` column + per-dictionary `codec_dict`.** — The
   backend stores which codec wrote a dictionary's rows (null = identity) and its trained preset
   dictionary, and decodes with the matching registered codec. A compressing codec is trained once
   per dictionary from the first term batch (`_ensureWriteCodec`, async, before the insert
   transaction) so training a preset dict fits the streaming importer. Default write codec is
   identity, so shipped behavior is byte-identical. This also means a later codec change does not
   invalidate existing imports. — _adopted._
8. **Interim codec: pako deflate + 32 KB preset dictionary** (~3.55×, pure JS). — Lets the
   backend be built/tested before the zstd build exists; the codec is swappable. — _implemented
   (`deflate-payload-codec.js`); pako injected + vendored to `ext/lib/pako.js`. pako is pinned at
   1.0.11 (the transitive version already installed); `deflateRaw`/`inflateRaw` with a `dictionary`
   preset work there._
9. **Trained zstd dictionary per imported dictionary is the target codec** (~5.5× on the
   payload). — A shared dictionary is required (per-row compression of tiny payloads is
   otherwise net-negative); raw/untrained only gets ~2.8×, trained gets 5.5×. Needs a **custom
   zstd WASM build** exposing `ZDICT_trainFromBuffer`. — _not started; blocked on the WASM build.
   Full task spec in [zstd/](zstd/README.md)._

## Implementation patterns

10. **Inject the initialized `sqlite3` module into the backend; never import it inside backend
    code.** — The browser build (`ext/lib/sqlite3.js`, used by the worker) and the node build
    (`@sqlite.org/sqlite-wasm`, used by vitest) resolve differently. The opener takes `sqlite3`
    as a parameter (`vfs: 'opfs' | 'memory'`), so the same logic serves both. `prepare()` with no
    arguments self-loads the vendored build for the extension path. — _adopted (`open-sqlite.js`)._
11. **The vendored sqlite3 module must be a singleton** (`loadVendoredSqlite3()` memoizes it). —
    `installOpfsSAHPoolVfs` caches its pool per VFS name inside one sqlite3 instance, and the pool
    holds exclusive OPFS sync access handles; a second `sqlite3InitModule()` builds an independent
    runtime that cannot acquire them, so any close/reopen (e.g. `purge()`) throws
    `InvalidStateError`. — _adopted, after `npm run test:safari` caught it._
12. **Vendor libraries the resvg way**: `dev/build-libs.js` bundles `dev/lib/*.js` via esbuild into
    `ext/lib/` (pako), and copies sqlite's `dist/index.mjs` → `ext/lib/sqlite3.js` +
    `dist/sqlite3.wasm`. `ext/lib/*` is gitignored (generated at build), so no binaries in git.
    Verbatim copies need a `// @ts-nocheck` banner prepended (esbuild adds one to what it bundles),
    since the backend's dynamic import pulls them into the tsc graph. — _adopted._
13. **Narrow hand-written types** (`types/ext/sqlite-wasm.d.ts`, `types/ext/pako.d.ts`) instead of
    the packages' full/absent types; cast at the injection boundary via `unknown`. — Keeps the
    injected-module boundary simple. — _adopted._
14. **Node/vitest is the test environment for the SQLite backend** (`:memory:` DB), in the **plain
    node env** (not jsdom — its setup swaps the global typed-array constructors and breaks
    sqlite-wasm's heap views). — _adopted._
15. **Real Safari is driven via `open -g`, not safaridriver or Playwright WebKit.** — `safaridriver`
    has no headless mode and always steals focus; Playwright's `webkit` is headless but is a WebKit
    build rather than the Safari users run. `open -g -a Safari` uses the real browser and never
    takes focus; a loopback server (a secure context, so OPFS works) collects results from an
    in-page worker. — _adopted (`test/safari/`, `npm run test:safari`)._

## Migration / scope

16. **Require re-import; no dual-format read.** — New backend uses a new OPFS file; on first
    run, detect the legacy IndexedDB `dict`, have the user re-import, then
    `indexedDB.deleteDatabase('dict')` to reclaim ~1.2 GB. Call `navigator.storage.persist()`. —
    _helpers implemented (`dictionary-storage-migration.js`); the settings-page UX is not built._
17. **All backend changes stay behind `DictionaryDatabase` + the importer.** Callers
    (translator, backend, display) do not change. This is a fork; upstream DB compatibility is a
    non-goal. — _adopted._
18. **Safari CSP uses `'wasm-unsafe-eval'`** (was `'unsafe-eval'`, which Safari rejects/ignores;
    WASM only worked via the ArrayBuffer fallback). — _adopted (`manifest-variants.json`)._
19. **Backend selection lives in one factory** (`createDictionaryDatabase()`), used by all three
    sites that construct the real database. — Makes the Stage 5 flip a one-line change, and keeps
    the flag-off path provably identical to today. — _adopted._

## Already shipped (pre-refactor, related)

20. **Layer 1 — positional term payload** (`m: [definitionTags, rules, score, glossary,
termTags]`) in the IndexedDB rows. — Deterministic ~10% shrink and a stepping stone; the
    payload array shape carries directly onto the SQLite `payload` BLOB. — _shipped (commit
    `7edfb9b2`)._
