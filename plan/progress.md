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

1. **Read the current implementations to match semantics exactly** before porting:
   - Importer insert path: the `bulkAdd` closure in `ext/js/dictionary/dictionary-importer.js`
     (~line 80) and its call sites (`bulkAdd('terms', …)` ~line 219, plus media/termMeta/kanji/
     tagMeta/dictionaries). Terms are already packed by `_packTermEntry` (~line 830) into
     `DatabaseTermEntryPacked` (`{expression, reading, dictionary, sequence?, m}`).
   - `DictionaryDatabase.findTermsBulk` (~line 288), `findTermsExactBulk` (~321), and
     `_createTerm` (~762, the sole term result builder) in
     `ext/js/dictionary/dictionary-database.js`.
2. **Implement `bulkAdd('terms')` on SQLite**: resolve/insert the `dictionary_id` for the
   dictionary title (upsert into `dictionaries`), `codec.encode(m)` → BLOB, prepared-statement
   insert `(dictionary_id, expression, reading, sequence, payload)`. Use a transaction per batch.
3. **Implement `findTermsBulk` exact**: `SELECT id, dictionary_id, expression, reading, sequence,
payload FROM terms WHERE expression = ?` (or reading), filter to the enabled dictionary ids,
   `codec.decode(payload)` → `[definitionTags, rules, score, glossary, termTags]`, then build the
   `TermEntry` with the SAME shaping as `_createTerm` (split tag/rule fields, etc.). Map
   `dictionary_id` back to the title string for the `TermEntry.dictionary` field.
4. **Backend selection**: introduce a `DictionaryDatabaseSqlite` class (mirrors the public API)
   or a branch, chosen by `USE_SQLITE_BACKEND`. The DB worker
   (`ext/js/dictionary/dictionary-database-worker-main.js`) inits sqlite via
   `import sqlite3InitModule from '../../lib/sqlite3.js'` and passes `vfs:'opfs'`.
5. **Parity test**: reuse `test/dictionary-data.test.js` fixtures; import via `DictionaryImporter`
   into the SQLite backend and assert exact `findTermsBulk` results match the IndexedDB backend.

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
ext/js/dictionary/payload-codec.js      PayloadCodec + IdentityPayloadCodec
ext/js/dictionary/dictionary-backend-config.js   USE_SQLITE_BACKEND flag
ext/js/dictionary/sqlite/open-sqlite.js          openDictionaryDatabaseHandle()
ext/js/dictionary/sqlite/dictionary-sqlite-schema.js  DDL + createDictionarySchema()
types/ext/sqlite-wasm.d.ts              narrow sqlite oo1 type surface
types/ext/dictionary-database.d.ts      + PayloadCodecName (and Layer 1's Packed/Payload types)
test/sqlite-backend-smoke.test.js       harness + opener/schema tests
dev/build-libs.js                       + copySqlite() vendoring
dev/data/manifest-variants.json         safari CSP -> wasm-unsafe-eval
package.json                            + @sqlite.org/sqlite-wasm
```
