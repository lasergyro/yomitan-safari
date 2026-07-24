# plan/history/ — the record

**Nothing described in this directory is in the tree.** It is kept for the reasoning: the constraint
behind a dead decision is usually still worth not rediscovering, and several of these were expensive
to learn. Read it as a record, never as a description of how anything works today — for that, read
[../design.md](../design.md), [../decisions.md](../decisions.md) and
[../native-rewrite.md](../native-rewrite.md).

The one-line version of how the project got here: the dictionary backend was rebuilt on **SQLite**
inside the extension, on **OPFS**; it worked and hit its size target, then turned out not to survive
a Safari restart, because Safari rotates the extension origin on every launch. So the engine moved
into the **native app**, unchanged, and everything that existed only to host it in the browser was
deleted.

## The documents

| File                                             | What it holds                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [safari-opfs-blocker.md](safari-opfs-blocker.md) | **Why the engine went native**: Safari rotates the extension origin, so OPFS cannot persist |
| [safari-idb-snapshot.md](safari-idb-snapshot.md) | The smaller in-browser fix for that blocker — designed, never built                         |
| [backend-worker.md](backend-worker.md)           | The owner-worker/proxy split, and the Safari traps it uncovered                             |
| [sizing.md](sizing.md)                           | Bottom-up byte budget: why the inflections, not the codec, are the database                 |
| [zstd.md](zstd.md)                               | Why zstd was built, measured, and rejected in favour of deflate                             |
| [original-plan.md](original-plan.md)             | The first draft (superseded): feasibility spike, rejected architectures                     |

The rest of this file is what used to sit directly under `plan/`: the decisions that died, the
sections of the design doc they invalidated, and the stage-by-stage progress log of the in-browser
build.

## Historical decisions

Numbering is continuous with [../decisions.md](../decisions.md) — these are the entries from that log
whose status is no longer LIVE. **A number is a permanent ID and is never reused**, so a citation of
`#21` in code or in another document means this one, wherever it happens to live. Live decisions stay
in [../decisions.md](../decisions.md).

- **#2.** **OPFS SAH-Pool VFS** (`installOpfsSAHPoolVfs`), not the default OPFS VFS. — It works on
  Safari without COOP/COEP (no `SharedArrayBuffer`/cross-origin-isolation), which is
  impractical to set in an extension. Single-connection, which is fine (DB lives in one
  worker). — _adopted._

- **#3.** **App-level zstd on the `payload` BLOB**, NOT `sqlite-zstd`. — `sqlite-zstd` is a Rust
  loadable extension with no WASM build, and SQLite-WASM can't load extensions dynamically
  (must be statically compiled in — bleeding-edge for Rust). App-level compression of the one
  heavy column gives the same result with a standard toolchain. — _adopted._

- **#5.** **Do NOT hand-roll inverted indexes on IndexedDB.** — Considered as an alternative to reach
  "no repeating strings"; SQLite provides the indexing/query engine instead, better tested. —
  _rejected in favor of #1._

- **#9.** _(SUPERSEDED by #26 — zstd was measured and rejected.)_ **Trained zstd dictionary per imported
  dictionary is the target codec** (~5.5× on the payload). — A shared dictionary is required (per-row compression of tiny payloads is
  otherwise net-negative); raw/untrained only gets ~2.8×, trained gets 5.5×. Needs a **custom
  zstd WASM build** exposing `ZDICT_trainFromBuffer`. — _built and tested, **not selected**. The
  ~5.5× **did not reproduce** when finally measured on real `kty-de-en` data: with the parameters
  this decision assumed (110 KB dictionary) zstd gets 3.15× and loses to deflate's 3.55×. Sizing
  the dictionary properly (1.9 MB, needing ~200k training rows buffered) gets 4.47× / 56.8 MB and
  decodes ~8× faster than deflate (2.7 vs 21.4 µs/row). The dictionary-is-mandatory half of this decision holds; the
  number does not. See [zstd.md](zstd.md)._

- **#11.** **The vendored sqlite3 module must be a singleton** (`loadVendoredSqlite3()` memoizes it). —
  `installOpfsSAHPoolVfs` caches its pool per VFS name inside one sqlite3 instance, and the pool
  holds exclusive OPFS sync access handles; a second `sqlite3InitModule()` builds an independent
  runtime that cannot acquire them, so any close/reopen (e.g. `purge()`) throws
  `InvalidStateError`. — _historical: adopted after `npm run test:safari` caught it; both the
  vendored module and that runner went with the OPFS backend (#44)._

- **#16.** **Require re-import; no dual-format read.** — New backend uses a new OPFS file; on first
  run, detect the legacy IndexedDB `dict`, have the user re-import, then
  `indexedDB.deleteDatabase('dict')` to reclaim the legacy store. Call
  `navigator.storage.persist()`. (This decision and [the progress log](#the-progress-log) → Stage 4 both said
  "~1.2 GB"; the only figure measured since is the **~700 MB** app-reported baseline in
  [README.md](../README.md#the-numbers-once). The 1.2 GB was never reproduced through the real
  importer — read ~700 MB as the number and this one as an early estimate.) — _historical: the
  helpers (`dictionary-storage-migration.js`) **and** the settings-page UX
  (`dictionary-storage-migration-controller.js`, [the progress log](#the-progress-log) → Stage 5 item 2) were
  both built, and both were deleted with the in-browser backend (#44, #46). A build that cannot
  import in the browser has nothing to migrate from._

- **#19.** **Backend selection lives in one factory** (`createDictionaryDatabase()`), used by all three
  sites that construct the real database. — Makes the Stage 5 flip a one-line change, and keeps
  the flag-off path provably identical to today. — _adopted, then **superseded by #46**: with one
  backend left there is nothing to select, and the factory, the flag and
  `dictionary-database-factory.js` are all deleted. `Backend` constructs
  `DictionaryDatabaseNative` directly._

- **#21.** _(historical — zstd removed in #26)_ **The zstd WASM build was a committed _script_, not a committed artifact.** — No published zstd
  WASM build exposes `ZDICT_trainFromBuffer` (verified: `@bokuweb/zstd-wasm` and `zstd-codec` have
  no `ZDICT_*` symbols), so unlike every other lib it cannot come from npm; `dev/zstd/build.sh`
  builds it from source and `npm run build:libs` copies the result to `ext/lib/`. What is
  committed is the reproducible build (pinned zstd version + sha256, refusing to run on a
  mismatch), not its ~500 KB output — `dev/vendor/` is gitignored like `ext/lib/`, and the build
  was cached locally. The cost was that a fresh clone had to run `npm run build:zstd` once (needs
  emscripten) before the zstd tests or a build; there is no CI to serve, so a local cache sufficed. `-sSINGLE_FILE=1` embeds the wasm in the .js: one artifact, no sibling-`.wasm` path
  resolution, and Safari's missing `application/wasm` MIME (#18 / the `instantiateStreaming`
  fallback) never comes up, for ~8% size (502 KB vs 464 KB split). — _adopted._

- **#23.** _(historical — zstd removed in #26)_ **Default zstd level was 15, not the 19 the design assumed.** — Measured sweep: the ratio plateaus
  at 15 (15/19/22 identical) while 19 costs ~3× the encode time. Structural rather than corpus-
  specific: at ~330 B/row a longer match search finds nothing extra, since the redundancy resolves
  against the shared dictionary, not within the row. — _adopted; **confirmed on real data**
  (−15 → 3.14×, −19 → 3.15× on `kty-de-en`)._

- **#30.** **The remaining weight is the dictionary's shape, not the schema or the codec.** — 90% of
  `kty-de-en`'s rows are inflected-form stubs (`geschützt → past participle of schützen`). They are
  **60.5 MB of the 71.5 MB payload**; all 94,931 real definitions together are **11.1 MB**. A stub
  carries ~3.6 B of information (a 17-bit lemma pointer + a 12-bit label) and costs 71 B stored.
  Storing them as `(lemma_id, label_id)` instead of JSON text is worth ~50 MB — more than every
  other lever here combined, and it is an importer/schema change, not a codec one. — _recorded;
  no work scheduled._

- **#38.** **The dictionary lives in OPFS but is _owned_ by an IndexedDB snapshot.** — Safari regenerates
  the extension's origin UUID on every launch (deliberate anti-fingerprinting), and OPFS is
  partitioned by origin, so an imported dictionary is stranded on every restart; IndexedDB,
  `localStorage` and `chrome.storage.local` are not. Measured over three consecutive launches with
  no rebuild between them — see [safari-opfs-blocker.md](safari-opfs-blocker.md). Since SQLite's
  VFS interface is synchronous and OPFS sync access handles are the only synchronous durable
  storage in a browser, the choices were: pay Asyncify on every query (a block VFS over IndexedDB),
  pay grow-only wasm memory proportional to total dictionary size (`:memory:`), or pay one
  full-file copy per launch. The last is the only one whose cost is flat in dictionary count and
  paid once per launch, and it is the only one that leaves the schema, codec, importer, inflection
  synthesis and worker topology untouched. The SAH-Pool already exposes `exportFile` /
  `importDbChunked`, so no new dependency is involved. Design in
  [safari-idb-snapshot.md](safari-idb-snapshot.md). — _**abandoned, never built.** #39 landed
  instead, which removes OPFS from the extension entirely rather than working around it._

- **#44.** **The in-browser SQLite backend was deleted, not kept as a fallback.** — With the engine native,
  the OPFS/SAH-Pool opener, the owner-worker proxy (`DatabaseOwnerClient` and both DB-worker
  files), the `suspendDatabase`/`resumeDatabase` API pair, the legacy-IndexedDB migration and its
  settings controller, the vendored `sqlite3.wasm`, `test/safari/` and the `USE_SQLITE_BACKEND`
  flag all became a second, half-working way to do the same thing. Two backends were left standing
  at this point, each with one reason to exist: **native** for Safari, **IndexedDB** for every
  other browser. The engine itself was not deleted — it is what runs natively. — _superseded by
  #46, which applied the same argument to the IndexedDB backend on a Safari-only fork and deleted
  it, the factory and the flag; one backend remains._

## Design sections these invalidated

Lifted verbatim out of [../design.md](../design.md), which now describes only the current system.
They are the three places where the in-browser hosting showed through the design: where the database
file lived, how a user was to be migrated onto it, and how the two backends were selected between.

## Storage model ▲ superseded

_Current code, not the plan — the engine is moving into the native app
([native-rewrite.md](../native-rewrite.md)), which replaces this whole section. The **injected-module
seam** described here is what makes that swap tractable, so it is the part worth carrying forward._

One SQLite database file on OPFS, opened with the **SAH-Pool VFS** (`installOpfsSAHPoolVfs` →
`OpfsSAHPoolDb`). SAH-Pool is the VFS that works on Safari without COOP/COEP (no `SharedArrayBuffer`
/ cross-origin isolation, which an extension cannot arrange). It is single-connection and
**Worker-only** — sync access handles do not exist on the main thread — so a dedicated worker owns
the connection and the background page proxies to it (retired design:
[history/backend-worker.md](backend-worker.md)).

`open-sqlite.js` (`openDictionaryDatabaseHandle`) is VFS-agnostic: `vfs:'opfs'` for the extension,
`vfs:'memory'` for tests. The `sqlite3` module is **injected**, never imported inside backend code —
the browser build (`ext/lib/sqlite3.js`) and the node build (`@sqlite.org/sqlite-wasm`) resolve
differently, and the same opener serves both. The vendored module is loaded once and memoized: a
second `sqlite3InitModule()` builds an independent runtime that cannot acquire the pool's exclusive
OPFS handles. **That injection point is the seam the native SQLite binding substitutes at**, which is
why the native work is a re-host rather than a rewrite.

`DictionaryDatabaseSqlite.prepare()` is a drop-in for the IndexedDB `prepare()`: called with no
arguments it self-loads the vendored build, opens the OPFS VFS, and calls
`navigator.storage.persist()` — which **never grants on Safari** and is inert there
([the progress log](#the-progress-log) → Watch-outs). Tests inject `sqlite3` + `vfs:'memory'`.

## Migration ▲ superseded

_The native direction removes in-browser import entirely — dictionaries are compiled to SQLite at
build time and installed as a file — so this legacy-IndexedDB migration path is scheduled for
deletion, not completion ([native-rewrite.md](../native-rewrite.md) → stage N5)._

The backend uses a **new OPFS file** and does not read the old IndexedDB `dict`. It detects a
non-empty legacy `dict`, has the user re-import, then `indexedDB.deleteDatabase('dict')` to reclaim
the old storage. Helpers in `dictionary-storage-migration.js`
(`legacyIndexedDbDictionaryExists`, `deleteLegacyIndexedDbDictionary`,
`requestPersistentStorage`); the settings-page UX that drives them is
`dictionary-storage-migration-controller.js`.

This is a fork; upstream on-disk compatibility is a non-goal, and re-import (rather than a dual-format
reader) is a deliberate choice.

## Integration ▲ superseded

_The dual-backend split and its flag are **gone** — the native direction reached Stage 5 item 7 by a
different road ([native-rewrite.md](../native-rewrite.md) → stage N5). `Backend` now constructs
`DictionaryDatabaseNative` directly; the factory, the flag and the IndexedDB backend were all
deleted ([decisions.md](../decisions.md) #46)._

- **Selection lived in one factory** (`dictionary-database-factory.js`, `createDictionaryDatabase()`),
  used by all three sites that constructed the real database (`background/backend.js`,
  `background/offscreen.js`, the DB worker handler). With `USE_SQLITE_BACKEND` off it returned exactly
  `new DictionaryDatabase()` — no SQLite/WASM/pako touched at runtime.
- **The SQLite backend was cast to `DictionaryDatabase`** at the factory/test seams; the two backends
  shared the public surface but were separate classes. That is what #46 resolved: the surface is now
  a type, split into `DictionaryDatabaseRead` (translator, backend) and `DictionaryDatabaseWrite`
  (the importer, which now exists only in the build-time compiler).
- **Result builders** (`_createTerm`, `_createKanji`, …) mirror the IndexedDB backend's, sourcing
  their fields from decoded payloads + columns, so callers see identical objects.

## The progress log

The working log of the in-browser build, stages 0–5, kept verbatim. It is the most detailed account
of what was tried and what it cost, and it is also where several retracted measurements are recorded
alongside the traps that produced them — which is the part most worth reading twice.

**Everything below is history**, including the parts written in the present tense. The schema, the
payload codec, inflection synthesis, the query strategy and the whole vitest suite carried over into
the native engine unmodified — the engine was re-hosted, not rewritten — but the hosting described
here is gone.

## Git state

- Branch **`safari-refactor`** (off `master`). Tag **`stage-1`** marks the start of Stage 1.
- Storage-work commits (oldest first):
  - `7edfb9b2` (pre-refactor) Store non-indexed term fields as a positional payload (Layer 1)
  - `864b8d23` Add plan.md
  - `d677eb89` Stage 0: scaffold SQLite-WASM backend (vendor, CSP, codec, flag)
  - `fa0bd435` plan.md: mark Stage 0 complete
  - `c17abdd5` Stage 1: prove SQLite-WASM runs under vitest (harness de-risk)
  - `4bdef82f` Stage 1: env-aware SQLite opener + dictionary schema
  - `a7ba6f19` Stage 1: SQLite term backend (bulkAdd + findTermsBulk) with IndexedDB parity test
  - `484f84a7` Stage 2: full DictionaryDatabaseSqlite parity + end-to-end fixture test
  - `794feac8` Stage 3: compressing payload codec (deflate) + self-describing rows
  - `898ae1f7` Stage 4: migration + persistence helpers, tuning, and backend selection wiring
  - `ff7f7e45` Add a real-Safari test runner, split out the zstd task, sort the plan docs
  - `56658cf5` plan: fix decision cross-references after the renumbering
- The commit list above stops at the codec work; later commits (the owner-worker fix, the flag flip,
  the OPFS blocker, the native redirect) are in `git log` and are not mirrored here.
- Green **as of the OPFS-era work recorded here**: `tsc` (main + test), repo-wide `eslint`, full
  `vitest` (4296 tests / 46 skipped), `npm run build -- --target safari`, and `npm run test:safari`
  (23/23 in real Safari). That last script no longer exists — it went with the OPFS backend, and the
  gate that replaced it is `npm run test:jsc` ([README.md](../README.md) → Commands).
- Note: `test:ts:test` and `eslint` were **red at `56658cf5`** (test tsc could not resolve
  `test/safari/worker.js`'s server-absolute `/ext/…` imports; 22 lint errors in `test/safari/`),
  despite that session's notes claiming green. Both are fixed as of the zstd work — the test tsconfig
  maps `/ext/*` → `../ext/*`, so those files are now genuinely type-checked.

## Stage 0 — DONE

- `@sqlite.org/sqlite-wasm` (^3.53.0) added to `package.json`. Vendored into `ext/lib` by
  `dev/build-libs.js` → `copySqlite()`: copies `dist/index.mjs`→`ext/lib/sqlite3.js` and
  `dist/sqlite3.wasm`. (`ext/lib/*` is gitignored / generated at build.)
- Safari CSP fixed in `dev/data/manifest-variants.json`: the safari-variant `extension_pages`
  `script-src` `'unsafe-eval'` → `'wasm-unsafe-eval'`.
- `ext/js/dictionary/payload-codec.js`: `IdentityPayloadCodec` (JSON serialize, no compression).
  Payload = `[definitionTags, rules, score, glossary, termTags]`.
- `ext/js/dictionary/dictionary-backend-config.js`: `export const USE_SQLITE_BACKEND = false`.
- `types/ext/dictionary-database.d.ts`: added `PayloadCodecName = 'identity'|'deflate'|'zstd'`.

## Stage 1 — DONE (term backend vertical slice)

- **Test harness de-risked** (`test/sqlite-backend-smoke.test.js`): SQLite-WASM inits in-memory
  under the vitest (node) runner; BLOB columns round-trip as `Uint8Array`; the codec survives a
  store/load through a BLOB; prefix range-scan works; the opener builds the full schema.
- **Env-aware opener** (`ext/js/dictionary/sqlite/open-sqlite.js`):
  `openDictionaryDatabaseHandle(sqlite3, {vfs, path?, initialCapacity?})`. `vfs:'opfs'` →
  `installOpfsSAHPoolVfs` + `OpfsSAHPoolDb`; `vfs:'memory'` → `new sqlite3.oo1.DB(':memory:')`.
  Sets `page_size`/`synchronous`/`temp_store`, then creates the schema. **`sqlite3` is injected**
  (not imported here) — see [decisions.md](../decisions.md) #10.
- **Schema** (`ext/js/dictionary/sqlite/dictionary-sqlite-schema.js`): `createDictionarySchema(db)`
  runs the DDL (`dictionaries, terms, term_meta, kanji, kanji_meta, tag_meta, media`) and sets
  `PRAGMA user_version = DICTIONARY_SQLITE_SCHEMA_VERSION` (=1). Exports `DICTIONARY_SQLITE_TABLES`.
  Naming: `sort_order` (not the reserved `order`), `summary_json`/`data_json`, `payload BLOB`.
- **Term backend core** (`dictionary-database-sqlite.js`): `bulkAdd('terms')` resolves/creates the
  integer `dictionary_id` from the row's title, encodes the payload, and inserts via a prepared
  statement inside one transaction per batch; ids autoincrement in insertion order. Reads rebuild
  `TermEntry` with the exact shaping of `_createTerm` (incl. the `visited`-by-id dedup and the
  matchSource/matchType rules of `_createTermGeneric`). Prefix uses the inclusive
  `expression >= ? AND expression <= ? || char(65535)` bound (BMP-valid); suffix filters in JS.
- **Types**: `types/ext/sqlite-wasm.d.ts` (narrow oo1 surface) and `types/ext/payload-codec.d.ts`.
- **Parity test** (`test/dictionary-database-sqlite.test.js`, 6 tests): imports the fixture into the
  real IndexedDB backend, copies the packed term rows (in id order) into an in-memory SQLite
  backend, and asserts the term queries match, order-insensitively.

## Stage 2 — DONE (full parity, node-verified)

- **Full backend parity** (`DictionaryDatabaseSqlite`): every public method the importer and
  translator use — `bulkAdd` for all stores (one prepared statement per batch inside a
  transaction), `addWithResult` (returns a minimal IndexedDB-style request the importer awaits),
  `bulkUpdate('dictionaries')`, `findTermsBulk`/`findTermsExactBulk`/`findTermsBySequenceBulk`,
  `findTermMetaBulk`, `findKanjiBulk`/`findKanjiMetaBulk`, `findTagMetaBulk`/`findTagForTitle`,
  `getMedia`, and admin (`prepare`/`isPrepared`/`close`/`purge`/`dictionaryExists`/
  `getDictionaryInfo`/`getDictionaryCounts`/`deleteDictionary`). Result builders mirror
  `DictionaryDatabase._create*`. Meta/tag rows use plain columns + `data_json`; kanji/term payloads
  go through the codec BLOB.
- **End-to-end fixture parity** (`test/translator-sqlite.test.js`): the real `DictionaryImporter`
  imports the `Test Dictionary 2` fixture into the SQLite backend and the `Translator` runs every
  `translator-test-inputs.json` case; `dictionaryEntries` match the canonical
  `translator-test-results.json` exactly. `test/fixtures/translator-test.js` gained a
  `backend: 'indexeddb'|'sqlite'|'sqlite-deflate'` parameter (default unchanged).

## Stage 3 — DONE for deflate; zstd is a separate outstanding task

See **[zstd.md](zstd.md)** for the remaining (blocked) zstd work and the size targets.

- **Codec self-description**: the backend takes a write codec + optional decode codecs and keeps a
  per-dictionary `{codec, dict}` cache. On import it resolves/trains the write codec per dictionary
  (`_ensureWriteCodecs`, run **before** the sync insert transaction because `train()` is async),
  persisting `codec` + `codec_dict` on the dictionaries row. On read, `_getDictCodec` derives the
  codec from the row's `codec` column (null == identity) and passes the cached `codec_dict`.
  Identity stays the default and leaves `codec` null, so the identity path is byte-identical.
- **DeflatePayloadCodec** (`ext/js/dictionary/deflate-payload-codec.js`): raw DEFLATE via pako,
  optional 32 KB preset dictionary from `train()` (~3.55×); pako injected
  (`types/ext/pako.d.ts` for types), vendored to `ext/lib/pako.js` via `dev/lib/pako.js` (esbuild),
  `pako` pinned in package.json.
- **Tests**: `deflate-payload-codec.test.js` (round-trips every payload shape ± trained dict,
  compression vs identity, dict size cap); `dictionary-database-sqlite-codec.test.js` (rows decode
  after dropping the write-time codec cache, i.e. derived from the `codec` column);
  `translator-sqlite.test.js` runs all 49 fixtures against **both** the identity and deflate
  backends (98 tests).

## Stage 4 — DONE (wiring, migration, tuning). Flag still OFF

- **Backend selection** (`ext/js/dictionary/dictionary-database-factory.js`):
  `createDictionaryDatabase()` returns the backend chosen by `USE_SQLITE_BACKEND`. Wired into all
  three sites that construct the real database: `background/backend.js` (non-offscreen path),
  `background/offscreen.js`, and `dictionary/dictionary-database-worker-handler.js` (the DB worker).
  With the flag **off** these return exactly `new DictionaryDatabase()` — behavior unchanged, no
  SQLite/WASM touched at runtime.
- **`DictionaryDatabaseSqlite.prepare()` is a drop-in**: called with no arguments it loads the
  vendored `ext/lib/sqlite3.js`, opens the OPFS SAH-Pool VFS, and calls
  `navigator.storage.persist()`. Tests inject `sqlite3` + `vfs: 'memory'`. The dynamic import keeps
  the WASM out of the graph unless the SQLite backend is selected.
- **Migration helpers** (`ext/js/dictionary/sqlite/dictionary-storage-migration.js`):
  `legacyIndexedDbDictionaryExists()` (probes without leaving an empty DB behind),
  `deleteLegacyIndexedDbDictionary()` (reclaims the ~1.2 GB after re-import), and
  `requestPersistentStorage()`. Tested against fake-indexeddb.
- **Tuning**: `finalizeImport()` (ANALYZE + VACUUM); `PRAGMA page_size = 8192` in the opener before
  the schema (fresh DBs only, so no VACUUM needed).
- **Real-Safari test runner** (`test/safari/`, `npm run test:safari`): serves the repo on
  `127.0.0.1` (a secure context → OPFS works) and opens it with `open -g -a Safari`, which uses real
  Safari **without stealing focus**; an in-page module worker runs the backend against the real
  vendored WASM and posts results back. 12/12 green. See
  `test/safari/README.md` (deleted with the OPFS backend).
- **Build verified**: `npm run build -- --target safari` ships `lib/sqlite3.js`, `lib/sqlite3.wasm`
  (865 KB), `lib/pako.js`; the safari manifest CSP has `'wasm-unsafe-eval'`.

## Codec — DECIDED: deflate ships; zstd built, measured, rejected, removed

Full record in **[zstd.md](zstd.md)**. The Stage 3 blocker ("needs a custom zstd WASM build") is
resolved; the remaining question is a shipping decision, not an engineering one.

**All of the zstd implementation below was removed** in the same change that selected deflate
([decisions.md](../decisions.md) #26); it lives in git history at `58fe1f50`. Kept here as the
record of what was tried and what it cost.

- **Custom WASM build** (was `dev/zstd/`): `build.sh` downloaded the official zstd 1.5.7 tarball,
  verified its sha256, and compiled it with emscripten together with `shim.c` — a thin 32-bit-clean
  C shim (`yz_*`) that kept zstd's `size_t`/`u64` returns from crossing into JS as BigInt and reused
  the CCtx/DCtx. The custom build was genuinely necessary: no published zstd WASM package exposes
  `ZDICT_trainFromBuffer` (verified — `@bokuweb/zstd-wasm` and `zstd-codec` contain no `ZDICT_*`
  symbols at all).
- **The build script was committed, not the artifact** ([decisions.md](../decisions.md) #21):
  `dev/vendor/` was gitignored like `ext/lib/`, so a fresh clone ran `npm run build:zstd` once
  (needs emscripten) before the zstd tests or a build. There is no CI to serve, so a local cache
  sufficed.
- **`ZstdPayloadCodec`** (`ext/js/dictionary/zstd-payload-codec.js`): module injected as usual;
  CDict/DDict compiled once per dictionary (WeakMap), never per row; `train()` returns empty when
  ZDICT refuses a too-small corpus, which the backend already maps to "no dictionary".
- **New interface hook `PayloadCodec.prepare?()`** ([decisions.md](../decisions.md) #22), awaited
  by `DictionaryDatabaseSqlite.prepare()` for every registered codec — `encode`/`decode` are sync but
  WASM init is not, and a read path never calls `train()`.
- **Level 15, not 19** ([decisions.md](../decisions.md) #23): the ratio plateaus at 15 while 19
  costs ~3× the encode time.
- **Tests**: `zstd-payload-codec.test.js` (12); a 2,000-row zstd import in
  `dictionary-database-sqlite-codec.test.js` asserting the trained dictionary is persisted to
  `codec_dict` and read back through it after the cache is dropped; all 49 translator fixtures
  through `sqlite-zstd` (147 = 49 × 3); 17/17 in real Safari.
- **Measured on the real `kty-de-en`** (`npm run measure:storage`, `dev/measure-storage.js`; downloads the
  24 MB dictionary into the gitignored `dictionaries/` and caches it, checksum-pinned). 947,070 rows,
  253.9 MB of payload. Headline: **the design's 5.52× / ~46 MB does not reproduce**, and with the
  plan's own parameters (110 KB dictionary) zstd _loses_ to deflate — 3.15× vs 3.55×. deflate
  reproduces the design's 3.55× exactly, which is what makes the zstd result trustworthy rather than
  a setup difference. Sizing the dictionary properly (1.9 MB, trained on 200k rows) gives
  **4.47× / 56.8 MB** at −15 (4.63× / 54.9 MB at −19), and decode is **~8× faster than deflate**
  (2.7 vs 21.4 µs/row) — within 1 µs/row of raw JSON — with dictionary size costing nothing on
  decode. So the codec that saves the most also reads the fastest; deflate is the slow one on the
  query path. Full tables and the open decision in [zstd.md](zstd.md).
- **Tunable rather than baked in** ([decisions.md](../decisions.md) #24, #25):
  `DictionaryDatabaseSqlite` takes `trainSampleSize`, and `measure:storage` takes
  `--train/--rows/--db`. The tradeoff is a judgement call, so it should be re-derivable rather than
  argued from memory.
- **Found: `_trainSampleSize = 4000` was unreachable.** The importer's `maxTransactionLength` is 1000
  and training runs on the first `bulkAdd` batch, so the trainer only ever saw 1000 rows (→ 3.05×,
  worse than deflate). The default now states that real limit; raising it means buffering more of the
  import before the first insert, which is the actual cost of choosing zstd.

## Sizing work queue — do these in order

From [sizing.md](sizing.md). Ordered by ascending risk, and each is independently shippable, so
stopping after any one leaves the tree in a good state. Decisions: #32, #28, #31.

1. **Cache the term-query prepared statements** ([decisions.md](../decisions.md) #32) —
   `findTermsBulk` loops per term calling `selectObjects`, which prepares **and finalises** a
   statement per call. ~85% of query time is that overhead, not index seeks (434 candidates:
   9.44 → 1.52 ms). Affects the backend as shipped. Small and self-contained; no schema change, no
   behaviour change. **— DONE.**
2. **Drop the degenerate indexes** ([decisions.md](../decisions.md) #28) — drop
   `ix_terms_dictionary` (a strict prefix-duplicate of `ix_terms_sequence`, redundant on every
   dictionary) and make `ix_terms_reading` partial (`WHERE reading <> ''`). **Measured −17.0 MB,
   149.7 → 132.7 MB**, no capability lost. (Not −26.5: that figure counted `ix_terms_sequence` too,
   which #29 defers pending the `sequence = 0` semantics call — a further −9.5 MB.) Needs a
   schema-version bump and the literal `AND reading <> ''` in
   the reading probe — without it the existing `INDEXED BY` fails with `no query solution` rather
   than falling back. **— DONE, and then HALF RETRACTED.** The `ix_terms_dictionary` drop is real
   and live. The `reading <> ''` half is not: the importer rewrites an empty reading to the
   expression, so no row ever had `reading = ''` and the predicate excluded nothing — the −17.0 MB
   above is ~8.5 MB of fiction, measured on rows a harness wrote and the importer never produces.
   The shipped predicate is **`reading <> expression`** (schema v5). See
   [decisions.md](../decisions.md) #35 (the correction) and #36 (what replaced it); the current
   behaviour is [design.md](../design.md) → Schema.
3. **Rule-derived inflections** ([decisions.md](../decisions.md) #31) — replace the derivable
   subset of the 852,139 form-of stub rows with induced `(prefix,suffix)` rules + paradigm classes.
   **~46 MB at K=1,000 (~0.2 ms/hover) down to ~20 MB at K=70,247 (~3.4 ms/hover)**, benchmarked
   ([sizing.md](sizing.md) §5.4). **Not blocked on UX after all**: form-of rows never render —
   they are pure deinflection pointers, and the label-set table reproduces their chip text, so the
   only visible change is the inflection chain's `source`. ~~The real work is architectural: the
   rules are derived per dictionary and live in the database, while algorithm deinflections come from
   `MultiLanguageTransformer`, which is language-static and built at construction; and dropping the
   stub rows removes what `_getDictionaryDeinflections` reads, so both paths change together.~~
   **That was wrong** — it assumed the rules had to enter as _algorithm_ transforms. They compress
   the **dictionary** deinflection path, which is driven entirely by what `findTermsBulk` returns, so
   the backend synthesizes the dropped rows on lookup and the translator does not change at all. See
   [decisions.md](../decisions.md) #34. Import also has to pay the induction (LCS over 2.17M
   pairs) — measured at **3.1s**, negligible against a multi-minute import. **Decided: K = 1,000**
   (~46 MB at ~0.2 ms/hover), staged.

   - **Stage A1 — DONE:** `ext/js/dictionary/sqlite/inflection-rules.js` + `test/inflection-rules.test.js`
     (13 tests). Pure functions: `induceInflectionRule` / `applyInflectionRule` (core = longest
     common substring, affix change either side, whole-word fallback for zero overlap),
     `buildInflectionTable` (rank by lemma count, cut to `ruleBudget`), `isDerivable`,
     `deriveLemmas`. Validated against the real dictionary: it reproduces the analysis exactly —
     **70,247 rules, 82,661 paradigms, 76.6% of stub rows derivable at K=1,000** (analysis: 70,247 /
     82,661 / 76%).
   - **Stage A2 — DONE:** schema v3 adds `dictionaries.inflection_table`, a BLOB encoded through the
     same payload codec as the rows (compressed: as SQLite rows the same data would be ~11–15 MB and
     eat a third of the win). `finalizeImport()` induces it per dictionary by decoding the stub rows
     back — ranking needs every pair before it can pick any rule, and the importer streams. No rows
     are dropped yet, so this is inert: the table is written and read, nothing consumes it.
     Measured on the real dictionary, importing all 947,070 rows:
     - **The stored table is 1.42 MB, not the projected ~0.3 MB** — a 4.7× miss. The projection
       deflated a compact text format; the real one goes through the payload codec as JSON, whose
       brackets and quotes do not compress away. It barely moves the bottom line (K=1,000 lands at
       ~47 MB rather than ~46) but the sub-number was wrong and is corrected here.
     - **`finalizeImport` now costs 69.6s** on `kty-de-en` (induction + ANALYZE + VACUUM), against a
       multi-minute import. Acceptable, but it is a new cost and the importer does not call
       `finalizeImport` yet at all (item 3 of Stage 5 below).
     - **Soundness holds on real data**: 85.8% of the 2,170,986 pairs are derivable at K=1,000, and
       over 20,000 forms the table derived 88,399 results with **0 the dictionary does not state**.
       That is the property Stage B depends on.
   - **Stage B — DONE:** schema v4 adds `dictionaries.stub_template`. `finalizeImport()` now deletes
     the form-of rows the rules reproduce, and `findTermsBulk` synthesizes them back on an exact
     probe. **The translator does not change at all** — the rules compress the _dictionary_
     deinflection path, which `findTermsBulk` alone feeds, so nothing reaches
     `MultiLanguageTransformer`. See [decisions.md](../decisions.md) #34 for why the recorded
     blocker was wrong. Measured **through the real `DictionaryImporter`**, one backend, uncontended:
     - **947,070 → 293,262 rows, 170.5 → 56.8 MB at schema v4** (→ **49.4 MB** once #36 empties the
       reading index, so **−71%** end to end). The rules cost 1.42 MB and the template 17 B. (Earlier
       notes said 136.65 → 44.56 MB — those came from a terms-only harness that also wrote
       `reading: ''`, understating the total; see #35.)
     - **Correctness checked against the ZIP, not against a second copy of the same code**: for each
       of 41,921 sampled forms, the `[lemma, labels]` pointers a lookup yields versus the ones the
       dictionary states — **100.00% exact, 0 lost, 0 invented**.
     - **`finalizeImport` costs 124.0s** on top of a 152.0s import (was 0.6s with induction off; the
       drop pass adds a second full decode of every payload, ~120s of the 124, fusable). The DELETEs
       are 1.3s, i.e. noise.
     - **Four timing/size claims were retracted getting here** (2086s, 436s, ~125s, 300.4s; and every
       terms-only MB figure) — all from measuring a contended machine, a harness, or the wrong input
       rather than the code through the real importer. See #34's and #35's measurement traps.
     - Known gap, tested and accepted: **a wildcard lookup cannot see a dropped form**, since a
       wildcard asks which _stored_ forms match a pattern. The hover path is `matchType: 'exact'`.
     - Coverage: `test/dictionary-database-sqlite-inflection.test.js` (12 tests) imports a real
       fixture dictionary through the real importer, with induction off and on, and asserts the
       lookups agree. It now drives the importer rather than hand-writing rows — the previous
       hand-written version wrote `reading: ''`, which the importer never produces, and so the drop
       pass silently dropped nothing on real imports while the tests stayed green (#35).

## Stage 5 — item 1 PASSES; the flag is now ON ([backend-worker.md](backend-worker.md))

Extension-origin verification (item 1) found that the SQLite backend cannot open OPFS in the Safari
background page (sync access handles are Worker-only). **Fixed**: a **dedicated** worker owns the
single OPFS connection and page contexts proxy to it; imports keep their own worker and the
background lets go for the duration via `suspendDatabase`/`resumeDatabase`. (A SharedWorker hub was
built first and **retracted** — it constructs but never connects in Safari web-extension pages; see
[backend-worker.md](backend-worker.md) → RETRACTED.) `npm run test:safari` covers both sides of the
seam — **23/23** — and the flag is now on and verified in the installed extension.

**A second, larger blocker then surfaced: the imported dictionary does not survive a Safari
restart.** Safari regenerates the extension's origin UUID on every launch and OPFS is partitioned by
origin — [safari-opfs-blocker.md](safari-opfs-blocker.md).

**That has redirected the project.** Rather than work around it in the browser, the engine moves into
the native app and the extension becomes display and UI: [native-rewrite.md](../native-rewrite.md),
made viable by the bridge measuring ~1 ms / ~60 MB/s
([native-engine-probe.md](../native-engine-probe.md)). Stage 5 as written below is therefore largely
**superseded** — the in-browser import path, the suspend/resume dance and the dual-backend flag are
all things the native direction deletes rather than finishes. The smaller in-browser fix
([safari-idb-snapshot.md](safari-idb-snapshot.md)) was the fallback at the time and is now
**abandoned** — the OPFS storage layer it patched has since been deleted. Items 2, 3, 6 are done;
the codec and measurement are decided, and the schema, codec and inflection work all carry over
unchanged — they are re-hosted, not rewritten.

1. **Extension-origin verification — RAN, and it found a blocker.** `npm run test:safari` covers the
   engine (OPFS, the vendored WASM, the whole backend) but runs on `127.0.0.1`, not
   `safari-web-extension://…`. Driving the _real installed extension_ (flag on, `kty-de-en` imported)
   over the `open -g` + AppleScript `do JavaScript` channel exposed a **real architectural bug the
   test suite structurally cannot see** (it runs the backend inside a worker; the extension runs the
   background in a **page**): **the SQLite backend cannot open OPFS in the Safari background page.**
   The import succeeds (its own worker; OPFS file lands at the exact 49.4 MB), but the background
   page's `DictionaryDatabaseSqlite.prepare()` fails — `createSyncAccessHandle` is `undefined` off a
   Worker — so every lookup is "Database not open". **Full root cause + the proposed fix (run the
   backend in one dedicated DB worker, background proxies to it) is [backend-worker.md](backend-worker.md).**
   Until that lands, the flag cannot flip. Everything below (the automation channel, the manual
   gate) still holds and is how the fix will be verified.
   - **Automation feasibility — resolved: it is scriptable.** The `open -g -a Safari` + `do
JavaScript … in <tab>` channel (DEV.md) is verified end to end — including on
     `safari-web-extension://…` extension pages, which is how the bug above was diagnosed (read
     `getDictionaryInfo`'s error + stack straight out of the running background). A run can also
     synthesize a scan and read whether `iframe.yomitan-popup` appeared.
   - The residual manual part is **Apple's security gate, not the tooling**: the extension must be
     enabled + host-permitted in Safari Settings once (do not synthesize those clicks) and a
     dictionary imported once; both persist across `rebuild-safari.sh` (it updates the bundle in
     place so Safari treats it as an update rather than an uninstall + reinstall). _Why that matters
     changed with the native move: it used to protect the dictionary, which lived in the extension's
     website data. The dictionary now lives in the app container and is not at risk either way; what
     in-place updating still protects is the enablement and host permissions above. See
     [DEV.md](../../DEV.md) → The native engine._
2. **Settings-page migration UX** — DONE. `DictionaryStorageMigrationController`
   (`ext/js/pages/settings/dictionary-storage-migration-controller.js`, wired in `settings-main.js`)
   calls `legacyIndexedDbDictionaryExists()` on settings load and, when a populated legacy `dict` is
   found, reveals a notification at the top of the Dictionaries section asking the user to re-import
   (the normal import UI is right there) plus a **Reclaim old storage** button. The button opens a
   danger confirm modal (`#dictionary-legacy-storage-confirm-delete-modal`) →
   `deleteLegacyIndexedDbDictionary()` → hides the notification and fires `storageChanged` so the
   figures refresh. **Inert while the flag is off**: `prepare()` returns immediately when
   `USE_SQLITE_BACKEND` is false, because the legacy store _is_ the live store then — nothing to
   migrate. The load-bearing detect/reclaim helpers are exercised against WebKit's own IndexedDB by
   three new `test:safari` checks (15/15), since its `databases()`/upgrade semantics differ from the
   node fake-indexeddb the helper unit tests use. The re-import itself is the existing dictionary UI;
   this only detects, points, and reclaims.
3. **Call `finalizeImport()`** after an import completes — DONE. `DictionaryImporter.importDictionary`
   calls `dictionaryDatabase.finalizeImport()` once the rows and summary are written, only on
   `importSuccess`, catching into `errors` so a finalize failure does not lose the import. The
   IndexedDB backend gained a no-op `finalizeImport()` so the call is backend-agnostic; on SQLite it
   induces rules, drops derivable rows, and `ANALYZE`/`VACUUM`s. **Also fixed a Stage-4 wiring gap:**
   `dictionary-worker-handler.js` (the import/delete worker — distinct from the DB-worker handler)
   still built `new DictionaryDatabase()` directly, so imports never hit the selected backend; it now
   goes through `createDictionaryDatabase()`. Exercised by `dictionary-database-sqlite-inflection`
   (drives the real importer, no manual `finalizeImport`) and confirmed in real Safari (12/12).
4. **Real-data measurement** — DONE (`npm run measure:storage -- --db`): **149.7 MB** total with
   deflate, of which **78.1 MB is indexes (49.5) + table row overhead (28.5)** — the earlier "~78 MB
   of indexes" credited all of it to indexes. Fully broken down per B-tree in
   [sizing.md](sizing.md), which also found **26.5 MB of degenerate index** (17.0 of it dropped
   in schema v2, [decisions.md](../decisions.md) #28) and that **90% of the rows are inflected-form
   stubs** worth 60.5 MB of the 71.5 MB payload (#30). The ~100 MB target is unreachable by
   compression; the work is the schema and the dictionary's shape.
5. **Pick the shipped codec** — DONE: deflate ([decisions.md](../decisions.md) #26). The factory
   builds `new DictionaryDatabaseSqlite(new DeflatePayloadCodec())`; the codec self-loads vendored
   pako in `prepare()`, so nothing extra enters the module graph while the flag is off.
6. **SAH-Pool capacity growth** for large DBs — DONE. The opener default is now **16** slots (was 8),
   and after installing the pool it calls `reserveMinimumCapacity(16)` when the existing capacity is
   lower — `reserveMinimumCapacity` (not `addCapacity`) because it only grows when below the target
   and persists, so a pool an older build created too small is healed on the next open without
   ratcheting every startup. The whole store is one DB file, but a large import also needs slots for
   its rollback journal and any transient file `VACUUM` opens; 16 is comfortable headroom over the
   one-or-two-file SAH default. Only the OPFS branch runs this (tests use `vfs:'memory'`); confirmed
   in real Safari (`test:safari`, 12/12, incl. `finalizeImport`'s VACUUM on OPFS). Type surface gained
   `getCapacity` / `reserveMinimumCapacity`.
7. Then: remove the IndexedDB path for `dict` + the flag, and unify the two backends behind one
   interface (today the SQLite backend is cast to `DictionaryDatabase` at the factory/test seams).

## Query plans — a full scan on every lookup (FIXED; the diagnosis was later corrected)

Found while measuring the real dictionary. **The fix is live and the pin is deliberate, but the cause
recorded below was measured on rows the importer never produces** — see
[decisions.md](../decisions.md) #35. Kept because it is the record of how the `INDEXED BY` pin got
there, and because the measurement trap is the reusable lesson. The current query strategy, stated
once, is [design.md](../design.md) → Query strategy.

- **Symptom**: `findTermsBulk` cost **~75 ms per lookup** on the real 947k-row `kty-de-en` — on the
  hover path — while the same SQL run by hand took 0.043 ms.
- **Cause, as diagnosed at the time — REFUTED**: `findTermsBulk` probes the `expression` column _and_
  the `reading` column, and every row of a German dictionary was believed to have `reading = ''`
  (readings are a Japanese concept), making `ix_terms_reading` completely unselective
  (`sqlite_stat1 = 947070 947070`) so the planner preferred a full scan. **That premise is gone**:
  `_convertTermBankEntryV3` rewrites an empty reading to the expression, so through the real importer
  the statistic is `947070 1` — perfectly selective — and the planner picks the index unaided
  ([decisions.md](../decisions.md) #35). The ~75 ms was real; what produced it was harness rows, not the
  product's.
- **Why IndexedDB never had it**: no query planner. An IDB index probe always seeks, which is exactly
  what these queries want.
- **Fix, and why it stays**: `_queryTermColumn` pins the column's index with `INDEXED BY` for the
  exact and prefix probes. **75.6 ms → 0.064 ms per lookup** (~1200×), identical results. The pin is
  kept even though its original premise is gone — it guarantees the seek IndexedDB gave for free
  rather than leaving a hover-path plan to the planner's discretion ([decisions.md](../decisions.md)
  #36). Suffix still scans on purpose (no reverse column, so no index can serve it).
- **Regression test**: `test/dictionary-database-sqlite-query-plan.test.js` captures the SQL the
  backend actually issues, runs `EXPLAIN QUERY PLAN` on it, and asserts `SCAN terms` never appears,
  and it demonstrably fails when the `INDEXED BY` is removed. It **used** to build all-empty-reading
  rows and assert a `sqlite_stat1` of `'0 0'` — the shape that made the diagnosis above wrong; it now
  builds `reading === expression` rows and asserts the partial index holds only the distinct-reading
  ones. Correctness tests cannot catch this class of bug — results are identical either way, only the
  plan differs.
- **Same class, unverified**: the `term_meta` / `kanji` / `kanji_meta` equality probes let the planner
  choose too. Their columns are selective on real data, so they are not known to be affected, but a
  dictionary that made one degenerate would hit the same cliff.

## Watch-outs that no longer bind

Properties of running the engine inside the extension. Kept because they are exactly the class of
surprise to expect again from a native host, and because nothing now watches for them: the runner
that caught two of these (`npm run test:safari`) was deleted with the OPFS backend, and
`npm run test:jsc` exercises a different host with different traps. The watch-outs that **do** still
bind are in [../design.md](../design.md) → Watch-outs.

- **OPFS does not survive a Safari restart in a web extension — the blocker that redirected the
  project.** The extension's origin UUID is regenerated on **every launch of Safari**, by design (an
  Apple anti-fingerprinting measure), and OPFS is partitioned by that origin, so every launch strands
  the imported dictionary. `localStorage`, IndexedDB and `chrome.storage.local` are exempt — WebKit
  keeps those under a stable identity. Measured, and settled: see
  [safari-opfs-blocker.md](safari-opfs-blocker.md). The SQLite engine itself was never affected, only
  where its bytes lived.
- **sqlite3 had to be a singleton.** `installOpfsSAHPoolVfs` caches its pool per VFS name _inside one
  sqlite3 instance_, and the pool holds exclusive OPFS sync access handles. A second
  `sqlite3InitModule()` call builds an independent runtime that cannot acquire them →
  `InvalidStateError` on any close/reopen (e.g. `purge()`). `loadVendoredSqlite3()` memoized it.
  Caught by the since-deleted `npm run test:safari`; invisible to node.
- **`.wasm` MIME in Safari**: extension `.wasm` is served without `application/wasm`, so
  `instantiateStreaming` fails and sqlite fell back to ArrayBuffer instantiation. Worked, slightly
  slower. The zstd module avoided it entirely by embedding its wasm (`-sSINGLE_FILE`); any _further_
  WASM in an extension would need the fallback again.
- **Don't hand a WASM-heap view to a web API.** Safari's `TextDecoder` throws a `TypeError` on a
  `subarray` view backed by growable WASM memory, where node accepts it happily; copy out with
  `slice` first. The second real bug the since-deleted `npm run test:safari` found that node could
  not see. The same caution applies to any view handed across an API boundary, and views must never
  be cached across an allocation (growth detaches them). **Moot once there is no WASM** — the native
  engine uses system libsqlite3 — which is why it is here rather than in the live list.

## What the refactor deleted

The files the in-browser build added and the native direction then removed. Named here because older
notes point at them and a reader who greps will otherwise wonder whether they are missing by mistake.
The current tree's map is in [../design.md](../design.md) → Reference.

```
ext/js/dictionary/dictionary-backend-config.js          USE_SQLITE_BACKEND flag
ext/js/dictionary/dictionary-database-factory.js        createDictionaryDatabase() backend selection
ext/js/dictionary/dictionary-database.js                the IndexedDB backend itself
ext/js/dictionary/sqlite/dictionary-storage-migration.js  legacy-IDB detect/delete, persist
ext/js/pages/settings/dictionary-storage-migration-controller.js  settings-page migration UX
ext/js/dictionary/sqlite/database-owner-client.js       RPC client; background -> owner worker
ext/js/dictionary/dictionary-database-worker-handler.js owner-side dispatch for that RPC
ext/js/dictionary/dictionary-worker.js                  suspend/resume around imports
ext/js/background/offscreen.js                          the Chrome offscreen document
ext/js/background/backend.js                            _onApiSuspendDatabase / _onApiResumeDatabase
                                                        (the file lives; those two APIs are gone)
ext/lib/sqlite3.js, ext/lib/sqlite3.wasm                the vendored SQLite-WASM build
ext/lib/pako.js, dev/lib/pako.js                        the vendored pako (bundled twice; see #12)
types/ext/dictionary-database-sqlite.d.ts               OwnerParams / WorkerRequest / WorkerResponse
test/safari/                                            real-Safari runner (run.js, harness.html,
                                                        worker.js) + npm run test:safari
test/dictionary-database-sqlite.test.js                 term parity vs the IndexedDB backend
test/dictionary-storage-migration.test.js               migration helpers
dev/zstd/, ext/js/dictionary/zstd-payload-codec.js      the zstd codec and its build (#26)
```

Two that survived in a changed role rather than being deleted: `dev/build-libs.js` lost its pako
vendoring and its `copySqlite()` but still serves resvg, zip and handlebars; and
`dev/data/manifest-variants.json`'s safari CSP `'wasm-unsafe-eval'` was added for `sqlite3.wasm` and
is still required, now only by `ext/lib/resvg.wasm`.
