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

## zstd task, and what came out of it

The zstd evaluation and its fallout. #21–#25 describe an implementation that has since been
**deleted** (#26) — they are kept because the numbers and constraints behind the rejection are worth
not rediscovering; read them as history, not as description of the tree. #26–#27 are live.

These belong with #10–#15 by theme but live here because appending is the only safe place to add
one — see the note at the top.

21. _(historical — zstd removed in #26)_ **The zstd WASM build was a committed _script_, not a committed artifact.** — No published zstd
    WASM build exposes `ZDICT_trainFromBuffer` (verified: `@bokuweb/zstd-wasm` and `zstd-codec` have
    no `ZDICT_*` symbols), so unlike every other lib it cannot come from npm; `dev/zstd/build.sh`
    builds it from source and `npm run build:libs` copies the result to `ext/lib/`. What is
    committed is the reproducible build (pinned zstd version + sha256, refusing to run on a
    mismatch), not its ~500 KB output — `dev/vendor/` is gitignored like `ext/lib/`, and the build
    was cached locally. The cost was that a fresh clone had to run `npm run build:zstd` once (needs
    emscripten) before the zstd tests or a build; there is no CI to serve, so a local cache sufficed. `-sSINGLE_FILE=1` embeds the wasm in the .js: one artifact, no sibling-`.wasm` path
    resolution, and Safari's missing `application/wasm` MIME (#18 / the `instantiateStreaming`
    fallback) never comes up, for ~8% size (502 KB vs 464 KB split). — _adopted._
22. **`PayloadCodec.prepare?()`, awaited by `DictionaryDatabaseSqlite.prepare()`.** _(still live: deflate uses it to self-load vendored pako.)_ — `encode`/
    `decode` are synchronous because they sit inside sqlite's synchronous query/transaction paths,
    but a WASM-backed codec must load its module first, and reading already-imported rows never
    calls `train()` — so there is no other async moment to initialize in. Optional, so identity and
    deflate ignore it. — _adopted._
23. _(historical — zstd removed in #26)_ **Default zstd level was 15, not the 19 the design assumed.** — Measured sweep: the ratio plateaus
    at 15 (15/19/22 identical) while 19 costs ~3× the encode time. Structural rather than corpus-
    specific: at ~330 B/row a longer match search finds nothing extra, since the redundancy resolves
    against the shared dictionary, not within the row. — _adopted; **confirmed on real data**
    (−15 → 3.14×, −19 → 3.15× on `kty-de-en`)._
24. **Codec tuning is a constructor option, not a constant.** — `DictionaryDatabaseSqlite` takes
    `trainSampleSize` (and the removed `ZstdPayloadCodec` took `level`/`dictionaryCapacity`), because the
    real measurements show the tradeoff is a judgement call rather than a fact: dictionary size is
    the dominant lever on ratio (110 KB → 3.15×, ~2 MB → 4.63×), it costs nothing on decode, but a
    bigger dictionary is only trainable by buffering proportionally more of the import (ZDICT wants
    ~100× the dictionary size in samples). `npm run measure:storage` re-derives it against the
    real dictionary. — _adopted._
25. **`trainSampleSize` defaults to 1000, the importer's `maxTransactionLength`.** — Training runs on
    the first `bulkAdd` batch, so any larger value was silently unreachable (the old constant of 4000
    was dead). The default now states the real constraint rather than hiding it; raising it means
    also giving the trainer more than one batch. — _adopted._
26. **Ship `deflate`; zstd is measured, rejected, and removed.** — Measured on the real `kty-de-en`
    (`npm run measure:storage`), against the **whole database** rather than the payload: deflate
    **149.7 MB** vs zstd **161.3 MB as it would actually ship** (it can only train on 1,000 rows) or
    ~137 MB with import buffering that does not exist. So the best case saves ~13 MB on ~150 MB —
    ~1% of the original problem — for a custom emscripten toolchain, ~24 MB of WASM heap in the DB
    worker (a live concern on iOS), and that buffering. Decode speed decided nothing: both are tens
    of microseconds per lookup, ~1000× under a frame. **78.1 MB of the database is indexes + row
    overhead, which no codec touches** (49.5 + 28.5 — see [sizing/](sizing/README.md) §1; this was
    previously miscredited entirely to indexes) — so compression cannot reach the ~100 MB target and
    the remaining weight is the schema. The zstd code is deleted rather than left dormant; the evidence is in
    [zstd/](zstd/README.md) and the implementation in git history (`58fe1f50`). The `codec` column
    makes this reversible. — _adopted; `createDictionaryDatabase()` now builds
    `new DeflatePayloadCodec()`._
27. **Pin the term index with `INDEXED BY`; do not let the planner choose.** — Every row of a German
    dictionary has `reading = ''`, so ANALYZE records ix*terms_reading as completely unselective and
    the planner full-scans the table for a reading probe: **75 ms per lookup** on 947k rows, on the
    hover path, vs 0.02 ms with the index. The estimate is right on average and wrong for the probe,
    which is a shape SQLite's stat1 cannot express. IndexedDB had no such failure mode — an index
    probe always seeks — and these queries want exactly that. Suffix still scans, deliberately: no
    index can serve it. — \_adopted, with a query-plan regression test
    (`dictionary-database-sqlite-query-plan.test.js`); found only by measuring the real dictionary.*

## Storage sizing

Full analysis and every number: [sizing/](sizing/README.md).

28. **Drop `ix_terms_dictionary`; make `ix_terms_reading` partial (`WHERE reading <> ''`).** —
    `ix_terms_dictionary(dictionary_id)` is a strict prefix-duplicate of
    `ix_terms_sequence(dictionary_id, sequence)`, so it is redundant **by construction on every
    dictionary**, not just this one; the count/delete queries that used it still plan as seeks on
    `ix_terms_sequence` (one as a covering index). `ix_terms_reading` holds 947,070 copies of the
    empty string on a German dictionary; partial makes it free there while a Japanese dictionary
    still gets a full one — it adapts to the data instead of guessing. Together **−17.0 MB measured
    on the real dictionary, 149.7 → 132.7 MB (−11.4%)**, no capability lost — 8.5 MB from each. (The
    −26.5 MB quoted while this was being analysed also counted `ix_terms_sequence`, which #29 defers;
    that is a further −9.5 MB.) The partial index **requires** adding the literal
    `AND reading <> ''` to the reading probe: without it the existing `INDEXED BY` fails hard with
    `no query solution` rather than falling back to a scan. — _recommended, NOT yet applied._
29. **Do not make `ix_terms_sequence` partial, and do not adopt `WITHOUT ROWID` yet.** — Both look
    like free wins and neither is. `WHERE sequence > 0` would _change behaviour_: every `kty-de-en`
    row has `sequence = 0` while `index.json` claims `sequenced: true`, so this is a semantics
    question (what does `sequence = 0` mean?) wearing a storage costume — see [sizing/](sizing/README.md)
    §6 for the latent all-rows-match bug it exposes, which is upstream's and not a regression.
    `PRIMARY KEY(expression, id) WITHOUT ROWID` measures well on German (−35.7 MB, seeks still
    0.045 ms) precisely because its reading index is empty — but secondary indexes on a `WITHOUT
ROWID` table reference rows by the full primary key, so a Japanese dictionary's reading index
    would carry `expression + id` per entry. It was measured on the one dictionary that cannot show
    the downside. — _deferred pending a measurement on a Japanese dictionary._
30. **The remaining weight is the dictionary's shape, not the schema or the codec.** — 90% of
    `kty-de-en`'s rows are inflected-form stubs (`geschützt → past participle of schützen`). They are
    **60.5 MB of the 71.5 MB payload**; all 94,931 real definitions together are **11.1 MB**. A stub
    carries ~3.6 B of information (a 17-bit lemma pointer + a 12-bit label) and costs 71 B stored.
    Storing them as `(lemma_id, label_id)` instead of JSON text is worth ~50 MB — more than every
    other lever here combined, and it is an importer/schema change, not a codec one. — _recorded;
    no work scheduled._
31. **Deriving stubs from induced rules beats storing them, and the rule model beats the rule
    budget.** — Rules can be induced from the dictionary's own 849,941 distinct `(form,lemma)` pairs
    with no language knowledge. Modelling a rule as a shared core (longest common substring) plus an
    affix change on each side — rather than suffix-only — cuts the rule table **462,003 → 70,247**,
    paradigm classes **26,711 → 16,129**, the encoding **4.21 → 1.65 MB**, and raises coverage at
    every budget (at 1,000 rules: **76.7% vs 44.0%**). It matters because German's productive
    morphology is circumfixing (`ge-…-t`) and periphrastic (`würde ge-…-t haben`), which suffix-only
    rules cannot express at all — they mint a unique rule per form. Rule count is then a knob:
    K=100 → ~66 MB, K=1,000 → ~46 MB, all → ~20 MB, trading storage against candidate lookups per
    hover. **Precision requires the paradigm check** (naive over-generation is 27–64% precise, and a
    DB lookup does not filter a real-but-wrong word); that check is exact but _tautological_ — it is
    equivalent to consulting the original map — so this is a **compression scheme, not a
    generalisation**, and it cannot analyse a form the dictionary never listed. — _measured, not
    implemented; the open risk is lookup cost, see [sizing/](sizing/README.md) §5.3._
32. **Cache the term-query prepared statements; `findTermsBulk` re-prepares one per candidate.** —
    It loops per term calling `selectObjects`, which runs `sqlite3_prepare` + finalise on every call,
    so a lookup with 434 candidates pays 868 of them. Measured: **~85% of query time is statement
    preparation, not index seeks** (434 candidates: 9.44 ms → 1.52 ms with two cached statements).
    Batching into `WHERE expression IN (?,?,…)` on top of that adds only ~12% more (1.34 ms), so
    caching is the win and batching is a bonus. **This affects the backend as shipped today**, not
    just the inflection work: it makes every hover ~5–10× cheaper on the SQL. It is also what decides
    whether the §5.3 rule expansion is affordable — with it, the full 70,247-rule set costs ~3.4 ms
    per hover instead of ~12. — _measured, not implemented; small and self-contained
    ([sizing/](sizing/README.md) §5.4)._
33. **`searchResolution` drives lookup cost more than anything else, and German recommends `word`.** —
    `translator._getAlgorithmDeinflections` runs the transforms over **every substring** of the scan
    window (`scanning.length`, default 16), stepping by letter or by word per
    `translation.searchResolution` (schema default `letter`; `recommended-settings.json` sets `word`
    for German). Word stepping turns a 16-character window into ~3 substrings instead of 16, a ~5×
    difference in candidates and therefore in lookup cost. Any latency claim about the deinflection
    path is meaningless without stating which mode it assumes. — _recorded; both modes are measured in
    [sizing/](sizing/README.md) §5.4._
