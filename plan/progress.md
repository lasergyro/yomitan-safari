# Progress log

Living status of the storage-backend refactor. Update this every work session. Full design in
[design.md](design.md); decisions in [decisions.md](decisions.md).

## Git state

- Branch **`safari-refactor`** (off `master`). Tag **`stage-1`** marks the start of Stage 1.
- Storage-work commits (newest first):
  - `4bdef82f` Stage 1: env-aware SQLite opener + dictionary schema
  - `c17abdd5` Stage 1: prove SQLite-WASM runs under vitest (harness de-risk)
  - `fa0bd435` plan.md: mark Stage 0 complete
  - `d677eb89` Stage 0: scaffold SQLite-WASM backend (vendor, CSP, codec, flag)
  - `864b8d23` Add plan.md
  - `7edfb9b2` (pre-refactor) Store non-indexed term fields as a positional payload (Layer 1)
- Everything below is green: `tsc` (main + test), repo-wide `eslint`, full `vitest`
  (4065 pass / 46 skipped).

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

## Stage 1 — IN PROGRESS

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
