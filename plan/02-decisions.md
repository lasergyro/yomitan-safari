# Decision log

Condensed record of the decisions behind this refactor, oldest first within each group.
Rationale/measurements in full are in [01-design.md](01-design.md). Format: **Decision** —
rationale — _status_.

**Numbers are permanent IDs**, referenced from the code and the other plan docs, so renumbering
silently breaks every existing reference.

**To add a decision, append it in a new trailing section** — never insert one mid-document, even into
the group it belongs to thematically. The pre-commit `prettier --write` renumbers each ordered list
from its own first item, so inserting into a group shifts every later number in it _and_ collides
with the next group (which keeps its literal starting number). This already happened once: three
decisions appended to "Implementation patterns" were rewritten 21→16, 22→17, 23→18, duplicating the
16–18 in "Migration / scope". Sections exist for reading, but the numbers are the contract.

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
   zstd WASM build** exposing `ZDICT_trainFromBuffer`. — _built and tested, **not selected**. The
   ~5.5× **did not reproduce** when finally measured on real `kty-de-en` data: with the parameters
   this decision assumed (110 KB dictionary) zstd gets 3.15× and loses to deflate's 3.55×. Sizing
   the dictionary properly (1.9 MB, needing ~200k training rows buffered) gets 4.47× / 56.8 MB and
   decodes ~8× faster than deflate (2.7 vs 21.4 µs/row). The dictionary-is-mandatory half of this decision holds; the
   number does not. See [zstd/](zstd/README.md)._

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

## zstd task

Implementation patterns from the [zstd/](zstd/README.md) task. They belong with #10–#15 by theme but
live here because appending is the only safe place to add one — see the note at the top.

21. **The zstd WASM build is a committed _script_, not a committed artifact.** — No published zstd
    WASM build exposes `ZDICT_trainFromBuffer` (verified: `@bokuweb/zstd-wasm` and `zstd-codec` have
    no `ZDICT_*` symbols), so unlike every other lib it cannot come from npm; `dev/zstd/build.sh`
    builds it from source and `npm run build:libs` copies the result to `ext/lib/`. What is
    committed is the reproducible build (pinned zstd version + sha256, refusing to run on a
    mismatch), not its ~500 KB output — `dev/vendor/` is gitignored like `ext/lib/`, and the build
    is cached locally. The cost is that a fresh clone must run `npm run build:zstd` once (needs
    emscripten) before the zstd tests or a build; there is no CI to serve, so a local cache is
    enough. `-sSINGLE_FILE=1` embeds the wasm in the .js: one artifact, no sibling-`.wasm` path
    resolution, and Safari's missing `application/wasm` MIME (#18 / the `instantiateStreaming`
    fallback) never comes up, for ~8% size (502 KB vs 464 KB split). — _adopted._
22. **`PayloadCodec.prepare?()`, awaited by `DictionaryDatabaseSqlite.prepare()`.** — `encode`/
    `decode` are synchronous because they sit inside sqlite's synchronous query/transaction paths,
    but a WASM-backed codec must load its module first, and reading already-imported rows never
    calls `train()` — so there is no other async moment to initialize in. Optional, so identity and
    deflate ignore it. — _adopted._
23. **Default zstd level is 15, not the 19 the design assumed.** — Measured sweep: the ratio plateaus
    at 15 (15/19/22 identical) while 19 costs ~3× the encode time. Structural rather than corpus-
    specific: at ~330 B/row a longer match search finds nothing extra, since the redundancy resolves
    against the shared dictionary, not within the row. — _adopted; **confirmed on real data**
    (−15 → 3.14×, −19 → 3.15× on `kty-de-en`)._
24. **Codec tuning is a constructor option, not a constant.** — `ZstdPayloadCodec` takes
    `level`/`dictionaryCapacity` and `DictionaryDatabaseSqlite` takes `trainSampleSize`, because the
    real measurements show the tradeoff is a judgement call rather than a fact: dictionary size is
    the dominant lever on ratio (110 KB → 3.15×, ~2 MB → 4.63×), it costs nothing on decode, but a
    bigger dictionary is only trainable by buffering proportionally more of the import (ZDICT wants
    ~100× the dictionary size in samples). `npm run measure:zstd` re-derives all of it against the
    real dictionary. — _adopted._
25. **`trainSampleSize` defaults to 1000, the importer's `maxTransactionLength`.** — Training runs on
    the first `bulkAdd` batch, so any larger value was silently unreachable (the old constant of 4000
    was dead). The default now states the real constraint rather than hiding it; raising it means
    also giving the trainer more than one batch. — _adopted._
