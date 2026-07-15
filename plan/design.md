# Plan: replace the dictionary storage backend with SQLite-WASM + zstd

Status: **Stage 0 complete** (branch `safari-refactor`, commit `d677eb89`). Layer 1
(positional payload) is shipped. Feasibility of the SQLite/OPFS backend is fully confirmed on
macOS + iOS + the extension worker. This document is the full implementation plan; it is
written to survive a context reset, so it repeats context, measurements, and decisions in full.

Progress against §9:

- **Stage 0 (done):** `@sqlite.org/sqlite-wasm` added + vendored into `ext/lib`
  (`sqlite3.js`, `sqlite3.wasm`) via `dev/build-libs.js`; safari CSP fixed to
  `'wasm-unsafe-eval'`; `PayloadCodec` interface + `IdentityPayloadCodec` added
  (`ext/js/dictionary/payload-codec.js`); `USE_SQLITE_BACKEND` flag added
  (`ext/js/dictionary/dictionary-backend-config.js`, off); `PayloadCodecName` type added.
- **Stage 1 (next):** vertical slice — SQLite init in the DB worker, schema, `bulkAdd('terms')`
  - `findTermsBulk` exact, one fixture test green. **Resolve the node test harness first**
    (run the SQLite backend under vitest via the package's node build / an in-memory VFS) — this
    is the flagged early risk (§10/§11).

---

## 0. Purpose / how to use this doc

The goal is to shrink the on-disk dictionary storage of the Safari Yomitan fork (currently
~1.2 GB for one language) by an order of magnitude, and reduce RAM/IO pressure, by replacing
the IndexedDB storage backend with **SQLite-WASM on OPFS**, storing the heavy definition
payload as a **zstd-compressed BLOB with a per-dictionary trained dictionary**, in a
**columnar schema** that eliminates repeated strings (property names, dictionary titles).

Read sections 1–7 for context and the decisions already made (don't relitigate them without
reason). Section 8 is the target design. Section 9 is the staged implementation plan. Section
10 is testing. Sections 11–12 are risks and a reference index (files, commands, URLs).

---

## 1. Goal and success criteria

- **Primary:** reduce the `dict` store from ~1.2 GB to roughly ~100 MB for a large
  dictionary, with no loss of lookup functionality or correctness.
- **"No repeating strings":** the design must not store the same string many times. The
  three offenders today are (a) per-row JSON property names, (b) the dictionary title
  repeated in every row, (c) `expression` duplicated between the value and its index.
- **Cross-platform:** must work in the Safari Web Extension sandbox on macOS **and** iOS
  Safari (both confirmed feasible — see §5).
- **Contained:** all backend changes stay behind the `DictionaryDatabase` facade
  (`ext/js/dictionary/dictionary-database.js`) + the importer. Callers (translator, backend,
  display) do not change.
- **Correctness gate:** the existing unit tests that import fixtures and query
  (`test/database.test.js`, `test/dictionary-data.test.js`, `test/dictionary-data-validate.test.js`)
  must pass against the new backend.

Non-goals: changing the Yomitan dictionary _file_ format (we consume upstream term banks
unchanged); staying compatible with upstream Yomitan's on-disk DB (we diverge — this is a
fork); supporting reading dictionaries imported before the migration without a re-import.

---

## 2. Current storage model (baseline)

The DB is a single IndexedDB database named **`dict`**, version **60**, opened via a generic
wrapper `ext/js/data/database.js` (class `Database`) and driven by
`ext/js/dictionary/dictionary-database.js` (class `DictionaryDatabase`). The DB runs inside a
dedicated **Worker** (`ext/js/dictionary/dictionary-database-worker-main.js`), which — because
the MV3 background is a service worker — is itself spawned from Yomitan's **offscreen
document** (`ext/js/background/offscreen.js`). All DB access is routed through the worker
(`dictionary-database-worker-handler.js`). This single-worker access model matters: SQLite's
OPFS SAH-Pool VFS is single-connection, which is fine because only the worker touches the DB.

### Object stores + indexes (from `DictionaryDatabase.prepare()`):

- `terms`: primaryKey `{keyPath:'id', autoIncrement:true}`; indices `dictionary, expression,
reading, sequence` and, only if `prefixWildcardsSupported` is enabled at import,
  `expressionReverse, readingReverse`.
- `kanji`: autoIncrement; indices `dictionary, character`.
- `termMeta`: autoIncrement; indices `dictionary, expression`.
- `kanjiMeta`: autoIncrement; indices `dictionary, character`.
- `tagMeta`: autoIncrement; indices `dictionary, name`.
- `dictionaries`: autoIncrement; indices `title, version`.
- `media`: primaryKey `{keyPath:'id'}`; indices `dictionary, path`.

### Row shapes (see `types/ext/dictionary-database.d.ts`):

- **Legacy term row** `DatabaseTermEntry`: `{expression, reading, expressionReverse?,
readingReverse?, definitionTags: string|null, tags?, rules: string, score: number,
glossary: TermGlossary[], sequence?, termTags?, dictionary}`. `dictionary` is the **title
  string** (e.g. `"kty-de-en"`), not an id.
- **Packed term row (Layer 1, shipped)** `DatabaseTermEntryPacked`: `{expression, reading,
expressionReverse?, readingReverse?, sequence?, dictionary, m: DatabaseTermEntryPayload}`
  where `DatabaseTermEntryPayload = [definitionTags, rules, score, glossary, termTags]`.
- **Query result** `TermEntry`: `{index, matchType, matchSource, term, reading,
definitionTags: string[], termTags: string[], rules: string[], definitions:
TermGlossary[], score, dictionary, id, sequence}` — built by `_createTerm`.

### Glossary / structured content (the heavy, compressible part)

`TermGlossary = string | {type:'text',text} | {type:'image',...} | {type:'structured-content',
content}` (see `types/ext/dictionary-data.d.ts`, `types/ext/structured-content.d.ts`).
`StructuredContent.Content = string | Element | Content[]`. `Element` has a `tag` from a
**closed set** (`br, ruby, rt, rp, table, thead, tbody, tfoot, tr, td, th, span, div, ol, ul,
li, details, summary, img, a`) plus optional `content, data, style` and a fixed handful of
attributes (`colSpan, rowSpan, href, path, width, height, title, lang, verticalAlign,
textAlign, …`). This closed key set is why a trained dictionary compresses it so well.

### Public `DictionaryDatabase` API that must be preserved (callers depend on it)

Query/read: `findTermsBulk(termList, dictionaries, matchType)`,
`findTermsExactBulk(termList, dictionaries)`, `findTermsBySequenceBulk(items)`,
`findTermMetaBulk(termList, dictionaries)`, `findKanjiBulk(kanjiList, dictionaries)`,
`findKanjiMetaBulk(kanjiList, dictionaries)`, `findTagMetaBulk(...)`,
`findTagForTitle(name, dictionary)`, `getMedia(items)`.
Admin: `prepare()`, `close()`, `purge()`, `deleteDictionary(name, rate, onProgress)`,
`dictionaryExists(title)`, `getDictionaryInfo()`, `getDictionaryCounts(...)`,
`getAllDictionaries()`/similar, `bulkAdd(objectStoreName, items, start, count)` (used by the
importer). Result builders: `_createTerm`, `_createKanji`, `_createTermMeta`, `_createKanjiMeta`,
`_createMedia`, `_createTagMeta`. `matchType ∈ {'exact','prefix','suffix'}`.

`matchType` semantics (verify exact query-building in current code before porting):

- `exact`: `expression == term` (the _exact_ variant also filters `reading == item.reading`).
- `prefix`: term is a prefix; today an IndexedDB **range** query over the `expression` index.
  In SQL → `WHERE expression >= :term AND expression < :term || x'10FFFF'` (or `LIKE :term||'%'`
  with care around `%`/`_` escaping).
- `suffix`: uses the `expressionReverse`/`readingReverse` reversed-string indexes (prefix of
  reversed string). **Only** produced by the search page when the query starts with `*`
  (`ext/js/display/display.js` `_getFindDetails`, ~line 1369). Inline scanning never uses it
  (`ext/js/app/frontend.js` sets `wildcards:'off'`, ~line 1195). In SQL → either keep a
  `reading_reverse`/`expression_reverse` column + index, or `LIKE '%'||:term` (full scan,
  acceptable because it is rare and search-page-only). Gated by option
  `global.database.prefixWildcardsSupported` (default false).

---

## 3. Where the bytes go (measured breakdown)

Measured on the recommended English–German dictionary **`kty-de-en`** (Kaikki-to-Yomitan,
format 3, `sourceLanguage de`, `targetLanguage en`), **983,520 term rows**, ~10% of rows carry
structured content. Value sizes measured with `v8.serialize` (the structured-clone family
IndexedDB uses; WebKit's exact serialization differs but the key-name/redundancy deltas are
representative). Scripts live in the scratch dir (see §12) — `measure.mjs`, `measure2.mjs`,
`breakdown.mjs`.

Packed value store (after Layer 1) = **356.8 MB**, decomposed:

| Component                                                 | Size        | Compressible?            |
| --------------------------------------------------------- | ----------- | ------------------------ |
| `m` payload (definitions/glossary)                        | 266.8 MB    | **yes** → ~48 MB at 5.5× |
| top-level fields (needed for indexes)                     | **89.0 MB** | **no**                   |
| ↳ repeating property key-names per row                    | 33.8 MB     | —                        |
| ↳ repeating `dictionary` title per row (1 distinct value) | 8.4 MB      | —                        |
| ↳ `expression` values (952,394 distinct = 97% unique)     | 14.4 MB     | —                        |
| ↳ `reading` values                                        | 14.4 MB     | —                        |
| ↳ ints (id, sequence) + clone overhead                    | ~18 MB      | —                        |

**Why IndexedDB + compression can't get below ~137 MB value store:** IndexedDB indexes read
values through a keyPath, so indexed fields _and their property names_ must live as plain named
properties in every record. Compression only touches the `m` blob. On top of the value store,
IndexedDB keeps its own index B-trees (another ~100–150 MB, where `expression`/`reading` are
duplicated again). That is the wall, and the reason for moving to SQLite columnar storage.

---

## 4. Compression measurements

Payload = `[definitionTags, rules, score, glossary, termTags]` serialized to compact JSON
(~253 MB total over the 983,520 rows). Per-row compression (each row independently, so it is
randomly decodable):

| Method                                                           | Ratio     | Payload result |
| ---------------------------------------------------------------- | --------- | -------------- |
| per-row deflate, no dictionary                                   | 2.24×     | 113 MB         |
| per-row deflate + 32 KB shared preset dict (pako-style, pure JS) | **3.55×** | ~71 MB         |
| per-row zstd −19, no dictionary                                  | 2.09×     | —              |
| per-row zstd −19 + **raw** (untrained) 112 KB content dict       | 2.82×     | —              |
| **per-row zstd −19 + 112 KB ZDICT-trained dict**                 | **5.52×** | ~46 MB         |
| whole-corpus gzip (not random-access; theoretical floor)         | ~12.8×    | —              |

Conclusions (already decided): a **shared dictionary is required** (per-row compression of tiny
payloads is otherwise net-negative). **zstd + a trained dictionary (5.5×) is the target.** A
**raw** (untrained) dictionary only gets 2.82×, so training (`ZDICT_trainFromBuffer`) matters.
pako-deflate + a 32 KB preset dict (3.55×, pure JS, no WASM) is the **interim** codec to get the
architecture working before the zstd build lands.

---

## 5. Feasibility spike results (all passed)

SQLite-WASM = official `@sqlite.org/sqlite-wasm` **3.53.0**, ESM build, **OPFS SAH-Pool VFS**
(`installOpfsSAHPoolVfs` → `OpfsSAHPoolDb`). SAH-Pool is the VFS that works on Safari **without**
COOP/COEP (no `SharedArrayBuffer`/cross-origin-isolation needed). Test = create table + index,
insert 20k rows (id, expression, 200-byte blob) in one transaction, indexed lookup, reload to
confirm persistence.

| Context                                                         | init | VFS | 20k insert | lookup | quota     | persistence |
| --------------------------------------------------------------- | ---- | --- | ---------- | ------ | --------- | ----------- |
| macOS Safari, page worker                                       | ✅   | ✅  | 95 ms      | 1 ms   | 78 GB     | ✅          |
| iOS Safari, page worker (via Tailscale HTTPS)                   | ✅   | ✅  | 104 ms     | 1 ms   | **38 GB** | ✅          |
| macOS Safari, **extension worker** (`safari-web-extension://…`) | ✅   | ✅  | 110–166 ms | 0 ms   | 78 GB     | ✅          |

Notes from the extension-worker run (important for implementation):

- **iOS quota is ~38 GB**, not the oft-cited ~1 GB WebView cap — capacity is not a blocker;
  compression still matters for eviction-resistance and headroom. Confirm per-device with
  `navigator.storage.estimate()` and call `navigator.storage.persist()`.
- `wasm streaming compile failed: Unexpected response MIME type. Expected 'application/wasm'`
  → SQLite **falls back to ArrayBuffer instantiation and works**. Safari serves extension
  `.wasm` without the `application/wasm` MIME. Accept the fallback (sqlite handles it) or
  investigate serving the correct MIME. Non-blocking.
- CSP warning: `script-src … 'unsafe-eval' … invalid source … ignored`. The **safari**
  manifest variant uses `'unsafe-eval'`; MV3/Safari want **`'wasm-unsafe-eval'`** (chrome/
  firefox variants already use it). WASM ran anyway via the ArrayBuffer path, but fix the CSP
  (see §9 Stage 0).
- `navigator.storage.estimate()` reported `usage 1204 MB` in the extension origin = the
  existing `dict` IndexedDB. Confirms the ~1.2 GB baseline and that migration must **delete the
  old IndexedDB** after re-import to avoid double-storage.

The feasibility spike code has been removed from the tree (it lived in `ext/opfs-spike/`,
`ext/js/spike/`, `manual-test/opfs-spike/`, plus a temporary `settings.html` `<script>`). To
recreate it, see git history / §12; vendoring was `npm pack @sqlite.org/sqlite-wasm`, copy
`dist/index.mjs` (rename to `.js`) + `dist/sqlite3.wasm`.

---

## 6. Architecture decision (with rejected alternatives)

**Chosen:** stock SQLite-WASM on the OPFS SAH-Pool VFS, inside the existing DB worker.
Columnar schema (no per-row property names), integer `dictionary_id` FK (no repeated title),
SQLite's own B-tree indexes for `expression`/`reading`/`sequence` (no hand-rolled inverted
index). The heavy `payload` is a single **zstd-compressed BLOB** per row, decoded only for
matched rows, using a **trained dictionary stored once per imported dictionary**.

Rejected / considered:

- **Keep IndexedDB, just compress `m`.** Floors at ~290 MB because indexed fields + their key
  names + index duplication stay uncompressed. Does not meet "no repeating strings."
- **Hand-rolled inverted indexes on IndexedDB** (`id→blob` main store + our own
  `expression→[ids]` stores). Achieves the goal but is a from-scratch query engine (posting
  lists, range scans for prefix) — SQLite does this for us, better tested.
- **`sqlite-zstd` (transparent row compression).** Not practical: it is a **Rust loadable
  extension** (`libsqlite_zstd.so`, rusqlite + vtabs + background transactions), no WASM build,
  and **SQLite-WASM cannot dynamically load extensions** — they must be statically compiled in
  (C via `SQLITE_EXTRA_INIT`/`sqlite3_auto_extension`). Static-linking a Rust extension into
  the Emscripten C build is bleeding-edge (`tantaman/sqlite-rust-wasm`), and its design fights
  the WASM/OPFS model. **Do app-level zstd on the BLOB column instead** — same outcome, standard
  toolchain.
- **DuckDB-WASM / PGlite.** Columnar-analytical / full Postgres; wrong shape for point lookups,
  much larger. No.
- **wa-sqlite** (custom-VFS SQLite): keep as **fallback** — its IndexedDB VFS is a plan B if
  OPFS ever misbehaves; not needed given the spike passed.

zstd build: the official SQLite-WASM build is fine as-is (we compress at the app layer, not in
SQLite). For zstd itself we need a WASM build exposing compress/decompress **with dictionary**
and **`ZDICT_trainFromBuffer`** (training). Off-the-shelf zstd-wasm packages often omit
training; **plan to produce a custom zstd WASM build** (user agreed) that exports:
`ZSTD_compress_usingCDict`/`ZSTD_decompress_usingDDict` (or the simpler `_usingDict` forms) and
`ZDICT_trainFromBuffer`. Interim: pako (pure JS, deflate + 32 KB preset dict) so the backend
can be built and tested before the zstd build exists.

---

## 7. What is already done (shipped on branch `popup-fixes-and-lint`)

- **Layer 1 — positional term payload** (commit `7edfb9b2`): term rows store the non-indexed
  fields as `m: [definitionTags, rules, score, glossary, termTags]` instead of named
  properties. Writer: `DictionaryImporter._packTermEntry` (`dictionary-importer.js`). Reader:
  `DictionaryDatabase._createTerm` (`dictionary-database.js`) unpacks `'m' in row ? row.m :
legacy named fields`, so pre-existing dictionaries still read until re-imported. Types
  `DatabaseTermEntryPayload` + `DatabaseTermEntryPacked` added to
  `types/ext/dictionary-database.d.ts`; store type is `DatabaseTermEntry | DatabaseTermEntryPacked`.
  Measured ~10% off the value store (see §3). **This is a stepping stone**; the SQLite backend
  supersedes it (the payload array maps directly onto the compressed BLOB column). It stays
  valid until the SQLite work lands.
- Supporting/unrelated work also on this branch: custom popup CSS (`04dd4f11`), inline popup
  width/height-on-scroll fix (`4d7ac1dc`), unquoted-url icon fix (`b21c9091`), manual-test
  harness (`f5221951`), DEV.md Safari/Tailscale docs (`dc6fab03`), `rebuild-safari.sh
--target safari` (`b01b7543`), test-suite hygiene (`261e9abe`).

Branch is `popup-fixes-and-lint` (off `master`). `master` is clean.

---

## 8. Target design

### 8.1 SQLite schema (new DB file, OPFS, e.g. `dict.sqlite3`)

```sql
-- one row per imported dictionary
CREATE TABLE dictionaries (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL UNIQUE,
  revision      TEXT,
  version       INTEGER,
  summary_json  TEXT,        -- the DictionaryImporter.Summary (counts, styles, flags, etc.)
  codec         TEXT,        -- 'zstd' | 'deflate' | 'identity'
  codec_dict    BLOB         -- trained/preset dictionary for this dictionary's payloads
);

CREATE TABLE terms (
  id            INTEGER PRIMARY KEY,
  dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
  expression    TEXT NOT NULL,
  reading       TEXT NOT NULL,
  sequence      INTEGER,
  payload       BLOB NOT NULL   -- codec(encode([definitionTags,rules,score,glossary,termTags]))
);
CREATE INDEX ix_terms_expr ON terms(expression);
CREATE INDEX ix_terms_read ON terms(reading);
CREATE INDEX ix_terms_seq  ON terms(dictionary_id, sequence);
CREATE INDEX ix_terms_dict ON terms(dictionary_id);
-- Only if prefixWildcardsSupported: add expression_reverse/reading_reverse columns + indexes,
-- OR implement suffix via LIKE '%'||term (rare, search-page-only).

CREATE TABLE term_meta ( id INTEGER PRIMARY KEY, dictionary_id INTEGER NOT NULL,
  expression TEXT NOT NULL, mode TEXT, data_json TEXT );   -- shape: see DatabaseTermMeta
CREATE INDEX ix_term_meta_expr ON term_meta(expression);

CREATE TABLE kanji ( id INTEGER PRIMARY KEY, dictionary_id INTEGER NOT NULL,
  character TEXT NOT NULL, payload BLOB NOT NULL );          -- payload: onyomi,kunyomi,tags,meanings,stats
CREATE INDEX ix_kanji_char ON kanji(character);

CREATE TABLE kanji_meta ( id INTEGER PRIMARY KEY, dictionary_id INTEGER NOT NULL,
  character TEXT NOT NULL, mode TEXT, data_json TEXT );
CREATE INDEX ix_kanji_meta_char ON kanji_meta(character);

CREATE TABLE tag_meta ( id INTEGER PRIMARY KEY, dictionary_id INTEGER NOT NULL,
  name TEXT NOT NULL, category TEXT, "order" INTEGER, notes TEXT, score INTEGER );
CREATE INDEX ix_tag_meta_name ON tag_meta(name);

CREATE TABLE media ( id INTEGER PRIMARY KEY, dictionary_id INTEGER NOT NULL,
  path TEXT NOT NULL, media_type TEXT, width INTEGER, height INTEGER, content BLOB );
CREATE INDEX ix_media_path ON media(path);
```

Notes:

- `dictionary_id` (int) replaces the repeated title string everywhere → kills 8.4 MB of value
  - the whole `dictionary` index redundancy. Queries that filter "which dictionaries are
    enabled" pass a set of ids (translate titles→ids once).
- `terms.payload` holds the compressed `[definitionTags, rules, score, glossary, termTags]`.
  Columnar table = zero per-row property names → kills 33.8 MB.
- `expression`/`reading` are stored once in the column + once in the B-tree index (SQLite
  indexes are more compact than IDB's). This residual duplication is inherent to indexing and
  is acceptable (~28 MB); do not try to eliminate it.
- Consider `PRAGMA page_size`, `PRAGMA journal_mode` — SAH-Pool VFS specifics: test WAL vs
  default; WAL may not be supported/beneficial on SAH-Pool. Default rollback journal is safe.
  Set `PRAGMA synchronous = NORMAL` for import speed; `PRAGMA temp_store = MEMORY`.
- After a big import, run `ANALYZE` and consider `VACUUM` to compact.

### 8.2 PayloadCodec seam

```
interface PayloadCodec {
  // build a dictionary from a representative sample of encoded payloads (Uint8Array[])
  train(samples: Uint8Array[]): Promise<Uint8Array>;       // returns codec_dict bytes
  encode(payload: unknown[], dict: Uint8Array|null): Uint8Array;
  decode(blob: Uint8Array, dict: Uint8Array|null): unknown[];
  readonly name: 'identity' | 'deflate' | 'zstd';
}
```

- Payload serialization: JSON (simplest) or MessagePack (smaller, avoids re-quoting) → then
  compress. Start with JSON; measure MessagePack later.
- `DictionaryDatabase` owns a codec instance and an in-memory `Map<dictionary_id, Uint8Array>`
  cache of `codec_dict`, loaded lazily on first read of that dictionary and reused for the
  worker's lifetime. Decompression of the few matched rows per query is negligible.
- Implementations, in order of adoption: `identity` (no compression — for first correctness
  pass), `deflate` (pako, 32 KB preset dict — interim, pure JS), `zstd` (custom WASM, trained —
  final, 5.5×).

### 8.3 Where SQLite initializes

In the DB worker (`dictionary-database-worker-main.js`): `import sqlite3InitModule` from the
vendored build, `await sqlite3InitModule()`, `await installOpfsSAHPoolVfs({name:'yomitan',
initialCapacity: N})`, open `new pool.OpfsSAHPoolDb('/dict.sqlite3')`. `DictionaryDatabase.prepare()`
becomes an async SQLite init instead of `Database.open(...)`. Only the worker holds the
connection; the main-thread `DictionaryDatabase` continues to proxy via
`dictionary-database-worker-handler.js`.

### 8.4 Migration

- New backend uses a **new OPFS file**; it does not read the old IndexedDB `dict`.
- On first run of the new backend: detect a non-empty legacy IndexedDB `dict` (or a
  version/marker), tell the user their dictionaries must be **re-imported** (decision already
  made: "require re-import"), let them re-import, then **`indexedDB.deleteDatabase('dict')`** to
  reclaim the ~1.2 GB. Provide a clear settings-page path for this.
- Call `navigator.storage.persist()` after setup to reduce eviction risk.

---

## 9. Staged implementation plan

Each stage ends green (lint + tsc + relevant tests). Use a feature flag
(`useSqliteBackend`, off by default) so the IndexedDB path keeps working until parity is proven,
then flip and remove it.

### Stage 0 — prep / plumbing (no behavior change)

1. Vendor SQLite-WASM: `npm pack @sqlite.org/sqlite-wasm`, place `index.mjs`→`sqlite3.js` +
   `sqlite3.wasm` under `ext/lib/sqlite/` (note: `ext/lib/*` is gitignored and populated by
   `npm run build:libs`; either add these to the libs build step in `dev/bin/build-libs.js`, or
   place them in a non-ignored dir like `ext/js/dictionary/sqlite/` and add to
   `web_accessible_resources` if needed). Confirm the build copies them (build.js does
   `fs.cpSync(extDir, …, {recursive:true})`).
2. Fix CSP: in `dev/data/manifest-variants.json`, the **safari** variant, change
   `script-src 'self' 'unsafe-eval'` → `script-src 'self' 'wasm-unsafe-eval'`. Rebuild and
   confirm the CSP warning is gone and WASM still loads.
3. Add the `PayloadCodec` interface + an `identity` implementation.
4. Add the `useSqliteBackend` flag (a build/const flag is fine to start).

### Stage 1 — vertical slice (prove the pipeline)

1. Implement a `SqliteDictionaryDatabase` (or branch inside `DictionaryDatabase`) that: inits
   SQLite in the worker, creates the schema, implements `bulkAdd('terms', …)` (writing packed
   payloads via the codec, resolving `dictionary_id`), and implements `findTermsBulk` for
   `matchType:'exact'` only.
2. Make the importer write terms through it when the flag is on.
3. Get **one** test path green: import a small fixture and assert an exact `findTermsBulk`
   result equals the IndexedDB backend's. Reuse `test/dictionary-data.test.js` fixtures.
   - Testing in node: `@sqlite.org/sqlite-wasm` has a node entry (`dist/node.mjs`); use an
     in-memory or temp-file VFS in node (not OPFS). Abstract the VFS selection so tests use the
     node/memory VFS and the extension uses OPFS SAH-Pool.

### Stage 2 — full query + admin coverage

Port every method to SQL, matching current semantics exactly (read the current implementations
first): `findTermsBulk` (exact/prefix/suffix), `findTermsExactBulk`, `findTermsBySequenceBulk`,
`findTermMetaBulk`, `findKanjiBulk`, `findKanjiMetaBulk`, `findTagMetaBulk`, `findTagForTitle`,
`getMedia`; and admin: `dictionaryExists`, `getDictionaryInfo`, `getDictionaryCounts`,
`deleteDictionary` (SQL `DELETE ... WHERE dictionary_id=?` — reclaim via periodic `VACUUM`),
`purge` (drop/recreate or delete the OPFS file), `getAllDictionaries`. Keep the result builders
(`_createTerm` etc.) but source their fields from decoded payloads + columns.

- prefix → range query; suffix → reverse column or `LIKE '%'||term` (search-page only).
- Make **all** of `test/database.test.js` + `test/dictionary-data.test.js` +
  `test/dictionary-data-validate.test.js` pass against the SQLite backend.

### Stage 3 — compression

1. Implement `deflate` codec (pako, 32 KB preset dict built from a sample of the dictionary's
   own payloads at import). Store `codec` + `codec_dict` on the `dictionaries` row. Wire encode
   on import, decode on read (with the per-dictionary dict cache). Re-run tests. Measure real
   OPFS file size on a full `kty-de-en` import.
2. Produce/vendor the **zstd WASM build** with `ZDICT_trainFromBuffer` + dict compress/decompress.
   Implement the `zstd` codec: at import, collect a sample of encoded payloads, `train()` a
   ~112 KB dictionary, store it, compress all payloads. Swap codec, re-measure (target ~46 MB
   payload, ~100 MB total DB). Keep `deflate`/`identity` as fallbacks selectable per dictionary
   (the `codec` column makes rows self-describing).

### Stage 4 — migration + persistence + polish

1. Detect legacy IndexedDB `dict`; add a settings-page migration prompt: re-import, then
   `indexedDB.deleteDatabase('dict')`. Confirm the ~1.2 GB is reclaimed (`navigator.storage.estimate`).
2. `navigator.storage.persist()`.
3. `ANALYZE`/`VACUUM` after import; tune PRAGMAs (page_size, synchronous, temp_store).
4. Handle SAH-Pool capacity growth (files pre-allocated; ensure it grows for large DBs).

### Stage 5 — flip + cleanup

Flip `useSqliteBackend` default on; remove the IndexedDB code path for `dict` (the generic
`Database` wrapper may still be used elsewhere — check before deleting). Remove Layer 1's
IndexedDB-specific packing if fully superseded (the payload array shape carries over to the
codec, so most of it stays). Update docs. Remove the feature flag.

---

## 10. Testing strategy

- **Unit (node):** run the SQLite backend under node via `@sqlite.org/sqlite-wasm`'s node build
  with an in-memory/temp VFS. Parameterize the existing fixture tests to run against both
  backends during transition; require the SQLite backend to match. Round-trip encode/decode
  unit tests for each codec (including empty glossary, structured content, images, `null`
  definitionTags, missing sequence/termTags, V1 vs V3 shapes).
- **Static:** `npx eslint`, `npx tsc --noEmit -p jsconfig.json`, `npm run build` (or
  `-- --target safari`) after each stage. Full suite: `npm test`.
- **Size measurement:** import full `kty-de-en`, read the OPFS file size (spike showed
  `navigator.storage.estimate()` works; also can stat the SAH-Pool files). Compare to the ~1.2 GB
  baseline. Record numbers back into this doc.
- **In-Safari smoke:** `./rebuild-safari.sh` (now safari-only), import a dictionary, scan
  German text, verify popup content + Anki fields + audio unaffected. iOS optional (harder to
  set up; see DEV.md Tailscale section).

---

## 11. Risks / open questions

- **Node test harness for SQLite.** The current tests assume fake-indexeddb. Making the SQLite
  backend testable in node (VFS selection, async init) is the main new test-infra cost. Resolve
  early in Stage 1.
- **zstd WASM build with ZDICT.** Producing a custom build is a sub-project. Interim
  deflate/pako (3.55×) de-risks the schedule; zstd is a codec swap.
- **SAH-Pool specifics:** capacity pre-allocation and growth; whether WAL is usable; behavior on
  quota pressure/eviction (call `persist()`). Verify large-DB (>1 GB pre-compression import,
  ~100 MB post) works, not just 20k rows.
- **`.wasm` MIME** in the Safari extension → streaming fails, ArrayBuffer fallback works.
  Acceptable; optionally fix MIME.
- **Bundle size:** +~845 KB (`sqlite3.wasm`) +~565 KB (`sqlite3.js`) + zstd WASM. Fine for a
  desktop/iOS extension but note it.
- **Concurrency:** ensure exactly one SQLite connection (the worker). Confirm no other context
  opens the OPFS DB (import UI, settings). All access already funnels through the DB worker.
- **Prefix/suffix parity:** get the exact range/LIKE semantics right; add tests for `*foo` and
  `foo*` search-page queries.
- **Upstream divergence:** this replaces Yomitan's storage layer entirely; re-syncing upstream
  DB changes later will require care. Keep the seam clean.

---

## 12. Reference index

Key files:

- Facade + schema + queries: `ext/js/dictionary/dictionary-database.js`
  (`prepare()` has the store/index defs and DB version 60; `_createTerm` ~line 762 is the sole
  term-payload reader; `findTermsBulk` ~line 288; `findTermsExactBulk` ~321;
  `findTermsBySequenceBulk` ~331; `deleteDictionary` ~224; `purge` ~197).
- Generic IndexedDB wrapper: `ext/js/data/database.js`.
- Importer: `ext/js/dictionary/dictionary-importer.js` (`_convertTermBankEntryV3` ~824,
  `_packTermEntry` ~830, `bulkAdd('terms', …)` ~219, `prefixWildcardsSupported` ~141).
- DB worker: `ext/js/dictionary/dictionary-database-worker-main.js`,
  `dictionary-database-worker-handler.js`; offscreen host `ext/js/background/offscreen.js`;
  backend `ext/js/background/backend.js`; translator `ext/js/language/translator.js`
  (`findTermsBulk(..., matchType)` ~464).
- matchType origin: `ext/js/display/display.js` `_getFindDetails` ~1362 (suffix at ~1369);
  inline `wildcards:'off'` in `ext/js/app/frontend.js` ~1195.
- Types: `types/ext/dictionary-database.d.ts` (DatabaseTermEntry / Packed / Payload,
  ObjectStoreData), `types/ext/dictionary-data.d.ts` (TermGlossary), `types/ext/structured-content.d.ts`.
- Options: `ext/data/schemas/options-schema.json` (`prefixWildcardsSupported`,
  `customPopupCss`).
- Manifest/CSP/resources: `dev/data/manifest-variants.json` (safari variant CSP uses
  `'unsafe-eval'` — change to `'wasm-unsafe-eval'`; `web_accessible_resources`). Build:
  `dev/bin/build.js` (`--target safari`; copies `ext/` recursively), `dev/bin/build-libs.js`,
  `build-safari.sh`, `rebuild-safari.sh` (now safari-only), `manual-test/serve.sh`.

Commands:

- Build safari only: `npm run build -- --target safari`.
- Rebuild + install into Safari: `./rebuild-safari.sh` (quits Safari, rebuilds, reinstalls
  in-place to preserve IndexedDB, relaunches).
- Serve manual test pages: `./manual-test/serve.sh` (http://127.0.0.1:8723). iOS over HTTPS:
  enable Tailscale HTTPS certs, then `tailscale serve --bg 8723` (see DEV.md).
- Lint/type/test: `npx eslint <file>`, `npx tsc --noEmit -p jsconfig.json`,
  `npx vitest run <test>`, `npm test`.

Data / libs:

- Baseline dictionary: `kty-de-en` — `https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-de-en.zip`
  (~25 MB zip; ~627 MB pretty-printed term banks; 983,520 term rows; index `format:3`,
  `sourceLanguage:de`, `targetLanguage:en`). Recommended-dictionaries list is
  `ext/data/recommended-dictionaries.json`.
- SQLite-WASM: `npm pack @sqlite.org/sqlite-wasm` (3.53.0). ESM entry `dist/index.mjs`, wasm
  `dist/sqlite3.wasm`, node entry `dist/node.mjs`. SAH-Pool VFS: `sqlite3.installOpfsSAHPoolVfs`
  → `pool.OpfsSAHPoolDb('/path.sqlite3')`. oo1 API used in spike: `db.exec`, `db.prepare` +
  `stmt.bind(i,v).stepReset()` + `stmt.finalize()`, `db.selectValue(sql, bind)`, `pool.unlink`.
- Interim codec: `pako` (deflateRaw/inflateRaw with `dictionary` option, 32 KB preset).
- Final codec: custom **zstd WASM** exporting `ZDICT_trainFromBuffer` + dict compress/decompress.
- Measurement scripts (structured-clone proxy via `v8.serialize`) were written ad hoc in the
  scratch dir during planning: `measure.mjs` (named vs packed sizes), `measure2.mjs`
  (deflate/shared-dict), `breakdown.mjs` (top-level byte breakdown), plus zstd CLI
  `--train`/`-D` for the trained-dict numbers. Recreate as needed from §3–§4.

Feasibility numbers to beat / confirm after implementation: value store 356.8 MB → ~150 MB;
payload 266.8 MB → ~46 MB (zstd+trained); whole DB ~1.2 GB → ~100 MB target.
