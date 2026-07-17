# Progress log

Living status of the storage-backend refactor. Update this every work session. Stages are ordered
oldest → newest. Full design in [01-design.md](01-design.md); decisions in
[02-decisions.md](02-decisions.md); why zstd was rejected in [zstd/](zstd/README.md).

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
- Green: `tsc` (main + test), repo-wide `eslint`, full `vitest` (4296 tests / 46 skipped),
  `npm run build -- --target safari`, and `npm run test:safari` (17/17 in real Safari).
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
  (not imported here) — see [02-decisions.md](02-decisions.md) #10.
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

See **[zstd/](zstd/README.md)** for the remaining (blocked) zstd work and the size targets.

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
  [test/safari/README.md](../test/safari/README.md).
- **Build verified**: `npm run build -- --target safari` ships `lib/sqlite3.js`, `lib/sqlite3.wasm`
  (865 KB), `lib/pako.js`; the safari manifest CSP has `'wasm-unsafe-eval'`.

## Codec — DECIDED: deflate ships; zstd built, measured, rejected, removed

Full record in **[zstd/](zstd/README.md)**. The Stage 3 blocker ("needs a custom zstd WASM build") is
resolved; the remaining question is a shipping decision, not an engineering one.

**All of the zstd implementation below was removed** in the same change that selected deflate
([02-decisions.md](02-decisions.md) #26); it lives in git history at `58fe1f50`. Kept here as the
record of what was tried and what it cost.

- **Custom WASM build** (was `dev/zstd/`): `build.sh` downloaded the official zstd 1.5.7 tarball,
  verified its sha256, and compiled it with emscripten together with `shim.c` — a thin 32-bit-clean
  C shim (`yz_*`) that kept zstd's `size_t`/`u64` returns from crossing into JS as BigInt and reused
  the CCtx/DCtx. The custom build was genuinely necessary: no published zstd WASM package exposes
  `ZDICT_trainFromBuffer` (verified — `@bokuweb/zstd-wasm` and `zstd-codec` contain no `ZDICT_*`
  symbols at all).
- **The build script was committed, not the artifact** ([02-decisions.md](02-decisions.md) #21):
  `dev/vendor/` was gitignored like `ext/lib/`, so a fresh clone ran `npm run build:zstd` once
  (needs emscripten) before the zstd tests or a build. There is no CI to serve, so a local cache
  sufficed.
- **`ZstdPayloadCodec`** (`ext/js/dictionary/zstd-payload-codec.js`): module injected as usual;
  CDict/DDict compiled once per dictionary (WeakMap), never per row; `train()` returns empty when
  ZDICT refuses a too-small corpus, which the backend already maps to "no dictionary".
- **New interface hook `PayloadCodec.prepare?()`** ([02-decisions.md](02-decisions.md) #22), awaited
  by `DictionaryDatabaseSqlite.prepare()` for every registered codec — `encode`/`decode` are sync but
  WASM init is not, and a read path never calls `train()`.
- **Level 15, not 19** ([02-decisions.md](02-decisions.md) #23): the ratio plateaus at 15 while 19
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
  query path. Full tables and the open decision in [zstd/](zstd/README.md).
- **Tunable rather than baked in** ([02-decisions.md](02-decisions.md) #24, #25):
  `DictionaryDatabaseSqlite` takes `trainSampleSize`, and `measure:storage` takes
  `--train/--rows/--db`. The tradeoff is a judgement call, so it should be re-derivable rather than
  argued from memory.
- **Found: `_trainSampleSize = 4000` was unreachable.** The importer's `maxTransactionLength` is 1000
  and training runs on the first `bulkAdd` batch, so the trainer only ever saw 1000 rows (→ 3.05×,
  worse than deflate). The default now states that real limit; raising it means buffering more of the
  import before the first insert, which is the actual cost of choosing zstd.

## Sizing work queue — do these in order

From [sizing/](sizing/README.md). Ordered by ascending risk, and each is independently shippable, so
stopping after any one leaves the tree in a good state. Decisions: #32, #28, #31.

1. **Cache the term-query prepared statements** ([02-decisions.md](02-decisions.md) #32) —
   `findTermsBulk` loops per term calling `selectObjects`, which prepares **and finalises** a
   statement per call. ~85% of query time is that overhead, not index seeks (434 candidates:
   9.44 → 1.52 ms). Affects the backend as shipped. Small and self-contained; no schema change, no
   behaviour change. **— DONE.**
2. **Drop the degenerate indexes** ([02-decisions.md](02-decisions.md) #28) — drop
   `ix_terms_dictionary` (a strict prefix-duplicate of `ix_terms_sequence`, redundant on every
   dictionary) and make `ix_terms_reading` partial (`WHERE reading <> ''`). **Measured −17.0 MB,
   149.7 → 132.7 MB**, no capability lost. (Not −26.5: that figure counted `ix_terms_sequence` too,
   which #29 defers pending the `sequence = 0` semantics call — a further −9.5 MB.) Needs a
   schema-version bump and the literal `AND reading <> ''` in
   the reading probe — without it the existing `INDEXED BY` fails with `no query solution` rather
   than falling back. **— DONE.**
3. **Rule-derived inflections** ([02-decisions.md](02-decisions.md) #31) — replace the derivable
   subset of the 852,139 form-of stub rows with induced `(prefix,suffix)` rules + paradigm classes.
   **~46 MB at K=1,000 (~0.2 ms/hover) down to ~20 MB at K=70,247 (~3.4 ms/hover)**, benchmarked
   ([sizing/](sizing/README.md) §5.4). **Not blocked on UX after all**: form-of rows never render —
   they are pure deinflection pointers, and the label-set table reproduces their chip text, so the
   only visible change is the inflection chain's `source`. The real work is architectural: the rules
   are derived **per dictionary** and live in the database, while algorithm deinflections come from
   `MultiLanguageTransformer`, which is **language-static and built at construction**; and dropping
   the stub rows removes what `_getDictionaryDeinflections` reads, so both paths change together.
   Import also has to pay the induction (LCS over 2.17M pairs) — measured at **3.1s**, negligible
   against a multi-minute import. **Decided: K = 1,000** (~46 MB at ~0.2 ms/hover), staged.

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
   - **Stage B — NOT STARTED:** skip derivable rows at import, load the rules into the translator,
     generate candidates + paradigm-verify. Both deinflection paths change together.

## Stage 5 — NOT STARTED: what is required before flipping `USE_SQLITE_BACKEND`

1. **Extension-origin verification.** `npm run test:safari` covers the engine (OPFS, the vendored
   WASM, the whole backend) but runs on `127.0.0.1`, not `safari-web-extension://…`. Still needs
   `./rebuild-safari.sh` + a manual pass: import a dictionary, scan German text, check
   popup/Anki/audio, and confirm the DB worker resolves `ext/lib/sqlite3.js` + `sqlite3.wasm` at the
   extension origin.
2. **Settings-page migration UX**: call `legacyIndexedDbDictionaryExists()` on startup, prompt for
   re-import, then `deleteLegacyIndexedDbDictionary()`. Only the helpers exist today; no UI.
3. **Call `finalizeImport()`** after an import completes (the importer does not call it yet).
4. **Real-data measurement** — DONE (`npm run measure:storage -- --db`): **149.7 MB** total with
   deflate, of which **78.1 MB is indexes (49.5) + table row overhead (28.5)** — the earlier "~78 MB
   of indexes" credited all of it to indexes. Fully broken down per B-tree in
   [sizing/](sizing/README.md), which also found **26.5 MB of degenerate index** (17.0 of it dropped
   in schema v2, [02-decisions.md](02-decisions.md) #28) and that **90% of the rows are inflected-form
   stubs** worth 60.5 MB of the 71.5 MB payload (#30). The ~100 MB target is unreachable by
   compression; the work is the schema and the dictionary's shape.
5. **Pick the shipped codec** — DONE: deflate ([02-decisions.md](02-decisions.md) #26). The factory
   builds `new DictionaryDatabaseSqlite(new DeflatePayloadCodec())`; the codec self-loads vendored
   pako in `prepare()`, so nothing extra enters the module graph while the flag is off.
6. **SAH-Pool capacity growth** for large DBs (`initialCapacity` default is 8 files).
7. Then: remove the IndexedDB path for `dict` + the flag, and unify the two backends behind one
   interface (today the SQLite backend is cast to `DictionaryDatabase` at the factory/test seams).

## Query plans — a full scan on every lookup (FIXED)

Found while measuring the real dictionary; nothing else could have caught it, and it would have made
the extension unusable.

- **Symptom**: `findTermsBulk` cost **~75 ms per lookup** on the real 947k-row `kty-de-en` — on the
  hover path — while the same SQL run by hand took 0.043 ms.
- **Cause**: `findTermsBulk` probes the `expression` column _and_ the `reading` column. Every row of
  a German dictionary has `reading = ''` (readings are a Japanese concept), so `ANALYZE` (run by
  `finalizeImport`) records `ix_terms_reading` as `947070 947070` — completely unselective — and the
  planner concludes a full scan beats the index for a reading probe. It is not wrong on average; it
  just cannot know the probed value is not the one dominant value. Without ANALYZE it was worse
  (110 ms via `ix_terms_dictionary`).
- **Why IndexedDB never had it**: no query planner. An IDB index probe always seeks, which is exactly
  what these queries want.
- **Fix**: `_queryTermColumn` pins the column's index with `INDEXED BY` for the exact and prefix
  probes. **75.6 ms → 0.064 ms per lookup** (~1200×), identical results. Suffix still scans on
  purpose (no reverse column, so no index can serve it).
- **Regression test**: `test/dictionary-database-sqlite-query-plan.test.js` captures the SQL the
  backend actually issues, runs `EXPLAIN QUERY PLAN` on it, and asserts `SCAN terms` never appears.
  2,000 all-empty-reading rows + ANALYZE reproduce the degenerate statistic in ~90 ms, and the test
  demonstrably fails when the `INDEXED BY` is removed. Correctness tests cannot catch this class of
  bug — results are identical either way, only the plan differs.
- **Same class, unverified**: the `term_meta` / `kanji` / `kanji_meta` equality probes let the planner
  choose too. Their columns are selective on real data, so they are not known to be affected, but a
  dictionary that made one degenerate would hit the same cliff.

## Watch-outs (still live)

- **sqlite3 must be a singleton.** `installOpfsSAHPoolVfs` caches its pool per VFS name _inside one
  sqlite3 instance_, and the pool holds exclusive OPFS sync access handles. A second
  `sqlite3InitModule()` call builds an independent runtime that cannot acquire them →
  `InvalidStateError` on any close/reopen (e.g. `purge()`). `loadVendoredSqlite3()` memoizes it.
  Caught by `npm run test:safari`; invisible to node.
- **jsdom breaks sqlite-wasm.** vitest's jsdom setup swaps the global typed-array constructors
  mid-test, breaking the WASM heap views (`jstrcpy() target must be an Int8Array or Uint8Array`).
  The SQLite tests therefore run in the plain node env; findTerms/findKanji don't need the DOM.
  Test-harness-only — the real backend runs in a Worker.
- **`.wasm` MIME in Safari**: extension `.wasm` is served without `application/wasm`, so
  `instantiateStreaming` fails and sqlite falls back to ArrayBuffer instantiation. Works, slightly
  slower. The zstd module avoids this entirely by embedding its wasm (`-sSINGLE_FILE`); any _further_
  WASM would need the fallback again.
- **Don't hand a WASM-heap view to a web API.** Safari's `TextDecoder` throws a `TypeError` on a
  `subarray` view backed by the growable WASM memory, where node accepts it happily; copy out with
  `slice` first. Caught by `npm run test:safari` — the second real bug that runner has found that
  node could not see. The same caution applies to any view handed across an API boundary, and views
  must never be cached across an allocation (growth detaches them).
- **`typedef` aliases of imported types resolve to `any` under typescript-eslint.** Reference types
  as a **direct** `import('payload-codec').PayloadCodec`; a local
  `@typedef {import(...)} PayloadCodec` alias type-checks under tsc but the type-aware lint rules
  see `any`. (`@implements` is the exception — it cannot take an inline `import()`, so it needs the
  alias.)
- **`dictionary_id` ordering**: insert the `dictionaries` row before its terms. FK enforcement is
  currently OFF (no `PRAGMA foreign_keys=ON`).
- **JSON round-trip quirk**: JSON turns `undefined` array elements into `null` on decode (e.g.
  missing `termTags`). `_splitField` tolerates it.
- **Suffix has no reverse column.** It filters in JS over the enabled dictionaries (full scan).
  Acceptable because suffix is search-page-only (`*foo`), but revisit if it shows up hot.

## File map (new/changed by this refactor)

```
plan/                                    01-design, 02-decisions, 03-progress, README, zstd/
ext/js/dictionary/dictionary-backend-config.js   USE_SQLITE_BACKEND flag
ext/js/dictionary/dictionary-database-factory.js createDictionaryDatabase() backend selection
ext/js/dictionary/payload-codec.js               IdentityPayloadCodec
ext/js/dictionary/deflate-payload-codec.js       DeflatePayloadCodec (pako, injected)
dev/measure-storage.js                           real-dictionary measurement (npm run measure:storage)
ext/js/dictionary/sqlite/open-sqlite.js          openDictionaryDatabaseHandle()
ext/js/dictionary/sqlite/dictionary-sqlite-schema.js   DDL + createDictionarySchema()
ext/js/dictionary/sqlite/dictionary-database-sqlite.js DictionaryDatabaseSqlite (the backend)
ext/js/dictionary/sqlite/dictionary-storage-migration.js  legacy-IDB detect/delete, persist
types/ext/sqlite-wasm.d.ts               narrow sqlite oo1 type surface
types/ext/pako.d.ts                      narrow pako surface
types/ext/payload-codec.d.ts             PayloadCodec type (+ optional prepare())
types/ext/dictionary-database.d.ts       + PayloadCodecName (and Layer 1's Packed/Payload types)
test/safari/                             real-Safari runner (run.js, harness.html, worker.js)
test/sqlite-backend-smoke.test.js        harness + opener/schema tests
test/dictionary-database-sqlite.test.js  term parity vs IndexedDB backend
test/dictionary-database-sqlite-codec.test.js  codec self-description + finalizeImport
test/deflate-payload-codec.test.js       deflate codec round-trips
test/dictionary-database-sqlite-query-plan.test.js  guards term lookups against full scans
test/dictionary-storage-migration.test.js      migration helpers
test/translator-sqlite.test.js           49 fixtures × {identity, deflate} end-to-end
dev/build-libs.js                        + copySqlite() / dev/lib/pako.js vendoring
dev/data/manifest-variants.json          safari CSP -> wasm-unsafe-eval
package.json                             + @sqlite.org/sqlite-wasm, pako, test:safari, measure:storage
```
