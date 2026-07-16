# Progress log

Living status of the storage-backend refactor. Update this every work session. Stages are ordered
oldest → newest. Full design in [01-design.md](01-design.md); decisions in
[02-decisions.md](02-decisions.md); the outstanding zstd task in [zstd/](zstd/README.md).

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
- Green: `tsc` (main + test), repo-wide `eslint`, full `vitest` (4230 tests / 46 skipped),
  `npm run build -- --target safari`, and `npm run test:safari` (12/12 in real Safari).

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
  (not imported here) — see [02-decisions.md](02-decisions.md) #9.
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

## Stage 5 — NOT STARTED: what is required before flipping `USE_SQLITE_BACKEND`

1. **Extension-origin verification.** `npm run test:safari` covers the engine (OPFS, the vendored
   WASM, the whole backend) but runs on `127.0.0.1`, not `safari-web-extension://…`. Still needs
   `./rebuild-safari.sh` + a manual pass: import a dictionary, scan German text, check
   popup/Anki/audio, and confirm the DB worker resolves `ext/lib/sqlite3.js` + `sqlite3.wasm` at the
   extension origin.
2. **Settings-page migration UX**: call `legacyIndexedDbDictionaryExists()` on startup, prompt for
   re-import, then `deleteLegacyIndexedDbDictionary()`. Only the helpers exist today; no UI.
3. **Call `finalizeImport()`** after an import completes (the importer does not call it yet).
4. **Real-data measurement** on `kty-de-en` — the 1.2 GB → ~100 MB claim is unverified in-tree.
5. **Pick the shipped codec.** The factory uses the default identity codec; for compression it must
   pass `DeflatePayloadCodec` (with vendored pako) or the future [zstd](zstd/README.md) codec.
6. **SAH-Pool capacity growth** for large DBs (`initialCapacity` default is 8 files).
7. Then: remove the IndexedDB path for `dict` + the flag, and unify the two backends behind one
   interface (today the SQLite backend is cast to `DictionaryDatabase` at the factory/test seams).

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
  slower. Any new WASM (zstd) needs the same fallback.
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
ext/js/dictionary/sqlite/open-sqlite.js          openDictionaryDatabaseHandle()
ext/js/dictionary/sqlite/dictionary-sqlite-schema.js   DDL + createDictionarySchema()
ext/js/dictionary/sqlite/dictionary-database-sqlite.js DictionaryDatabaseSqlite (the backend)
ext/js/dictionary/sqlite/dictionary-storage-migration.js  legacy-IDB detect/delete, persist
types/ext/sqlite-wasm.d.ts               narrow sqlite oo1 type surface
types/ext/pako.d.ts                      narrow pako surface
types/ext/payload-codec.d.ts             PayloadCodec type
types/ext/dictionary-database.d.ts       + PayloadCodecName (and Layer 1's Packed/Payload types)
test/safari/                             real-Safari runner (run.js, harness.html, worker.js)
test/sqlite-backend-smoke.test.js        harness + opener/schema tests
test/dictionary-database-sqlite.test.js  term parity vs IndexedDB backend
test/dictionary-database-sqlite-codec.test.js  codec self-description + finalizeImport
test/deflate-payload-codec.test.js       deflate codec round-trips
test/dictionary-storage-migration.test.js      migration helpers
test/translator-sqlite.test.js           49 fixtures × {identity, deflate} end-to-end
dev/build-libs.js                        + copySqlite() / dev/lib/pako.js vendoring
dev/data/manifest-variants.json          safari CSP -> wasm-unsafe-eval
package.json                             + @sqlite.org/sqlite-wasm, pako, test:safari script
```
