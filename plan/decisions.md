# Decision log

_Why_ the backend is the way it is — the historical record of every choice, including the ones that
were reversed. For _what_ the system does today, read [design.md](design.md) and
[pseudocode.md](pseudocode.md); this log is where you come to find out why, or to check whether a
decision still stands.

Format: **Decision** — rationale — _status_. Read the status: several early decisions have been
superseded or reversed, and are kept only because the constraint behind them is worth not
rediscovering.

- **LIVE** — describes the code today.
- **SUPERSEDED** — the conclusion was later refined; the pointer says by which decision.
- **HISTORICAL** — describes something since removed (chiefly the zstd codec, #21–#25); read as
  history, not as a description of the tree.

**Numbers are permanent IDs**, referenced from the code (e.g. test comments cite `#27`, `#31`,
`#34`) and the other plan docs, so renumbering silently breaks every existing reference.

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
9. _(SUPERSEDED by #26 — zstd was measured and rejected.)_ **Trained zstd dictionary per imported
   dictionary is the target codec** (~5.5× on the payload). — A shared dictionary is required (per-row compression of tiny payloads is
   otherwise net-negative); raw/untrained only gets ~2.8×, trained gets 5.5×. Needs a **custom
   zstd WASM build** exposing `ZDICT_trainFromBuffer`. — _built and tested, **not selected**. The
   ~5.5× **did not reproduce** when finally measured on real `kty-de-en` data: with the parameters
   this decision assumed (110 KB dictionary) zstd gets 3.15× and loses to deflate's 3.55×. Sizing
   the dictionary properly (1.9 MB, needing ~200k training rows buffered) gets 4.47× / 56.8 MB and
   decodes ~8× faster than deflate (2.7 vs 21.4 µs/row). The dictionary-is-mandatory half of this decision holds; the
   number does not. See [zstd.md](history/zstd.md)._

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
    overhead, which no codec touches** (49.5 + 28.5 — see [sizing.md](history/sizing.md) §1; this was
    previously miscredited entirely to indexes) — so compression cannot reach the ~100 MB target and
    the remaining weight is the schema. The zstd code is deleted rather than left dormant; the evidence is in
    [zstd.md](history/zstd.md) and the implementation in git history (`58fe1f50`). The `codec` column
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

Full analysis and every number: [sizing.md](history/sizing.md).

28. _(PARTLY SUPERSEDED — the `ix_terms_dictionary` drop is LIVE; the `WHERE reading <> ''` predicate
    saved nothing and was replaced by `reading <> expression` in #36.)_ **Drop `ix_terms_dictionary`;
    make `ix_terms_reading` partial (`WHERE reading <> ''`).** —
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
    `no query solution` rather than falling back to a scan. — _shipped (schema v2), but its reading
    predicate was superseded by #36; see #35 for why `<> ''` excluded nothing._
29. **Do not make `ix_terms_sequence` partial, and do not adopt `WITHOUT ROWID` yet.** — Both look
    like free wins and neither is. `WHERE sequence > 0` would _change behaviour_: every `kty-de-en`
    row has `sequence = 0` while `index.json` claims `sequenced: true`, so this is a semantics
    question (what does `sequence = 0` mean?) wearing a storage costume — see [sizing.md](history/sizing.md)
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
    implemented; the open risk is lookup cost, see [sizing.md](history/sizing.md) §5.3._
32. **Cache the term-query prepared statements; `findTermsBulk` re-prepares one per candidate.** —
    It loops per term calling `selectObjects`, which runs `sqlite3_prepare` + finalise on every call,
    so a lookup with 434 candidates pays 868 of them. Measured: **~85% of query time is statement
    preparation, not index seeks** (434 candidates: 9.44 ms → 1.52 ms with two cached statements).
    Batching into `WHERE expression IN (?,?,…)` on top of that adds only ~12% more (1.34 ms), so
    caching is the win and batching is a bonus. **This affects the backend as shipped today**, not
    just the inflection work: it makes every hover ~5–10× cheaper on the SQL. It is also what decides
    whether the §5.3 rule expansion is affordable — with it, the full 70,247-rule set costs ~3.4 ms
    per hover instead of ~12. — _measured, not implemented; small and self-contained
    ([sizing.md](history/sizing.md) §5.4)._
33. **`searchResolution` drives lookup cost more than anything else, and German recommends `word`.** —
    `translator._getAlgorithmDeinflections` runs the transforms over **every substring** of the scan
    window (`scanning.length`, default 16), stepping by letter or by word per
    `translation.searchResolution` (schema default `letter`; `recommended-settings.json` sets `word`
    for German). Word stepping turns a 16-character window into ~3 substrings instead of 16, a ~5×
    difference in candidates and therefore in lookup cost. Any latency claim about the deinflection
    path is meaningless without stating which mode it assumes. — _recorded; both modes are measured in
    [sizing.md](history/sizing.md) §5.4._
34. **The induced rules belong in the database backend, not in the translator — and #31's recorded
    blocker was wrong.** — [progress.md](progress.md) recorded Stage B as blocked on an
    architectural clash: the rules are per-dictionary and live in the database, while algorithm
    deinflections come from `MultiLanguageTransformer`, which is language-static and built at
    construction, so "both deinflection paths change together". That framing assumed the rules had to
    enter as _algorithm_ transforms. They do not. The rules compress the **dictionary** deinflection
    path, and that path is driven entirely by what `findTermsBulk` returns, so the backend can delete
    a derivable form-of row at import and synthesize it back on lookup — `_addDerivedTerms` rebuilds
    the same `[lemma, labels]` glossary entry the row held, `translator._getDictionaryDeinflections`
    follows it exactly as before, and `translator._getDeinflections` then strips it as it always did.
    **The translator does not change at all**, and no rule ever reaches
    `MultiLanguageTransformer`. — _implemented (Stage B)._

    **Measured end to end through the real `DictionaryImporter`**, one backend, uncontended: 947,070
    → **293,262 rows**, 170.5 → **56.8 MB** at schema v4, of which the rules cost 1.42 MB and the
    template 17 B. (#36 then empties the now-useless reading index, taking this to **49.4 MB** at
    schema v5 — so the full end state is **170.5 → 49.4 MB, −71%**.) Correctness was verified against
    **the ZIP itself** rather than against a second instance of the same code — for each of 41,921
    sampled forms, the `[lemma, labels]` pointers a lookup yields versus the ones the dictionary
    states: **100.00% exact, 0 lost, 0 invented** (that run used the terms-only harness, whose
    row-level output is identical; only its byte totals were understated). Cost: `finalizeImport`
    124.0s on top of a 152.0s import.

    Four measurements on `kty-de-en` decided the shape, and each killed a simpler design:

    - **The dictionary groups its pointers per row, and the rules cannot recover the grouping.**
      `Rappen` states all nine of its pointers in one row's glossary
      (`[["Rappe",["plural"]],["Rappe",["genitive"]],…]`), in the dictionary's own order. Emitting one
      synthesized entry per derived pointer therefore differs from the stored row on **39% of real
      lookups** while being semantically identical (the translator loops entries × definitions), so
      synthesis emits **one entry per term** carrying every pointer. The lesson generalizes past the
      shape: **entry-identity is the wrong equivalence** — the right one is what
      `translator._getDeinflections` consumes, namely the displayed entries (untouched rows, so exact)
      plus the _set_ of `[lemma, labels]` pointers (order- and grouping-insensitive). A fixture with
      one pointer per row passed the wrong assertion happily.
    - **No mixed rows exist** (0 of 947,070: 94,931 pure-real, 852,139 pure-stub). Dropping a
      derivable row can therefore never destroy glossary text a reader would see — but the code still
      checks, because that is a fact about this dictionary, not about the format.
    - **Every stub row is field-identical** (`definitionTags='non-lemma'`, `rules=''`, `score=0`,
      `termTags=''`, `sequence=0`). So one stored `stub_template` reproduces any of them, and a row
      whose fields differ simply keeps its row. This is why the template is _recorded_ rather than
      assumed: it generalizes to a dictionary whose stubs vary, at the cost of keeping those rows.
    - **12,025 expressions carry both a real row and a stub row.** This is what rules out the obvious
      shortcut of synthesizing only when the lookup found nothing: for those 12,025 the real row
      would suppress the deinflection. Synthesis is therefore unconditional, which in turn forces the
      drop and the synthesis to land in the same commit — with rows present _and_ synthesis on, every
      deinflection would be returned twice.

    Consequences worth stating plainly:

    - **`stub_template` non-null is the sole licence to synthesize** (schema v4). Gating on the rules
      existing instead would double every deinflection on a v3 database, which has the rules but all
      of its rows.
    - **A wildcard lookup cannot see a dropped form.** A wildcard asks which _stored_ forms match a
      pattern, and a dropped form is not stored; synthesis only answers an exact probe. `matchType`
      is `'exact'` on the hover path (`backend.js` defaults it), so this is confined to the search
      page's explicit `*`. Accepted, and pinned by a test rather than left to be discovered.
    - **`findTermsExactBulk` and `findTermsBySequenceBulk` no longer see dropped stub rows either.**
      Both are merge-mode paths, and a form-of stub surfacing there is arguably the latent bug of #29
      / [sizing.md](history/sizing.md) §6 rather than a feature — but this is a behaviour change and is
      recorded as one, not discovered later.
    - **Dictionary ids are reused.** `deleteDictionary` must evict `_inflectionCache`: SQLite reissues
      `INTEGER PRIMARY KEY` values once the rows holding them are gone, so the next imported
      dictionary can be handed a deleted one's id and inherit its rules. Found while writing the
      cache, confirmed by a test that fails without the eviction.

    Two measurement traps worth recording, because both produced a wrong number first:

    - **`finalizeImport` is 300.4s, and it took three tries to measure.** First 2086s — a harness
      holding two 133 MB backends plus every parsed term bank live, in GC thrash; that measured the
      harness. Then "~125s", from summing a phase profile that omitted `ANALYZE`. Then "300.4s", from
      a harness holding an 838k-entry truth Map beside the backend. The honest figure, **through the
      real importer with nothing else held, is 124.0s** on top of a 152.0s import. What the profile
      did establish and the reruns confirmed: the **DELETEs are 1.3s**, i.e. noise, against ~120s for
      the two full decode passes — the opposite of the guess that sent me profiling. (The delete
      alternatives both lose: prepared `DELETE ... WHERE id = ?` per id and a temp-table
      `IN (SELECT …)` are 1.8s each, against 1.3s for batched `IN` lists.) The two decode passes are
      fusable and worth ~60s if this ever matters.
    - **`_selectObjects` materializes.** Walking the 947,070 terms through it holds every payload BLOB
      live at once, twice per `finalizeImport`. The table walks now use a streaming `_iterateObjects`.
    - **Every size number in this section was terms-only until the real importer ran.** The harnesses
      imported only `term_bank_*.json` _and_ wrote `reading: ''`, which left the partial reading index
      empty. Through the real importer the drop-pass result is **170.5 → 56.8 MB at v4, 49.4 MB at v5
      (#36)**, not the 136.65 → 44.56 MB reported earlier. The row count (293,262) was right all along;
      only
      the bytes around it were understated.

## Corrections found by driving the real importer

35. **#27 and #28 were measured on data the importer never produces, and #28's saving does not
    exist.** — `dictionary-importer.js`'s `_convertTermBankEntryV3` does
    `reading = reading.length > 0 ? reading : expression`. So a German dictionary has
    **`reading === expression` on every one of its 947,070 rows, never `''`**. Every measurement
    behind #27, #28 and [sizing.md](history/sizing.md) came from harnesses that wrote packed rows
    straight into `bulkAdd` with `reading: ''`, bypassing that line. Measured through the real
    importer instead (`dbstat`, deflate, all stores):

    | claim                                                  | what was believed             | what is true                                  |
    | ------------------------------------------------------ | ----------------------------- | --------------------------------------------- |
    | rows with `reading = ''`                               | 947,070 (all)                 | **0**                                         |
    | `ix_terms_reading` entries under `WHERE reading <> ''` | 0 (index empty)               | **947,070 (excludes nothing)**                |
    | `ix_terms_reading` size                                | ~0 after #28, was ~8.5 MB     | **25.67 MB**                                  |
    | `sqlite_stat1` for it                                  | `947070 947070` (unselective) | **`947070 1` (perfectly selective)**          |
    | reading probe plan without `INDEXED BY`                | full scan (#27's bug)         | **`SEARCH ... USING INDEX ix_terms_reading`** |

    So: **#28's −8.5 MB is fiction** — its partial predicate excludes nothing. **#27's premise is
    gone** — the planner picks the index unaided, because readings are unique rather than 947,070
    copies of one value; the `INDEXED BY` pin is harmless but is not preventing what it documents.
    `dictionary-database-sqlite-query-plan.test.js` asserting `sqlite_stat1 = '0 0'` was green only
    because it builds `reading: ''` rows through `bulkAdd`. — _correction recorded; #28's predicate is
    replaced by #36. #27's pin is kept deliberately (see #36)._

36. **The right partial predicate is `reading <> expression`, and it delivers what #28 promised.** —
    `findTermsBulk` probes the expression column first and dedups by row id, so a row with
    `reading === expression` is _always_ already returned by the expression probe; the reading probe
    can never contribute it. The reading index therefore only needs rows whose reading differs from
    their expression. On German that is **0 of 947,070 rows — a genuinely empty index** (its B-tree
    was 25.67 MB by `dbstat`); measured through the real importer the whole file drops **170.5 →
    147.5 MB (−23.0 after VACUUM) undropped, and 56.8 → 49.4 MB combined with the Stage B drop**. On a
    Japanese dictionary it indexes exactly the rows that need it.
    Same coupling caveat as #28: the probe must carry the literal `AND reading <> expression` or
    SQLite cannot use the index, and with `INDEXED BY` it fails hard with `no query solution`. The
    `INDEXED BY` pin (#27) is kept even though its original premise is gone: it guarantees a reading
    probe always seeks the index rather than ever letting the planner reconsider a scan, which is what
    IndexedDB did and what the hover path wants. — _implemented (schema v5); the query-plan test now
    builds `reading === expression` rows and asserts the index holds only the distinct-reading ones._

37. **Import is ~90% pako deflate, and that is a knob nobody had priced.** — Through the real
    importer on `kty-de-en`: **identity 15.1s → 366.4 MB, deflate 152.0s → 170.5 MB**. So the codec
    costs ~136s of the ~152s import and buys 2.15×. Unzip is 1.7s and `JSON.parse` 1.5s — the file
    handling is free, and the SQL inserts are ~15s. Any future "the import is slow" work starts at
    the deflate level, not at the schema. — _recorded._

## Safari storage durability

38. **The dictionary lives in OPFS but is _owned_ by an IndexedDB snapshot.** — Safari regenerates
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

39. **The engine moves into the native app; the extension keeps display and UI.** — Chosen over
    working around the origin rotation in the browser. It makes the rotation, OPFS, the orphan leak,
    the per-launch copy, the wasm heap and the single-connection worker dance all moot at once
    instead of trading one for another, and it is the only direction that leads to a standalone
    macOS app. Made viable by measurement, not assumption: the `sendNativeMessage` bridge costs ~1 ms
    fixed and ~60 MB/s, so a hover-shaped call is 2 ms
    ([native-engine-probe.md](native-engine-probe.md)). Dictionaries are **compiled to SQLite at
    build time** by the existing node importer rather than imported in the browser, which deletes the
    import worker, the suspend/resume handoff, the trained-dictionary handshake and the legacy
    migration UX from the Safari target. Design in [native-rewrite.md](native-rewrite.md). —
    _**built** (stages N1–N2). The engine runs in the app over system libsqlite3, `npm run test:jsc`
    proves it answers identically to node on the same compiled database, and the app builds and
    signs. The extension-side backend is `DictionaryDatabaseNative`, behind `USE_NATIVE_BACKEND`._

40. **The JS core is re-hosted in JavaScriptCore, not ported to Swift.** — Yomitan's deinflection
    rules are live JS closures and regexes (`deinflect: (text) => …`), 1.1 MB across 23 languages in
    16 transform files, upstream-maintained and actively changing; German, English and Spanish alone
    hand-write 32 bespoke closures. Porting that to Swift would permanently fork the most actively
    developed part of upstream, in the area with the subtlest correctness properties in this project
    (inflection synthesis is verified at 0 lost / 0 invented over 41,921 forms), and would throw away
    the vitest coverage that proves it. `JavaScriptCore.framework` is a system framework on both
    macOS and iOS, so the core runs unmodified inside the app over a native SQLite binding — the
    logic lives in the app process as required, and upstream keeps merging. The project is therefore
    a rewrite of the engine's **host and storage binding**, not of the engine. A Swift port of
    individual hot pieces stays available afterwards, incrementally. — _**built, and the bet paid.**
    The shim surface is four host functions (`openDatabase`, `databasePath`, `log`, `now`) plus four
    things shimmed in JavaScript (`TextEncoder`, `TextDecoder`, `console`, `setTimeout`). Cold start
    — `JSContext` creation, parsing a 379 KiB bundle, and opening the database — measures **8–10 ms**
    on macOS, so the app extension does not need to be kept warm for a hover to feel instant._

## The native engine, as built

41. **Everything crosses the bridge as one JSON string, not a property list.** — The only transport
    measurement we have ([native-engine-probe.md](native-engine-probe.md)) timed a single flat ASCII
    string, and its first caveat was that a plist of many nested rows might serialize very
    differently. Sending one string keeps those numbers applicable instead of re-opening the
    question, moves the structural cost to `JSON.parse` (fast, and profileable in the browser), and
    sidesteps plist's lack of a byte-array type that survives `SFExtensionMessageKey` intact. Binary
    — dictionary media — is base64 inside that string, +33% on a path that is nowhere near the hover
    budget. — _built; `native-protocol.js` owns both directions._

42. **The Swift SQLite binding implements the interface the engine already spoke.** — The engine
    funnels every query through `openDictionaryDatabaseHandle`, which takes the `sqlite3` module as
    an argument rather than importing it — a seam that existed so node tests could use `:memory:`.
    The native binding substitutes at exactly that seam, so _no engine code changed at all_: the
    1,600-line backend, the codec and the inflection synthesis keep their vitest coverage because
    they are literally the same code. Two conversions carry real risk and are tested explicitly:
    BLOBs must arrive as `Uint8Array` (a BLOB read back as a string decompresses to garbage rather
    than failing), and whole numbers must bind as INTEGER, not REAL (a REAL `3.0` does not match an
    INTEGER `3` in an index seek). — _built; `SqliteBridge.swift`, gated by `npm run test:jsc`._

43. **`npm run test:jsc` is the gate that route C needs.** — vitest proves the engine is correct in
    node and cannot prove any of what only breaks once it is hosted: a bundle that will not evaluate
    in JavaScriptCore, a platform shim that was never installed, or a SQLite binding that quietly
    marshals a value differently. So the same requests are answered twice — once through
    `NativeCore` in node over SQLite-WASM, once through the real Swift host over system libsqlite3,
    both reading **the same compiled database file** — and the answers must be identical. Reading one
    file rather than importing twice is the point: importing separately would compare two imports
    instead of two hosts, and would hide exactly the bugs this exists to catch. — _built; 15/15
    identical._

44. **The in-browser SQLite backend was deleted, not kept as a fallback.** — With the engine native,
    the OPFS/SAH-Pool opener, the owner-worker proxy (`DatabaseOwnerClient` and both DB-worker
    files), the `suspendDatabase`/`resumeDatabase` API pair, the legacy-IndexedDB migration and its
    settings controller, the vendored `sqlite3.wasm`, `test/safari/` and the `USE_SQLITE_BACKEND`
    flag all became a second, half-working way to do the same thing. Two backends remain and each
    has one reason to exist: **native** for Safari, **IndexedDB** for every other browser. The
    engine itself was not deleted — it is what runs natively. — _built; the factory is now four
    lines._

45. **Dictionaries are installed as files, chunked and staged.** — `npm run compile:dictionary`
    produces the `.sqlite3`; `DictionaryDatabaseNative.installDatabase()` streams it into the app
    container in 3 MB chunks. Chunked because `sendNativeMessage` has no documented size limit and
    4 MB is the largest round trip ever measured — a 49 MB message is the kind of thing that works
    on a developer's machine and fails on a user's. Staged in a `.incoming` file and validated (magic
    header + `user_version`) before the swap, because an interrupted transfer writing in place would
    leave a truncated file where a working database was, and the user would simply find their
    dictionaries gone. — _built; the settings UI still points at the archive importer, so installs
    go through the client method for now._
