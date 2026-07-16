# Progress log

Living status of the storage-backend refactor. Update this every work session. Full design in
[design.md](design.md); decisions in [decisions.md](decisions.md).

## Git state

- Branch **`safari-refactor`** (off `master`). Tag **`stage-1`** marks the start of Stage 1.
- Storage-work commits (newest first):
  - `a7ba6f19` Stage 1: SQLite term backend (bulkAdd + findTermsBulk) with IndexedDB parity test
  - `4bdef82f` Stage 1: env-aware SQLite opener + dictionary schema
  - `c17abdd5` Stage 1: prove SQLite-WASM runs under vitest (harness de-risk)
  - `fa0bd435` plan.md: mark Stage 0 complete
  - `d677eb89` Stage 0: scaffold SQLite-WASM backend (vendor, CSP, codec, flag)
  - `864b8d23` Add plan.md
  - `7edfb9b2` (pre-refactor) Store non-indexed term fields as a positional payload (Layer 1)
- Everything below is green: `tsc` (main + test), repo-wide `eslint`, full `vitest`
  (4071 pass / 46 skipped).

## Stage 0 — DONE

- `@sqlite.org/sqlite-wasm` (^3.53.0) added to `package.json`. Vendored into `ext/lib` by
  `dev/build-libs.js` → `copySqlite()`: copies `dist/index.mjs`→`ext/lib/sqlite3.js` and
  `dist/sqlite3.wasm`. (`ext/lib/*` is gitignored / generated at build.)
- Safari CSP fixed in `dev/data/manifest-variants.json`: the safari-variant `extension_pages`
  `script-src` `'unsafe-eval'` → `'wasm-unsafe-eval'`.
- `ext/js/dictionary/payload-codec.js`: `PayloadCodec` typedef + `IdentityPayloadCodec` (JSON
  serialize, no compression). Payload = `[definitionTags, rules, score, glossary, termTags]`.
- `ext/js/dictionary/dictionary-backend-config.js`: `export const USE_SQLITE_BACKEND = false`.
- `types/ext/dictionary-database.d.ts`: added `PayloadCodecName = 'identity'|'deflate'|'zstd'`.

## Stage 4/5 — wiring DONE, flag still OFF (the flip is device-gated)

- **Backend selection** (`ext/js/dictionary/dictionary-database-factory.js`):
  `createDictionaryDatabase()` returns the backend chosen by `USE_SQLITE_BACKEND`. Wired into all
  three sites that construct the real database: `background/backend.js` (non-offscreen path),
  `background/offscreen.js`, and `dictionary/dictionary-database-worker-handler.js` (the DB worker).
  With the flag **off** these return exactly `new DictionaryDatabase()` — behavior is unchanged and
  no SQLite/WASM is touched at runtime.
- **`DictionaryDatabaseSqlite.prepare()` is now a drop-in**: called with no arguments it
  dynamically imports the vendored `ext/lib/sqlite3.js`, opens the OPFS SAH-Pool VFS, and calls
  `navigator.storage.persist()`. Tests still inject `sqlite3` + `vfs: 'memory'`. The dynamic import
  keeps the WASM out of the graph unless the SQLite backend is actually selected.
- **Migration helpers** (`ext/js/dictionary/sqlite/dictionary-storage-migration.js`):
  `legacyIndexedDbDictionaryExists()` (probes without leaving an empty DB behind),
  `deleteLegacyIndexedDbDictionary()` (reclaims the ~1.2 GB after re-import), and
  `requestPersistentStorage()`. Tested against fake-indexeddb.
- **Tuning**: `finalizeImport()` (ANALYZE + VACUUM) on the backend; `PRAGMA page_size = 8192` set
  in the opener before the schema (fresh DBs only, so no VACUUM needed).
- **Build verified**: `npm run build -- --target safari` succeeds and ships `lib/sqlite3.js`,
  `lib/sqlite3.wasm` (865 KB), `lib/pako.js`; the safari manifest CSP has `'wasm-unsafe-eval'`.
  `copySqlite` now prepends `// @ts-nocheck` (the file is copied verbatim, not esbuild-bundled, and
  the backend's dynamic import pulls it into the tsc graph).

### What is still required before flipping `USE_SQLITE_BACKEND` to true (Stage 5)

1. **On-device Safari verification** (cannot be done in node): `./rebuild-safari.sh`, import a
   dictionary, scan German text, check popup/Anki/audio. Confirm the DB worker resolves
   `ext/lib/sqlite3.js` + `sqlite3.wasm` at the extension origin, and that OPFS SAH-Pool opens.
2. **Settings-page migration UX**: call `legacyIndexedDbDictionaryExists()` on startup, prompt for
   re-import, then `deleteLegacyIndexedDbDictionary()`. Only the helpers exist today; no UI.
3. **Call `finalizeImport()`** after an import completes (the importer does not call it yet).
4. **Real-data measurement** on `kty-de-en` (the 1.2 GB → ~100 MB claim is unverified in-tree).
5. **Pick the shipped codec.** The factory constructs the backend with the default identity codec;
   for compression it must pass `DeflatePayloadCodec` (with vendored pako) or the future zstd codec.
6. **SAH-Pool capacity growth** for large DBs (`initialCapacity` default is 8 files).
7. Then: remove the IndexedDB path for `dict` + the flag, and unify the two backends behind one
   interface (today the SQLite backend is cast to `DictionaryDatabase` at the factory/test seams).

## Stage 3 — DONE for deflate (node-verified); zstd is the documented drop-in successor

- **Codec self-description**: `DictionaryDatabaseSqlite` now takes a write codec + optional decode
  codecs and keeps a per-dictionary `{codec, dict}` cache. On import it resolves/trains the write
  codec per dictionary (`_ensureWriteCodecs`/`_ensureWriteCodec`, run **before** the sync insert
  transaction because `train()` is async), persisting `codec` + `codec_dict` on the dictionaries
  row. On read, `_getDictCodec` derives the codec from the row's `codec` column (null == identity)
  and passes the cached `codec_dict`. Identity stays the default and leaves `codec` null, so the
  identity path is byte-identical to Stage 2.
- **DeflatePayloadCodec** (`ext/js/dictionary/deflate-payload-codec.js`): raw DEFLATE via pako,
  optional 32 KB preset dictionary from `train()`; pako injected (`types/ext/pako.d.ts` for types),
  vendored to `ext/lib/pako.js` via `dev/lib/pako.js` (esbuild), `pako` pinned in package.json.
- **Tests**: `deflate-payload-codec.test.js` (round-trips all payload shapes ± trained dict,
  compression vs identity, dict size cap); `dictionary-database-sqlite-codec.test.js` (self-
  description: reads still decode after dropping the write-time codec cache, i.e. derived from the
  `codec` column); `translator-sqlite.test.js` now runs all 49 fixtures against **both** the
  identity and the **deflate** SQLite backends (98 tests) — full end-to-end parity with compression.
- **zstd (target, 5.5×) — NOT built here.** It needs a custom zstd WASM build exposing
  `ZDICT_trainFromBuffer` + dict compress/decompress, which needs an emscripten/zstd toolchain not
  available in this environment. The codec seam is proven by deflate; a `ZstdPayloadCodec`
  implementing the same `PayloadCodec` interface is a drop-in (register it + make it the default
  write codec). No real-data size measurement (kty-de-en) was possible here either.

## Stage 2 — DONE (node-verified; worker wiring still pending, see Stage 4/5)

- **Full backend parity** (`DictionaryDatabaseSqlite`): every public method the importer and
  translator use is implemented — `bulkAdd` for all stores (terms/termMeta/kanji/kanjiMeta/tagMeta/
  media/dictionaries, one prepared statement per batch inside a transaction), `addWithResult`
  (returns a minimal IndexedDB-style request the importer awaits), `bulkUpdate('dictionaries')`,
  `findTermsBulk`/`findTermsExactBulk`/`findTermsBySequenceBulk`, `findTermMetaBulk`,
  `findKanjiBulk`/`findKanjiMetaBulk`, `findTagMetaBulk`/`findTagForTitle`, `getMedia`, and admin
  (`prepare`/`isPrepared`/`close`/`purge`/`dictionaryExists`/`getDictionaryInfo`/
  `getDictionaryCounts`/`deleteDictionary`). Result builders mirror `DictionaryDatabase._create*`.
  Meta/tag rows use plain columns + `data_json`; kanji/term payloads go through the codec BLOB.
- **End-to-end fixture parity** (`test/translator-sqlite.test.js`, 49 tests): the real
  `DictionaryImporter` imports the `Test Dictionary 2` fixture into the SQLite backend and the
  `Translator` runs every `translator-test-inputs.json` case; `dictionaryEntries` match the
  canonical `translator-test-results.json` exactly. `test/fixtures/translator-test.js` gained a
  `backend: 'indexeddb'|'sqlite'` parameter (default unchanged).
- **jsdom caveat:** the SQLite parity test runs in the **plain node env**. vitest's jsdom setup
  swaps the global typed-array constructors mid-test, which breaks sqlite-wasm's WASM heap views
  (`jstrcpy() target must be an Int8Array or Uint8Array`). findTerms/findKanji don't need the DOM,
  so this test skips the jsdom fixture. (The worker runs in a real Worker, not jsdom, so this is a
  test-harness-only constraint.)
- **Not yet done in Stage 2 scope:** perf tuning of the import path (per-batch prepared statements
  are in place, but no ANALYZE/VACUUM/PRAGMA tuning yet — Stage 4), and no compression yet (codec
  is still identity — Stage 3).

## Stage 1 — DONE

### Done

- **Term backend core** (`ext/js/dictionary/sqlite/dictionary-database-sqlite.js`,
  `DictionaryDatabaseSqlite`): `prepare({sqlite3, vfs})` (opens handle, loads the dictionary
  id<->title cache), `isPrepared`, `close`, `dictionaryExists`, `bulkAdd('terms'|'dictionaries')`,
  `findTermsBulk` (exact/prefix/suffix), `findTermsExactBulk`. `bulkAdd('terms')` resolves/creates
  the integer `dictionary_id` from the row's title, `codec.encode(m)` → payload BLOB, prepared
  insert inside one `transaction()` per batch; ids autoincrement in insertion order. Reads decode
  the payload and rebuild the `TermEntry` with the exact shaping of `_createTerm` (incl. the
  `visited`-by-id dedup and matchSource/matchType rules of `_createTermGeneric`). Prefix uses the
  inclusive `expression >= ? AND expression <= ? || char(65535)` bound (BMP-valid); suffix filters
  in JS (no reverse column yet). Only `terms`/`dictionaries` stores are wired — other stores throw
  `bulkAdd not implemented` (Stage 2).
- **PayloadCodec type promoted** to `types/ext/payload-codec.d.ts` (was an inline `@typedef` in
  payload-codec.js) so both the codec and the backend import one `import('payload-codec').PayloadCodec`.
  Note: reference it as a **direct** `import('payload-codec').PayloadCodec` — a local
  `@typedef {import(...)} PayloadCodec` alias resolves to `any` under typescript-eslint (tsc is fine,
  but the type-aware lint rules see `error`/`any`).
- **Parity test** (`test/dictionary-database-sqlite.test.js`, 6 tests): imports the fixture into the
  real IndexedDB backend, copies the exact packed term rows (in id order) into an in-memory SQLite
  backend, and asserts `findTermsExactBulk` + `findTermsBulk` exact/prefix/suffix match. Compared
  order-insensitively; matchSource is a don't-care where a row matches on both columns (deduped to
  whichever the backend visited first), so it is normalized/dropped in those cases.
- **Test harness de-risked** (`test/sqlite-backend-smoke.test.js`): SQLite-WASM inits in-memory
  under the vitest (node) runner; BLOB columns round-trip as `Uint8Array`; `IdentityPayloadCodec`
  survives a store/load through a BLOB; prefix range-scan works; the opener builds the full
  schema. vitest env is **node** (no jsdom); the sqlite-wasm **node build** works there.
- **Env-aware opener** (`ext/js/dictionary/sqlite/open-sqlite.js`):
  `openDictionaryDatabaseHandle(sqlite3, {vfs, path?, initialCapacity?})`. `vfs:'opfs'` →
  `installOpfsSAHPoolVfs` + `OpfsSAHPoolDb`; `vfs:'memory'` → `new sqlite3.oo1.DB(':memory:')`.
  Sets `PRAGMA synchronous=NORMAL`, `temp_store=MEMORY`, then creates the schema. **`sqlite3` is
  injected** (not imported here) — see decisions.md #9.
- **Schema** (`ext/js/dictionary/sqlite/dictionary-sqlite-schema.js`):
  `createDictionarySchema(db)` runs the DDL (tables `dictionaries, terms, term_meta, kanji,
kanji_meta, tag_meta, media`) and sets `PRAGMA user_version = DICTIONARY_SQLITE_SCHEMA_VERSION`
  (=1). Exports `DICTIONARY_SQLITE_TABLES` for validation. Note naming: `sort_order` (not the
  reserved `order`), `summary_json`/`data_json` for JSON, `payload BLOB` for terms/kanji.
- **Types** (`types/ext/sqlite-wasm.d.ts`): narrow `Sqlite3Module`, `SqliteDatabaseHandle`,
  `SqliteStatement`, `SqliteSAHPool`, `SqlValue`, `SqlBind`, `SqlRow`, `SqliteVfs`. Resolved via
  jsconfig `"*": ["./types/ext/*"]`, i.e. `import('sqlite-wasm')`.

### Next steps (in order)

Steps 1–3 and the parity test are **done** (see "Done" above). Remaining Stage 1 / Stage 2 work:

1. **Rest of the read/query surface on SQLite** (Stage 2): `findTermsBySequenceBulk`,
   `findTermMetaBulk`, `findKanjiBulk`, `findKanjiMetaBulk`, `findTagMetaBulk`, `findTagForTitle`,
   `getMedia`/`drawMedia`, `getDictionaryInfo`, `getDictionaryCounts`, `deleteDictionary`,
   `dictionaryCounts`, plus the remaining `bulkAdd` stores (`termMeta`, `kanji`, `kanjiMeta`,
   `tagMeta`, `media`) and `addWithResult`/`bulkUpdate('dictionaries')` so the real
   `DictionaryImporter` runs end-to-end against it. Then drive the full `dictionary-data.test.js`
   translator fixtures through the SQLite backend.
2. **Backend selection + worker wiring** (needs device verify): branch on `USE_SQLITE_BACKEND` to
   pick `DictionaryDatabaseSqlite`; the DB worker
   (`ext/js/dictionary/dictionary-database-worker-main.js`) inits sqlite via
   `import sqlite3InitModule from '../../lib/sqlite3.js'` and passes `vfs:'opfs'`. Verify on
   `./rebuild-safari.sh` (worker import of the vendored browser build; `import.meta.url` →
   `sqlite3.wasm` at extension origin; `.wasm` MIME fallback). Flag stays `false` until Stage 5.

Note: `addWithResult` in the current importer returns an **IDBRequest** (`.onsuccess`/`.result`);
the SQLite backend will need a small non-IDB shim or an importer tweak when wiring step 1.

### Open questions / watch-outs

- **Worker import of the vendored browser build**: confirm `import … from '../../lib/sqlite3.js'`
  works in the real extension worker (`dictionary-database-worker-main.js`) and that
  `index.mjs`'s `import.meta.url` resolves `sqlite3.wasm` at the extension origin. The spike
  proved a page-spawned worker; the real DB worker is spawned from the offscreen document — same
  origin, should behave the same, but verify on `./rebuild-safari.sh`.
- **`.wasm` MIME in Safari**: `instantiateStreaming` fails (`Unexpected MIME type`) and falls
  back to ArrayBuffer instantiation — works, slightly slower. Acceptable.
- **`dictionary_id` ordering**: insert the `dictionaries` row before its terms. FK enforcement is
  currently OFF (no `PRAGMA foreign_keys=ON`); turn on later if desired.
- **JSON round-trip quirk**: `IdentityPayloadCodec` uses JSON, so `undefined` array elements
  become `null` on decode (e.g. missing `termTags`). Tests account for this; the real `_createTerm`
  shaping tolerates it (`_splitField` handles null/undefined).
- **prefix/suffix** (later, not Stage 1): prefix → `expression >= term AND expression < term||high`;
  suffix (search-page `*foo` only) → reverse column or `LIKE '%'||term`.

## File map (new/changed by this refactor)

```
plan/                                   design.md, README.md, decisions.md, progress.md
ext/js/dictionary/payload-codec.js      IdentityPayloadCodec (type now in types/ext)
ext/js/dictionary/dictionary-backend-config.js   USE_SQLITE_BACKEND flag
ext/js/dictionary/sqlite/open-sqlite.js          openDictionaryDatabaseHandle()
ext/js/dictionary/sqlite/dictionary-sqlite-schema.js  DDL + createDictionarySchema()
ext/js/dictionary/sqlite/dictionary-database-sqlite.js  DictionaryDatabaseSqlite (term core)
types/ext/sqlite-wasm.d.ts              narrow sqlite oo1 type surface
types/ext/payload-codec.d.ts            PayloadCodec type
types/ext/dictionary-database.d.ts      + PayloadCodecName (and Layer 1's Packed/Payload types)
test/sqlite-backend-smoke.test.js       harness + opener/schema tests
test/dictionary-database-sqlite.test.js  term parity vs IndexedDB backend
dev/build-libs.js                       + copySqlite() vendoring
dev/data/manifest-variants.json         safari CSP -> wasm-unsafe-eval
package.json                            + @sqlite.org/sqlite-wasm
```
