# Decision log

Condensed record of the decisions behind this refactor. Rationale/measurements in full are in
[design.md](design.md). Format: **Decision** — rationale — _status_.

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

6. **Trained zstd dictionary per imported dictionary is the target codec** (~5.5× on the
   payload). — A shared dictionary is required (per-row compression of tiny payloads is
   otherwise net-negative); raw/untrained only gets ~2.8×, trained gets 5.5×. Needs a **custom
   zstd WASM build** exposing `ZDICT_trainFromBuffer` (user agreed to build one). — _planned
   (Stage 3)._
7. **Interim codec: pako deflate + 32 KB preset dictionary** (~3.55×, pure JS). — Lets the
   backend be built/tested before the zstd build exists; codec is swappable. — _implemented
   (`deflate-payload-codec.js`); pako injected + vendored to `ext/lib/pako.js`. The pinned pako is
   1.0.11 (the transitive version already installed); `deflateRaw`/`inflateRaw` with a `dictionary`
   preset work there._
   7b. **Rows are self-describing via the `codec` column + per-dictionary `codec_dict`.** — The
   backend stores which codec wrote a dictionary's rows (null = identity) and its trained preset
   dictionary, and decodes with the matching registered codec. A compressing codec is trained once
   per dictionary from the first term batch (`_ensureWriteCodec`, async, before the insert
   transaction) so training a preset dict fits the streaming importer. Default write codec is
   identity (shipped), so existing behavior is byte-identical. — _implemented._
8. **`PayloadCodec` seam with `IdentityPayloadCodec` (JSON, no compression) first.** — Prove
   backend correctness before adding compression. — _adopted (`payload-codec.js`)._

## Implementation patterns (Stage 0/1)

9. **Inject the initialized `sqlite3` module into the backend; never import it inside backend
   code.** — The browser build (`ext/lib/sqlite3.js`, used by the worker) and the node build
   (`@sqlite.org/sqlite-wasm`, used by vitest) resolve differently. The opener takes `sqlite3`
   as a parameter (`vfs: 'opfs' | 'memory'`), so the same logic serves both. — _adopted
   (`open-sqlite.js`)._
10. **Vendor SQLite the resvg way**: `dev/build-libs.js` copies `dist/index.mjs` →
    `ext/lib/sqlite3.js` and `dist/sqlite3.wasm` from `node_modules`. `ext/lib/*` is gitignored
    (generated at build), so no binaries in git. — _adopted._
11. **Narrow hand-written `types/ext/sqlite-wasm.d.ts`** instead of the package's large browser
    types; cast the package's real types to it at the test boundary via `unknown`. — Keeps the
    injected-module boundary simple. — _adopted._
12. **Node/vitest is the test environment for the SQLite backend** (`:memory:` DB). — vitest
    runs in node; the sqlite-wasm node build works there; existing fixtures can validate the new
    backend. This was the flagged early risk and is now settled. — _adopted
    (`test/sqlite-backend-smoke.test.js`)._

## Migration / scope

13. **Require re-import; no dual-format read.** — New backend uses a new OPFS file; on first
    run, detect the legacy IndexedDB `dict`, have the user re-import, then
    `indexedDB.deleteDatabase('dict')` to reclaim ~1.2 GB. Call `navigator.storage.persist()`. —
    _planned (Stage 4)._
14. **All backend changes stay behind `DictionaryDatabase` + the importer.** Callers
    (translator, backend, display) do not change. This is a fork; upstream DB compatibility is a
    non-goal. — _adopted._
15. **Safari CSP uses `'wasm-unsafe-eval'`** (was `'unsafe-eval'`, which Safari rejects/ignores;
    WASM only worked via the ArrayBuffer fallback). — _adopted (`manifest-variants.json`)._

## Already shipped (pre-refactor, related)

16. **Layer 1 — positional term payload** (`m: [definitionTags, rules, score, glossary,
termTags]`) in the IndexedDB rows. — Deterministic ~10% shrink and a stepping stone; the
    payload array shape carries directly onto the SQLite `payload` BLOB. — _shipped (commit
    `7edfb9b2`)._
