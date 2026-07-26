# Decision log — live decisions

_Why_ the backend is the way it is. **Everything here describes the code as it stands.** Decisions
that were reversed, superseded or abandoned are not deleted — they moved to
[history/README.md](history/README.md) → Historical decisions, because the constraint behind a dead
decision is usually still worth not rediscovering.

For _what_ the system does today, read [design.md](design.md) and [pseudocode.md](pseudocode.md).

Format: **#N — Decision** — rationale — _status_.

**The number is a permanent ID**, cited from code comments and the other plan docs (`plan/decisions.md #34`).
It is written as literal text inside an unordered list rather than as a markdown ordered list, which
is what makes it safe: the pre-commit `prettier --write` renumbers ordered lists from each list's own
first item, and this document was previously bitten by exactly that — three appended decisions were
silently rewritten 21→16, 22→17, 23→18 and collided with an existing group. As literal text, nothing
can renumber them.

So, to add a decision: **put it in the section it belongs to**, with the next unused number. There is
no append-only rule any more — there is nothing left to disturb. Never reuse a number, and when a
decision dies, move it to [history/README.md](history/README.md) rather than deleting it.

## Architecture

- **#1.** **Replace IndexedDB with SQLite-WASM on OPFS**, behind the existing `DictionaryDatabase`
  facade. — IndexedDB forces indexed fields + their property names into every plain record and
  duplicates indexed values in its B-trees, so compression alone floors at ~290 MB; SQLite
  gives columnar rows (no per-row key names) + real indexes + a compressible BLOB column.
  Feasibility confirmed on macOS, iOS, and the extension worker. — _adopted._

- **#4.** **Columnar schema + integer `dictionary_id` FK.** — Kills the two biggest "repeating string"
  costs: per-row JSON property names (~34 MB) and the dictionary title repeated per row
  (~8 MB). SQLite indexes serve every lookup the IndexedDB indexes did. — _adopted (schema in
  `dictionary-sqlite-schema.js`)._

## Compression / codec

- **#6.** **`PayloadCodec` seam with `IdentityPayloadCodec` (JSON, no compression) first.** — Prove
  backend correctness before adding compression. — _adopted (`payload-codec.js`)._

- **#7.** **Rows are self-describing via the `codec` column + per-dictionary `codec_dict`.** — The
  backend stores which codec wrote a dictionary's rows (null = identity) and its trained preset
  dictionary, and decodes with the matching registered codec. A compressing codec is trained once
  per dictionary from the first term batch (`_ensureWriteCodec`, async, before the insert
  transaction) so training a preset dict fits the streaming importer. Default write codec is
  identity, so shipped behavior is byte-identical. This also means a later codec change does not
  invalidate existing imports. — _adopted._

- **#8.** **Interim codec: pako deflate + 32 KB preset dictionary** (~3.55×, pure JS). — Lets the
  backend be built/tested before the zstd build exists; the codec is swappable. — _implemented
  (`deflate-payload-codec.js`), and it stayed: #26 shipped it. pako is injected at every
  construction site and the codec throws without it; the browser vendoring it also had is gone with
  the in-browser backend (see #12). pako is a direct dependency at `^1.0.11` (the transitive
  version already installed, and the last of the 1.x line); `deflateRaw`/`inflateRaw` with a
  `dictionary` preset work there._

- **#22.** **`PayloadCodec.prepare?()`, awaited by `DictionaryDatabaseSqlite.prepare()`.** _(the hook is
  live; no shipped codec implements it any more.)_ — `encode`/`decode` are synchronous because they
  sit inside sqlite's synchronous query/transaction paths, but a WASM-backed codec must load its
  module first, and reading already-imported rows never calls `train()` — so there is no other
  async moment to initialize in. Optional, so identity and deflate ignore it. Deflate did implement
  it for a while, to self-load the vendored pako when none was injected; that fallback is gone
  (#26's codec is constructed with pako injected everywhere, and throws without it), so the hook is
  now unused but kept — it is the only async seam a future codec would have. — _adopted._

- **#24.** **Codec tuning is a constructor option, not a constant.** — `DictionaryDatabaseSqlite` takes
  `trainSampleSize` (and the removed `ZstdPayloadCodec` took `level`/`dictionaryCapacity`), because the
  real measurements show the tradeoff is a judgement call rather than a fact: dictionary size is
  the dominant lever on ratio (110 KB → 3.15×, ~2 MB → 4.63×), it costs nothing on decode, but a
  bigger dictionary is only trainable by buffering proportionally more of the import (ZDICT wants
  ~100× the dictionary size in samples). `npm run measure:storage` re-derives it against the
  real dictionary. — _adopted._

- **#25.** **`trainSampleSize` defaults to 1000, the importer's `maxTransactionLength`.** — Training runs on
  the first `bulkAdd` batch, so any larger value was silently unreachable (the old constant of 4000
  was dead). The default now states the real constraint rather than hiding it; raising it means
  also giving the trainer more than one batch. — _adopted._

- **#26.** **Ship `deflate`; zstd is measured, rejected, and removed.** — Measured on the real `kty-de-en`
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
  makes this reversible. — _adopted; the codec is constructed with pako injected at every site that
  builds the backend — `NativeCore` for the engine, `dev/bin/compile-dictionary.js` for the
  build-time pipeline, `measure-storage` and the tests. (It read "`createDictionaryDatabase()` now
  builds `new DeflatePayloadCodec()`" until that factory went with the flag, #46.)_

## Schema, queries and sizing

- **#27.** **Pin the term index with `INDEXED BY`; do not let the planner choose.** — Every row of a German
  dictionary has `reading = ''`, so ANALYZE records `ix_terms_reading` as completely unselective and
  the planner full-scans the table for a reading probe: **75 ms per lookup** on 947k rows, on the
  hover path, vs 0.02 ms with the index. The estimate is right on average and wrong for the probe,
  which is a shape SQLite's stat1 cannot express. IndexedDB had no such failure mode — an index
  probe always seeks — and these queries want exactly that. Suffix still scans, deliberately: no
  index can serve it. **The premise is refuted by #35** — no row ever has `reading = ''` — and the
  pin is kept anyway for the reason in #36. — _adopted, with a query-plan regression test
  (`dictionary-database-sqlite-query-plan.test.js`); found only by measuring the real dictionary._

- **#28.** _(PARTLY SUPERSEDED — the `ix_terms_dictionary` drop is LIVE; the `WHERE reading <> ''` predicate
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

- **#29.** **Do not make `ix_terms_sequence` partial, and do not adopt `WITHOUT ROWID` yet.** — Both look
  like free wins and neither is. `WHERE sequence > 0` would _change behaviour_: every `kty-de-en`
  row has `sequence = 0` while `index.json` claims `sequenced: true`, so this is a semantics
  question (what does `sequence = 0` mean?) wearing a storage costume — see [sizing.md](history/sizing.md)
  §6 for the latent all-rows-match bug it exposes, which is upstream's and not a regression.
  `PRIMARY KEY(expression, id) WITHOUT ROWID` measures well on German (−35.7 MB, seeks still
  0.045 ms) precisely because its reading index is empty — but secondary indexes on a `WITHOUT
ROWID` table reference rows by the full primary key, so a Japanese dictionary's reading index
  would carry `expression + id` per entry. It was measured on the one dictionary that cannot show
  the downside. — _deferred pending a measurement on a Japanese dictionary._

- **#31.** **Deriving stubs from induced rules beats storing them, and the rule model beats the rule
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
  generalisation**, and it cannot analyse a form the dictionary never listed. — _**implemented**
  (schema v4/v5, staged A1/A2/B in [history/README.md](history/README.md#the-progress-log)) at the shipped budget K = 1,000:
  947,070 → 293,262 rows, and the end-to-end result is in
  [README.md](README.md#the-numbers-once). #34 is where the design landed and why the blocker
  recorded here was wrong; the lookup-cost risk flagged in [sizing.md](history/sizing.md) §5.3 was
  answered by #32._

- **#32.** **Cache the term-query prepared statements; `findTermsBulk` re-prepares one per candidate.** —
  It loops per term calling `selectObjects`, which runs `sqlite3_prepare` + finalise on every call,
  so a lookup with 434 candidates pays 868 of them. Measured: **~85% of query time is statement
  preparation, not index seeks** (434 candidates: 9.44 ms → 1.52 ms with two cached statements).
  Batching into `WHERE expression IN (?,?,…)` on top of that adds only ~12% more (1.34 ms), so
  caching is the win and batching is a bonus. **This affects the backend as shipped today**, not
  just the inflection work: it makes every hover ~5–10× cheaper on the SQL. It is also what decides
  whether the §5.3 rule expansion is affordable — with it, the full 70,247-rule set costs ~3.4 ms
  per hover instead of ~12. — _**implemented**; the backend caches its term-query statements
  ([history/README.md](history/README.md#the-progress-log) → Sizing work queue, item 1). Measurements in
  [sizing.md](history/sizing.md) §5.4._

- **#33.** **`searchResolution` drives lookup cost more than anything else, and German recommends `word`.** —
  `translator._getAlgorithmDeinflections` runs the transforms over **every substring** of the scan
  window (`scanning.length`, default 16), stepping by letter or by word per
  `translation.searchResolution` (schema default `letter`; `recommended-settings.json` sets `word`
  for German). Word stepping turns a 16-character window into ~3 substrings instead of 16, a ~5×
  difference in candidates and therefore in lookup cost. Any latency claim about the deinflection
  path is meaningless without stating which mode it assumes. — _recorded; both modes are measured in
  [sizing.md](history/sizing.md) §5.4._

- **#34.** **The induced rules belong in the database backend, not in the translator — and #31's recorded
  blocker was wrong.** — [history/README.md](history/README.md#the-progress-log) recorded Stage B as blocked on an
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

- **#35.** **#27 and #28 were measured on data the importer never produces, and #28's saving does not
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

- **#36.** **The right partial predicate is `reading <> expression`, and it delivers what #28 promised.** —
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

- **#37.** **Import is ~90% pako deflate, and that is a knob nobody had priced.** — Through the real
  importer on `kty-de-en`: **identity 15.1s → 366.4 MB, deflate 152.0s → 170.5 MB**. So the codec
  costs ~136s of the ~152s import and buys 2.15×. Unzip is 1.7s and `JSON.parse` 1.5s — the file
  handling is free, and the SQL inserts are ~15s. Any future "the import is slow" work starts at
  the deflate level, not at the schema. — _recorded._

## Implementation patterns

- **#10.** **Inject the initialized `sqlite3` module into the backend; never import it inside backend
  code.** — The browser build (`ext/lib/sqlite3.js`, used by the worker) and the node build
  (`@sqlite.org/sqlite-wasm`, used by vitest) resolve differently. The opener takes `sqlite3`
  as a parameter (`vfs: 'opfs' | 'memory'`), so the same logic serves both. `prepare()` with no
  arguments self-loads the vendored build for the extension path. — _adopted (`open-sqlite.js`),
  and it is the decision the whole native move turned on: the Swift binding substituted at exactly
  this seam, so no engine code changed (#42). The vendored browser build and the `'opfs'` VFS are
  gone; the injection point is not._

- **#12.** **Vendor libraries the resvg way**: `dev/build-libs.js` bundles `dev/lib/*.js` via esbuild into
  `ext/lib/` (pako), and copies sqlite's `dist/index.mjs` → `ext/lib/sqlite3.js` +
  `dist/sqlite3.wasm`. `ext/lib/*` is gitignored (generated at build), so no binaries in git.
  Verbatim copies need a `// @ts-nocheck` banner prepended (esbuild adds one to what it bundles),
  since the backend's dynamic import pulls them into the tsc graph. — _adopted, then unwound for
  everything this refactor added: the sqlite half (`copySqlite()`) went with the in-browser backend
  (#44), so `@sqlite.org/sqlite-wasm` is a devDependency used by node only, and the pako half went
  when the engine moved native — pako is bundled into `yomitan-core.js` from `node_modules`, and
  the codec's fallback to the vendored copy was silently bundling it a second time. `dev/lib/*.js`
  and this mechanism remain in use by the rest of the extension (resvg, zip, handlebars, …)._

- **#13.** **Narrow hand-written types** (`types/ext/sqlite-wasm.d.ts`, `types/ext/pako.d.ts`) instead of
  the packages' full/absent types; cast at the injection boundary via `unknown`. — Keeps the
  injected-module boundary simple. — _adopted._

- **#14.** **Node/vitest is the test environment for the SQLite backend** (`:memory:` DB), in the **plain
  node env** (not jsdom — its setup swaps the global typed-array constructors and breaks
  sqlite-wasm's heap views). — _adopted._

- **#15.** **Real Safari is driven via `open -g`, not safaridriver or Playwright WebKit.** — `safaridriver`
  has no headless mode and always steals focus; Playwright's `webkit` is headless but is a WebKit
  build rather than the Safari users run. `open -g -a Safari` uses the real browser and never
  takes focus; a loopback server (a secure context, so OPFS works) collects results from an
  in-page worker. — _historical as a test runner: `test/safari/` and `npm run test:safari` went
  with the OPFS backend (#44). The `open -g` channel itself is live and is how the installed
  extension is still driven by hand ([DEV.md](../DEV.md))._

- **#17.** **All backend changes stay behind `DictionaryDatabase` + the importer.** Callers
  (translator, backend, display) do not change. This is a fork; upstream DB compatibility is a
  non-goal. — _adopted._

- **#18.** **Safari CSP uses `'wasm-unsafe-eval'`** (was `'unsafe-eval'`, which Safari rejects/ignores;
  WASM only worked via the ArrayBuffer fallback). — _adopted (`manifest-variants.json`)._

- **#20.** **Layer 1 — positional term payload** (`m: [definitionTags, rules, score, glossary,
termTags]`) in the IndexedDB rows. — Deterministic ~10% shrink and a stepping stone; the
  payload array shape carries directly onto the SQLite `payload` BLOB. — _shipped (commit
  `7edfb9b2`)._

## The native engine, as built

- **#39.** **The engine moves into the native app; the extension keeps display and UI.** — Chosen over
  working around the origin rotation in the browser. It makes the rotation, OPFS, the orphan leak,
  the per-launch copy, the wasm heap and the single-connection worker dance all moot at once
  instead of trading one for another, and it is the only direction that leads to a standalone
  macOS app. Made viable by measurement, not assumption: the `sendNativeMessage` bridge costs ~1 ms
  fixed and ~60 MB/s, so a hover-shaped call is 2 ms
  ([native-engine-probe.md](native-engine-probe.md)). Dictionaries are **compiled to SQLite at
  build time** by the existing node importer rather than imported in the browser, which deletes the
  import worker, the suspend/resume handoff, the trained-dictionary handshake and the legacy
  migration UX from the Safari target. Design in [native-rewrite.md](native-rewrite.md). —
  _**built** (stages N1–N3 and N5). The engine runs in the app over system libsqlite3,
  `npm run test:jsc` proves it answers identically to node on the same compiled database, and the
  app builds and signs. The extension-side backend is `DictionaryDatabaseNative` — with **no
  flag**: `USE_NATIVE_BACKEND` selected between this and the IndexedDB backend while both existed,
  and went when #46 deleted the alternative._

- **#40.** **The JS core is re-hosted in JavaScriptCore, not ported to Swift.** — Yomitan's deinflection
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
  — `JSContext` creation, parsing the bundle, and opening the database — stays inside a hover
  budget on macOS, so the app extension does not need to be kept warm for a hover to feel instant.
  The sizes and timings are in [README.md](README.md#the-numbers-once) and only there; they have
  already moved once, when the translator brought the language modules with it (#48, #49)._

- **#41.** **Everything crosses the bridge as one JSON string, not a property list.** — The only transport
  measurement we have ([native-engine-probe.md](native-engine-probe.md)) timed a single flat ASCII
  string, and its first caveat was that a plist of many nested rows might serialize very
  differently. Sending one string keeps those numbers applicable instead of re-opening the
  question, moves the structural cost to `JSON.parse` (fast, and profileable in the browser), and
  sidesteps plist's lack of a byte-array type that survives `SFExtensionMessageKey` intact. Binary
  — dictionary media — is base64 inside that string, +33% on a path that is nowhere near the hover
  budget. — _built; `native-protocol.js` owns both directions._

- **#42.** **The Swift SQLite binding implements the interface the engine already spoke.** — The engine
  funnels every query through `openDictionaryDatabaseHandle`, which takes the `sqlite3` module as
  an argument rather than importing it — a seam that existed so node tests could use `:memory:`.
  The native binding substitutes at exactly that seam, so _no engine code changed at all_: the
  1,600-line backend, the codec and the inflection synthesis keep their vitest coverage because
  they are literally the same code. Two conversions carry real risk and are tested explicitly:
  BLOBs must arrive as `Uint8Array` (a BLOB read back as a string decompresses to garbage rather
  than failing), and whole numbers must bind as INTEGER, not REAL (a REAL `3.0` does not match an
  INTEGER `3` in an index seek). — _built; `SqliteBridge.swift`, gated by `npm run test:jsc`._

- **#43.** **`npm run test:jsc` is the gate that route C needs.** — vitest proves the engine is correct in
  node and cannot prove any of what only breaks once it is hosted: a bundle that will not evaluate
  in JavaScriptCore, a platform shim that was never installed, or a SQLite binding that quietly
  marshals a value differently. So the same requests are answered twice — once through
  `NativeCore` in node over SQLite-WASM, once through the real Swift host over system libsqlite3,
  both reading **the same compiled database file** — and the answers must be identical. Reading one
  file rather than importing twice is the point: importing separately would compare two imports
  instead of two hosts, and would hide exactly the bugs this exists to catch. — _built; 21/21
  identical (15/15 when this was written, before the translator actions of #48)._

- **#45.** **Dictionaries are installed as files, chunked and staged.** — `npm run compile:dictionary`
  produces the `.sqlite3`; `DictionaryDatabaseNative.installDatabase()` streams it into the app
  container in 3 MB chunks. Chunked because `sendNativeMessage` has no documented size limit and
  4 MB is the largest round trip ever measured — a 49 MB message is the kind of thing that works
  on a developer's machine and fails on a user's. Staged in a `.incoming` file and validated (magic
  header + `user_version`) before the swap, because an interrupted transfer writing in place would
  leave a truncated file where a working database was, and the user would simply find their
  dictionaries gone. — _built; the settings UI installs through it
  (`dictionary-import-controller.js` → `_installDictionaryDatabase`), and the archive path it
  replaced is gone._

- **#46.** **One backend, and the interface is a type rather than a class.** — With the engine in the app,
  the IndexedDB `DictionaryDatabase` and the Chrome offscreen document that proxied to it became a
  second, non-functional way to do the same thing on a Safari-only fork, so both were deleted along
  with the factory and the selection flag. `DictionaryDatabase` had been a _concrete class_ that
  every other backend was cast to; there is no type of that name any more, only
  **`DictionaryDatabaseRead`** (translator, backend) and **`DictionaryDatabaseWrite`** (the
  importer, which now exists only in the build-time compiler), with `DictionaryDatabaseApi` for the
  two together — all in `types/ext/dictionary-database.d.ts`. `prepare` and `close` are
  deliberately outside them — opening is the one thing the implementations genuinely disagree
  about, and only whoever constructed the object calls them. — _built._

- **#47.** **The media path got simpler, not merely ported.** — The media-drawing worker used to hold a
  `MessagePort` to the dictionary worker, which owned the bytes, decoded each image and posted
  pixel buffers back. That round trip existed only because the data lived in another thread. It now
  fetches media over the extension API and decodes in place — which also deletes the
  `ImageDecoder`-vs-`createImageBitmap` split and the draw-to-a-temporary-canvas hack, both of
  which were working around what Firefox could transfer between processes. This was the corner
  [native-rewrite.md](native-rewrite.md) called "the least-designed"; it turned out to be the one
  the move improved most. — _built._

- **#48.** **The translator moved too, and the options object is what made it non-trivial.** — Deinflection
  and result assembly now run in the engine, so a lookup is one round trip carrying only surviving
  entries rather than half a dozen carrying every candidate. The obstacle was not the translator —
  it is the same code — but `FindTermsOptions`: it holds a `Map`, a `Set|null` and live `RegExp`
  objects, and `JSON.stringify` turns all three into `{}` **without complaining**, so a lookup
  would return nothing rather than fail. `encodeFindTermsOptions` handles them and the equivalence
  gate passes a real `textReplacements` pattern so the rebuild path is covered. — _built; 21/21
  identical between node and JavaScriptCore._

- **#49.** **The engine bundle is minified, and the gate tests the minified artifact.** — Adding the
  translator brought the language modules with it, roughly tripling the bundle and taking cold
  start from single digits to tens of milliseconds; minifying gives back a few of those and more
  than halves the file, which matters because cold start is paid on every app-extension reclaim.
  (Sizes and timings live in [README.md](README.md#the-numbers-once), not here.) Minifying only for
  release would mean the equivalence gate tested something other than what ships — precisely the
  class of bug that gate exists for — so `build-native-core.js` minifies by default and
  `--no-minify` is the debugging escape hatch. — _built._

## Keeping a second host possible

- **#50.** **Archives are consumed on the build side; the bridge never carries one.** — `.zip` →
  `.sqlite3` happens in `npm run compile:dictionary`, and a host installs a finished file. This is
  now a standing rule rather than an artefact of the Safari work: no protocol action takes an
  archive, and the in-browser importer is not coming back. It is what keeps the importer, the
  trained-codec handshake and the ~152 s of deflate off every user's machine, and it keeps a
  second host small — a Linux host needs SQLite and a file writer, not a zip reader, a schema
  validator and a compressor. The cost is that a dictionary cannot be installed from a URL that
  serves an archive, which is why "Check for Updates" and the recommended-dictionaries list
  currently fail: the fix is to publish compiled databases, not to teach the bridge about zips. —
  _decided; the compiler is built, publishing is not._

- **#51.** **The protocol is written down, and host addressing is no longer Safari-shaped.** — With Linux
  and Firefox plausible, the contract was implicit in the Swift host plus a type file, which is a
  poor thing to ask a second implementer to reverse-engineer:
  [native-protocol.md](native-protocol.md) states it, with `npm run test:jsc` as the executable
  version. Addressing moved to `native-host-ids.js` because it is the one genuinely
  browser-specific thing left — Safari names the host by **bundle identifier** (no registry; the
  id comes from `chrome.runtime.id` with the signing team appended), while Firefox and Chrome name
  it by a **registered manifest name** that has nothing to do with `chrome.runtime.id`. Candidates
  are tried in order and the winner remembered, so a wrong guess costs one call per session; the
  bundle-id derivation is skipped entirely when the runtime id does not look like one, which is
  how a Firefox extension id avoids spending a round trip on a candidate that cannot exist. —
  _built._

- **#52.** **Options are a host action over a plain JSON file, not an engine action, and the store is
  the app container.** — Stage N4 moves the options/profile store native. Options never lived in
  OPFS and so were never part of the origin-rotation blocker — `chrome.storage.local` is exempt and
  persisted them fine — so the move is for the _other_ reason the engine went native: a standalone
  macOS app needs the settings its logic reads to live in the app process, not the browser. Three
  choices fell out of that:

  - **Host action, not engine action.** The protocol prefers engine actions because a host implements
    none of them ([native-protocol.md](native-protocol.md) → Changing the protocol), but options are
    not dictionary data and the dictionary database is _replaced wholesale_ on every install, which
    options must outlive — so they cannot share its file, and the engine has no other business
    holding them. `optionsLoad`/`optionsSave` read and write one `options.json` beside the database
    (`OptionsStore.swift`), on the same serialized queue as everything else. A second host implements
    two trivial file operations.
  - **The extension keeps the migration.** `options-util.js` is 1,800 lines of upstream, actively
    maintained, versioned migration; none of it moves. Only the storage seam in `load`/`save` changed
    — `chrome.storage.local` → the injected `OptionsStorage`, defaulting to `NativeOptionsStore`,
    constructed lazily so the settings and backup controllers (which only call `update`/`getDefault`)
    never stand up a native client. The settings UI was untouched: it already read and wrote options
    through the backend API, and the backend is the only caller that hits storage.
  - **One-time migration, not a reset.** On the first launch against an empty container, `load` reads
    the copy the extension used to keep in `chrome.storage.local` and the following `save` writes it
    into the container, so an upgrade does not silently wipe a user's settings. The legacy key is
    left in place as a harmless rollback fallback. — _built; audio and Anki (the rest of N4) are
    deferred until the core lookup/display path is confirmed in the installed app._

- **#53.** **The installed-extension end-to-end test has the extension reach _out_ to a local server,
  not the harness reach _in_.** — The one seam vitest and `test:jsc` cannot cover is the installed
  extension talking to its app extension over `sendNativeMessage`; both of those run the engine
  outside Safari. Driving it from outside is what Safari makes hard: the `safari-web-extension://`
  origin rotates every launch and has no scriptable cold entry — a synthesized scan needs the content
  script already granted on some page and only reveals the origin, not a driveable page; the scheme
  is refused for direct navigation; extension hotkeys are unreliable. So `npm run test:safari:e2e`
  inverts it. A **build-gated** content-script bridge (`YOMITAN_TEST_BRIDGE=1`, injected only on
  `127.0.0.1`/`localhost`) runs in the extension's isolated world, long-polls a local node runner,
  and relays `{action, params}` to the background service worker — the same message surface the real
  UI uses; the service worker does the native round trip. Three choices fell out:
  - **Reach out, over a bridge baked into a test build.** The bridge must run in the extension
    context (only there is `chrome.runtime` + native messaging), so it is extension code and needs a
    rebuild. Gating it on an env var in `build-safari.sh` means a normal build never references it and
    it cannot ship; a plain `./rebuild-safari.sh` removes it. This is why the old OPFS-era
    `test/safari` runner did _not_ cover this seam — it ran backend code as plain `127.0.0.1` page
    scripts, which have no `chrome` and no appex.
  - **Long-poll HTTP, not WebSocket.** Keeps the runner a dependency-free node `http` server; the
    content script's same-origin `fetch` needs nothing added.
  - **Assert the three seams that only exist in Safari**, and restore what it touched: the appex
    reads the database, a settings write reaches `options.json` (#52), and `geschützt` → `schützen`
    deinflects natively. The runner backs up and restores the options and database it finds. — _built,
    4/4; recipe in [DEV.md](../DEV.md), summary in [native-rewrite.md](native-rewrite.md) → Testing._
