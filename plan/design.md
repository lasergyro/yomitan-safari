# Design: the SQLite dictionary storage backend

**What the system is _now_.** This is the current-state reference for the storage backend — the
schema, the codec, the inflection scheme, the query strategy. It describes the code as it stands, not
how it was arrived at.

> **Scope note.** The **schema, codec, inflection synthesis and query strategy below are current and
> carry over unchanged** — they are the durable result of this refactor. What changed underneath them
> is _where the database lives and what hosts the engine_: OPFS in the extension **has been replaced**
> by native SQLite in the app ([native-rewrite.md](native-rewrite.md)), because Safari rotates the
> extension origin on every launch and OPFS cannot survive it
> ([history/safari-opfs-blocker.md](history/safari-opfs-blocker.md)). See
> [../native/README.md](../native/README.md) for what hosts the engine now, and
> [history/README.md](history/README.md) for the in-browser hosting this document used to describe.

- The step-by-step of the two hot paths (import, lookup) is [pseudocode.md](pseudocode.md).
- _Why_ each choice was made is the decision log ([decisions.md](decisions.md)); the dead ends, the
  retracted measurements and the evidence are [history/README.md](history/README.md).
- What is built and what remains is [README.md](README.md) → Status.

The public `DictionaryDatabase` API, the payload shape, and the callers (translator, importer,
display) are unchanged — this is a storage swap behind the facade. It was selected by a flag while
two backends existed; there is now one, and the API is a **type** rather than a class — the concrete
`DictionaryDatabase` class is gone, and what callers are typed against is
`DictionaryDatabaseRead` / `DictionaryDatabaseWrite` (`DictionaryDatabaseApi` is the two together)
in `types/ext/dictionary-database.d.ts` ([decisions.md](decisions.md) #46).

---

## Overview

The Safari fork stored its dictionaries in an IndexedDB database named `dict`. This backend replaces
that store with **SQLite**, keeping the same public API. Three things do the work:

1. **A columnar SQLite schema** — integer `dictionary_id` instead of a repeated title string, no
   per-row JSON property names, one compressed BLOB per row for the heavy fields.
2. **A per-dictionary payload codec** (deflate) on that BLOB, self-describing so the choice is
   reversible and per-dictionary.
3. **Inflection synthesis** — the dictionary's form-of rows (90% of `kty-de-en`) are dropped at
   import and regenerated on lookup from rules induced from the dictionary itself.

Measured on the recommended German dictionary `kty-de-en` through the real importer: **~700 MB of
IndexedDB → 49.4 MB.**

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
  readonly name: 'identity' | 'deflate';                    // PayloadCodecName; zstd went with #26
  prepare?(): Promise<void>;                                // load a WASM/JS module (async); read paths never train
  train(payloadSamples: unknown[][]): Promise<Uint8Array>;  // build a preset dictionary from sample payloads
  encode(payload: unknown[], dict: Uint8Array | null): Uint8Array;
  decode(blob: Uint8Array, dict: Uint8Array | null): unknown[];
}
```

The authority is [`types/ext/payload-codec.d.ts`](../types/ext/payload-codec.d.ts); the union lives in
`types/ext/dictionary-database.d.ts` as `PayloadCodecName`.

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

## Testing

- **Node/vitest** is the backend test environment, `:memory:` VFS, in the **plain node env** (jsdom
  swaps the global typed-array constructors and breaks sqlite-wasm's heap views). Parity tests import
  fixtures through the real importer and assert the backend reproduces the canonical translator
  results, across `{identity, deflate}`. (Until #46 they also compared against the IndexedDB backend,
  which no longer exists.)
- **The native host** (`npm run test:jsc`) answers the same requests through node and through the
  real Swift host over system `libsqlite3`, against the same compiled database, and requires
  identical replies ([native-protocol.md](native-protocol.md)). It replaced `npm run test:safari`,
  which ran this backend against the vendored WASM in real Safari and was deleted with the
  in-browser backend; the two bugs only it ever caught — the sqlite3 singleton requirement and
  handing a WASM-heap view to `TextDecoder` — are recorded in
  [history/README.md](history/README.md#watch-outs-that-no-longer-bind).
- **Query-plan regression** (`dictionary-database-sqlite-query-plan.test.js`) runs
  `EXPLAIN QUERY PLAN` on the SQL the backend issues and asserts `SCAN terms` never appears — a class
  of bug correctness tests cannot catch, since results are identical either way.

---

## Watch-outs

Live traps, each one paid for once. The ones that stopped binding when the engine left the browser
are in [history/README.md](history/README.md#watch-outs-that-no-longer-bind) — worth a glance before
assuming a new host is uneventful.

- **Safari's native-messaging bridge is cheap.** ~1 ms fixed per round trip, ~60 MB/s throughput,
  symmetric and linear, measured against the installed extension
  ([native-engine-probe.md](native-engine-probe.md)). Assume nothing worse without re-measuring; the
  earlier assumption that it would be prohibitive was wrong by roughly an order of magnitude. Caveat:
  that was a flat ASCII payload, not nested objects with BLOBs.
- **Safari has no `connectNative`.** One-shot request/response only — no long-lived port, no server
  push. Nothing may depend on being able to push.
- **Safari never grants `navigator.storage.persist()`**, and it is not a manifest problem:
  `unlimitedStorage` is declared and present in the installed manifest, `persist` is a function, and
  it still resolves `false` — on an extension page and on a plain `127.0.0.1` page alike, so it is
  WebKit-wide. The live consequence is in the UI: the settings **"Persistent storage" toggle is inert
  on Safari**, because `_isPersistentStorageSupported()` only checks that the method exists, so it
  renders a control that can never switch on.
- **jsdom breaks sqlite-wasm.** vitest's jsdom setup swaps the global typed-array constructors
  mid-test, breaking the WASM heap views (`jstrcpy() target must be an Int8Array or Uint8Array`). The
  SQLite tests therefore run in the plain node env; findTerms/findKanji don't need the DOM. Node's
  SQLite-WASM is what vitest and the node half of `test:jsc` run on.
- **A dead dynamic import can still be bundled — check the metafile, not the call sites.** The
  deflate codec kept an `import('../../lib/pako.js')` fallback for when nothing was injected. After
  the engine moved native no caller took it, but esbuild resolves a literal dynamic import
  statically, so `ext/lib/pako.js` went into `yomitan-core.js` **beside** the `node_modules` copy —
  pako shipped twice in the artifact whose parse cost is paid on every cold start.
  `build-native-core.js --metafile` is how it was found and how to check for the next one.
- **`typedef` aliases of imported types resolve to `any` under typescript-eslint.** Reference types as
  a **direct** `import('payload-codec').PayloadCodec`; a local `@typedef {import(...)} PayloadCodec`
  alias type-checks under tsc but the type-aware lint rules see `any`. (`@implements` is the
  exception — it cannot take an inline `import()`, so it needs the alias.)
- **`dictionary_id` ordering**: insert the `dictionaries` row before its terms. FK enforcement is
  currently OFF (no `PRAGMA foreign_keys=ON`).
- **JSON round-trip quirk**: JSON turns `undefined` array elements into `null` on decode (e.g.
  missing `termTags`). `_splitField` tolerates it.
- **Suffix has no reverse column.** It filters in JS over the enabled dictionaries (full scan).
  Acceptable because suffix is search-page-only (`*foo`), but revisit if it shows up hot.

---

## Reference

Key files:

- Backend: `ext/js/dictionary/sqlite/dictionary-database-sqlite.js` (the whole surface),
  `open-sqlite.js` (module-injecting opener), `dictionary-sqlite-schema.js` (DDL + migrations),
  `inflection-rules.js` (induction/derivation).
- Codec: `ext/js/dictionary/payload-codec.js` (identity), `deflate-payload-codec.js` (deflate).
- Host: `ext/js/native/` (the engine entry point, the client shim and the wire encoders) and
  `native/` (the Swift host) — see [native-protocol.md](native-protocol.md).
- Types: `types/ext/sqlite-wasm.d.ts`, `types/ext/pako.d.ts`, `types/ext/payload-codec.d.ts`,
  `types/ext/dictionary-database.d.ts` (`PayloadCodecName`, the packed-payload types),
  `types/ext/native-bridge.d.ts` (`EngineApiSurface`).
- Build/vendor: `dev/bin/build-native-core.js` (the JSC bundle — and how pako reaches the codec, from
  `node_modules`; `dev/build-libs.js` no longer vendors either pako or sqlite for the browser).
  `dev/data/manifest-variants.json`'s safari CSP `'wasm-unsafe-eval'` was added for `sqlite3.wasm`
  and outlived it; it is still required, but now only by `ext/lib/resvg.wasm`.

The map of what this refactor added or changed, as it stands in the tree. The native side has its own
in [../native/README.md](../native/README.md); what was **deleted** along the way is in
[history/README.md](history/README.md#what-the-refactor-deleted).

```
plan/                                    README, design, pseudocode, decisions,
                                         native-rewrite, native-protocol, native-engine-probe
plan/history/                            the record: README (historical decisions, the progress
                                         log), safari-opfs-blocker, safari-idb-snapshot,
                                         backend-worker, sizing, zstd, original-plan
ext/js/dictionary/payload-codec.js               IdentityPayloadCodec
ext/js/dictionary/deflate-payload-codec.js       DeflatePayloadCodec (pako, injected)
ext/js/dictionary/dictionary-importer.js         build-time only now: compile:dictionary + tests
ext/js/dictionary/sqlite/open-sqlite.js          openDictionaryDatabaseHandle()
ext/js/dictionary/sqlite/dictionary-sqlite-schema.js   DDL + createDictionarySchema()
ext/js/dictionary/sqlite/dictionary-database-sqlite.js DictionaryDatabaseSqlite (the backend)
ext/js/dictionary/sqlite/inflection-rules.js     induction/derivation
ext/js/native/                           the engine entry point, the client shims, wire encoders
native/Sources/YomitanNative/            the Swift host (incl. the `ping` latency probe)
build-safari.sh                          bundles the engine, regenerates + patches the Xcode project
dev/bin/compile-dictionary.js            the shipped pipeline: .zip -> .sqlite3
dev/bin/build-native-core.js             the JSC bundle
dev/measure-storage.js                   codec/size measurement (npm run measure:storage)
types/ext/sqlite-wasm.d.ts               narrow sqlite oo1 type surface
types/ext/pako.d.ts                      narrow pako surface
types/ext/payload-codec.d.ts             PayloadCodec type (+ optional prepare())
types/ext/dictionary-database.d.ts       PayloadCodecName, DictionaryDatabaseRead/Write (#46),
                                         and Layer 1's Packed/Payload types
types/ext/native-bridge.d.ts             EngineApiSurface, NativeHost
test/sqlite-backend-smoke.test.js        harness + opener/schema tests
test/dictionary-database-sqlite-codec.test.js       codec self-description + finalizeImport
test/dictionary-database-sqlite-inflection.test.js  induction on/off through the real importer
test/dictionary-database-sqlite-query-plan.test.js  guards term lookups against full scans
test/inflection-rules.test.js            induceInflectionRule / applyInflectionRule
test/deflate-payload-codec.test.js       deflate codec round-trips
test/translator-sqlite.test.js           49 fixtures × {identity, deflate} end-to-end
test/native-host-shims.test.js           host shims, protocol encoders, the Swift schema literal
```

Commands: see [README.md](README.md).
