# Design: the SQLite dictionary storage backend

**What the system is _now_.** This is the current-state reference for the storage backend — the
schema, the codec, the inflection scheme, the query strategy. It describes the code as it stands, not
how it was arrived at.

- The step-by-step of the two hot paths (import, lookup) is [pseudocode.md](pseudocode.md).
- _Why_ each choice was made, the dead ends, and the retracted measurements are the decision log
  ([decisions.md](decisions.md)) and the evidence in [history/](history/zstd.md) — including the
  feasibility spike and rejected architectures in [history/original-plan.md](history/original-plan.md).
- What is built vs. what remains is [progress.md](progress.md).

The public `DictionaryDatabase` API, the payload shape, and the callers (translator, importer,
display) are unchanged — this is a storage swap behind the facade, selected by one flag.

---

## Overview

The Safari fork stores its dictionaries in an IndexedDB database named `dict`. This backend replaces
that store with **SQLite-WASM on OPFS**, keeping the same public API. Three things do the work:

1. **A columnar SQLite schema** — integer `dictionary_id` instead of a repeated title string, no
   per-row JSON property names, one compressed BLOB per row for the heavy fields.
2. **A per-dictionary payload codec** (deflate) on that BLOB, self-describing so the choice is
   reversible and per-dictionary.
3. **Inflection synthesis** — the dictionary's form-of rows (90% of `kty-de-en`) are dropped at
   import and regenerated on lookup from rules induced from the dictionary itself.

Measured on the recommended German dictionary `kty-de-en` through the real importer: **~700 MB of
IndexedDB → 49.4 MB.** The flag is still off; nothing user-visible has changed yet
([progress.md](progress.md) → Stage 5).

---

## Storage model

One SQLite database file on OPFS, opened with the **SAH-Pool VFS** (`installOpfsSAHPoolVfs` →
`OpfsSAHPoolDb`). SAH-Pool is the VFS that works on Safari without COOP/COEP (no `SharedArrayBuffer`
/ cross-origin isolation, which an extension cannot arrange). It is single-connection, which is
exactly right: the whole backend already lives in one place.

All DB access is funnelled through the existing **DB worker**
(`dictionary-database-worker-main.js`), spawned from Yomitan's offscreen document because the MV3
background is a service worker. Only the worker holds the connection.

`open-sqlite.js` (`openDictionaryDatabaseHandle`) is VFS-agnostic: `vfs:'opfs'` for the extension,
`vfs:'memory'` for tests. The `sqlite3` module is **injected**, never imported inside backend code —
the browser build (`ext/lib/sqlite3.js`) and the node build (`@sqlite.org/sqlite-wasm`) resolve
differently, and the same opener serves both. The vendored module is loaded once and memoized: a
second `sqlite3InitModule()` builds an independent runtime that cannot acquire the pool's exclusive
OPFS handles.

`DictionaryDatabaseSqlite.prepare()` is a drop-in for the IndexedDB `prepare()`: called with no
arguments it self-loads the vendored build, opens the OPFS VFS, and calls
`navigator.storage.persist()`. Tests inject `sqlite3` + `vfs:'memory'`.

---

## Schema

`dictionary-sqlite-schema.js`, at schema version 5 (`PRAGMA user_version`). Columnar tables: indexed
columns are real SQLite columns and serve every lookup the IndexedDB indexes served; the heavy
non-indexed fields live compressed in `payload`.

```sql
CREATE TABLE dictionaries (
    id               INTEGER PRIMARY KEY,
    title            TEXT NOT NULL UNIQUE,
    revision         TEXT,
    version          INTEGER,
    summary_json     TEXT,
    codec            TEXT,   -- which codec wrote this dictionary's payloads (null = identity)
    codec_dict       BLOB,   -- the codec's preset/trained dictionary for those payloads
    inflection_table BLOB,   -- rules induced from this dictionary's form-of entries (codec-encoded)
    stub_template    BLOB    -- the shared payload of the dropped rows; non-null ⇒ rows were dropped
);

CREATE TABLE terms (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    expression    TEXT NOT NULL,
    reading       TEXT NOT NULL,
    sequence      INTEGER,
    payload       BLOB NOT NULL   -- codec([definitionTags, rules, score, glossary, termTags])
);
CREATE INDEX ix_terms_expression ON terms(expression);
CREATE INDEX ix_terms_reading    ON terms(reading) WHERE reading <> expression;
CREATE INDEX ix_terms_sequence   ON terms(dictionary_id, sequence);

-- term_meta, kanji, kanji_meta, tag_meta, media: dictionary_id FK + indexed key column(s);
-- kanji.payload is codec([onyomi, kunyomi, tags, meanings, stats]); meta/tag/media use plain
-- columns + data_json. Each has an index on its key column and on dictionary_id.
```

Design points, and the three that are load-bearing enough to be easy to break:

- **`dictionary_id` (int) replaces the repeated title string** everywhere. Queries that filter on
  "which dictionaries are enabled" translate titles → ids once.
- **`terms.payload` is one BLOB**, so a columnar row carries no per-row property names.
- **`ix_terms_reading` is partial on `reading <> expression`, not `reading <> ''`.** The importer
  rewrites an empty reading to the expression, so no row ever has `reading = ''`; the useful
  predicate is `<> expression`. On German this indexes 0 rows (every reading equals its expression,
  and the expression probe already finds those); on Japanese it indexes exactly the rows a reading
  probe can contribute. **The reading probe must repeat this literal** (`AND reading <> expression`)
  or SQLite refuses the partial index — with `INDEXED BY` it fails to compile (`no query solution`),
  it does not silently scan.
- **No `ix_terms_dictionary`.** It would be a strict prefix-duplicate of
  `ix_terms_sequence(dictionary_id, …)`, which already serves the per-dictionary count and delete.
- **Schema migrations run before the DDL**, because `CREATE … IF NOT EXISTS` will not alter an
  object that already exists. `createDictionarySchema` drops/rebuilds changed indexes and `ALTER`s
  in new columns by `user_version`, then runs the DDL. Every migration to date is index- or
  column-only — no re-import.

---

## Payload codec

The heavy term fields are serialized to compact JSON and compressed per row, so any single row stays
randomly decodable. The seam is `PayloadCodec`:

```
interface PayloadCodec {
  readonly name: 'identity' | 'deflate' | 'zstd';
  prepare?(): Promise<void>;                             // load a WASM/JS module (async); read paths never train
  train(samples: Uint8Array[]): Promise<Uint8Array>;     // build a preset dictionary from sample payloads
  encode(payload: unknown[], dict: Uint8Array | null): Uint8Array;
  decode(blob: Uint8Array, dict: Uint8Array | null): unknown[];
}
```

- **The shipped codec is `deflate`** (pako, raw DEFLATE + a 32 KB preset dictionary trained from the
  dictionary's own first batch). Pure JS, no WASM, ~3.55× on the payload. `identity` (JSON, no
  compression) is the default and leaves `codec` null, so its path is byte-identical to storing raw
  JSON.
- **Rows are self-describing.** `dictionaries.codec` + `codec_dict` record which codec wrote a
  dictionary and its preset. On read, the codec is chosen from a registry by that column; on import,
  the write codec is resolved and trained **once per dictionary** before the (synchronous) insert
  transaction, because `train()` is async. A later codec change never invalidates existing imports.
- `encode`/`decode` are synchronous by contract — they sit inside SQLite's synchronous query and
  transaction paths. Only `prepare()` and `train()` are async.

A codec is a compression choice, not a correctness one; `zstd` was built against this same seam and
rejected on the measurements ([history/zstd.md](history/zstd.md)).

---

## Inflection synthesis

This is where the size actually comes down, and it is a schema/importer change, not a codec one.

**The observation.** In `kty-de-en`, 90% of rows are form-of _stubs_ — `geschützt → past participle
of schützen`. A stub is never displayed: `translator._getDeinflections` strips form-of definitions,
so a stub row exists only so that a lookup of the surface form can find the lemma and its inflection
labels. It carries ~3.6 bytes of real information (a lemma pointer + a label id) and costs ~71 bytes
stored — 60.5 MB of the 71.5 MB payload, for morphology.

**The scheme.** At import, induce rules from the dictionary's own `(form, lemma)` pairs; drop every
stub row the rules can reproduce; synthesize those rows back on an exact lookup. Because the rules
are induced from the dictionary's own pairs, they are exactly consistent with it — this is a
_compression_ of the inflection table, not a morphological analyser, and it cannot analyse a form the
dictionary never listed. Full rule model in `inflection-rules.js` and [pseudocode.md](pseudocode.md);
the short version:

- **A rule is an affix change around a shared core** (the longest common substring):
  `geschützt/schützen → ge>|t>en`. Modelling the prefix, not just the suffix, is what makes it work
  on German — its productive morphology is circumfixing (`ge-…-t`) and periphrastic
  (`würde ge-…-t haben`), which a suffix-only model must mint a unique rule for. (70,247 rules vs.
  462,003 for the same coverage.)
- **Rule count is a knob** trading storage against lookup work. The shipped budget is **K = 1,000**
  (~76% of stub rows derivable, benchmarked ~0.2 ms/hover in `word` mode). The table is stored as one
  codec-encoded BLOB (`dictionaries.inflection_table`), not as rows — it only pays for itself
  compressed (1.42 MB vs. ~11–15 MB as rows).

**Correctness rests on three facts about the drop decision** (all enforced in code, because they are
facts about _this_ dictionary, not the format):

- A row is dropped only if it is a **pure stub** (no real glossary text a reader would lose), the
  rules derive **every** pair it states, and its non-glossary fields equal the shared `stub_template`.
- Synthesis emits **one entry per dictionary carrying every derived pointer**, matching how the
  dictionary groups pointers per row (`Rappen` states nine in one row). The right equivalence is not
  entry-identity but the _set_ of `[lemma, labels]` pointers `translator._getDeinflections` consumes.
- **`stub_template` non-null is the sole licence to synthesize.** Keying off the rules existing
  instead would double every deinflection on a database that has the rules but still has all its rows.

**Accepted, tested limits:** a wildcard lookup cannot see a dropped form (a wildcard asks which
_stored_ forms match; the hover path is `matchType:'exact'`, so this is confined to the search page's
explicit `*`). `findTermsExactBulk`/`findTermsBySequenceBulk` no longer see dropped stubs either.

**The translator does not change at all.** The rules compress the _dictionary_ deinflection path,
which is driven entirely by what `findTermsBulk` returns; nothing reaches `MultiLanguageTransformer`.

---

## Query strategy

`findTermsBulk` probes the `expression` column, then the `reading` column, deduplicating rows across
the whole result by id — mirroring the IndexedDB backend exactly. Two things keep it fast on a
947k-row dictionary:

- **`INDEXED BY` pins the index for exact and prefix probes.** SQLite has a query planner and
  IndexedDB does not; these probes always want a seek, which is what the planner cannot be trusted to
  choose (it once picked a ~75 ms full scan for a reading probe on statistics it read correctly but
  could not apply to the probed value). Pinning the index guarantees the seek IndexedDB gave for
  free. Suffix has no index and scans on purpose (search-page only).
- **Prepared statements are cached.** `findTermsBulk` loops per candidate; preparing and finalizing a
  statement per call was ~85% of query time. A small statement cache makes today's hover ~5–10×
  cheaper on the SQL.

Match semantics: `exact` → `expression = ?`; `prefix` → inclusive range `[term, term+'￿']`
(BMP-valid, matching `IDBKeyRange.bound`); `suffix` → JS `endsWith` filter.

---

## Migration

The new backend uses a **new OPFS file** and does not read the old IndexedDB `dict`. On first run it
detects a non-empty legacy `dict`, has the user re-import, then
`indexedDB.deleteDatabase('dict')` to reclaim the old storage, and calls
`navigator.storage.persist()`. Helpers exist (`dictionary-storage-migration.js`:
`legacyIndexedDbDictionaryExists`, `deleteLegacyIndexedDbDictionary`, `requestPersistentStorage`);
the settings-page UX that drives them is not built yet ([progress.md](progress.md) → Stage 5).

This is a fork; upstream on-disk compatibility is a non-goal, and re-import (rather than a dual-format
reader) is a deliberate choice.

---

## Integration

- **Selection lives in one factory** (`dictionary-database-factory.js`, `createDictionaryDatabase()`),
  used by all three sites that construct the real database (`background/backend.js`,
  `background/offscreen.js`, the DB worker handler). With `USE_SQLITE_BACKEND` off it returns exactly
  `new DictionaryDatabase()` — no SQLite/WASM/pako is touched at runtime. Flipping the flag is a
  one-line change.
- **The SQLite backend is cast to `DictionaryDatabase`** at the factory/test seams; the two backends
  share the public surface but are separate classes (a shared interface is a follow-up).
- **Result builders** (`_createTerm`, `_createKanji`, …) mirror the IndexedDB backend's, sourcing
  their fields from decoded payloads + columns, so callers see identical objects.

---

## Testing

- **Node/vitest** is the backend test environment, `:memory:` VFS, in the **plain node env** (jsdom
  swaps the global typed-array constructors and breaks sqlite-wasm's heap views). Parity tests import
  fixtures through the real importer and assert the SQLite backend matches the IndexedDB backend and
  the canonical translator results, across `{identity, deflate}`.
- **Real Safari** (`npm run test:safari`) runs the backend against the real vendored WASM in the
  browser users actually run, driven by `open -g -a Safari` (no focus steal). It has caught two bugs
  node could not: the singleton requirement, and handing a WASM-heap view to `TextDecoder`.
- **Query-plan regression** (`dictionary-database-sqlite-query-plan.test.js`) runs
  `EXPLAIN QUERY PLAN` on the SQL the backend issues and asserts `SCAN terms` never appears — a class
  of bug correctness tests cannot catch, since results are identical either way.

Full status, the file map, and the live watch-outs are in [progress.md](progress.md).

---

## Reference

Key files:

- Backend: `ext/js/dictionary/sqlite/dictionary-database-sqlite.js` (the whole surface),
  `open-sqlite.js` (VFS-agnostic opener), `dictionary-sqlite-schema.js` (DDL + migrations),
  `inflection-rules.js` (induction/derivation), `dictionary-storage-migration.js` (legacy IDB).
- Codec: `ext/js/dictionary/payload-codec.js` (identity), `deflate-payload-codec.js` (deflate),
  `dictionary-database-factory.js` (selection), `dictionary-backend-config.js` (`USE_SQLITE_BACKEND`).
- Types: `types/ext/sqlite-wasm.d.ts`, `types/ext/pako.d.ts`, `types/ext/payload-codec.d.ts`,
  `types/ext/dictionary-database.d.ts` (`PayloadCodecName`, the packed-payload types).
- Build/vendor: `dev/build-libs.js` (`copySqlite()`, `dev/lib/pako.js`),
  `dev/data/manifest-variants.json` (safari CSP → `'wasm-unsafe-eval'`).

Commands: see [README.md](README.md).
