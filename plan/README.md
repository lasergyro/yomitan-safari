# plan/ — dictionary storage backend refactor

Replace the Safari fork's IndexedDB dictionary store with **SQLite-WASM on OPFS**: a columnar schema,
a per-row deflate-compressed payload, and inflection rules induced from each dictionary so its
form-of rows can be dropped and synthesized on lookup. Branch: **`safari-refactor`**.

**Measured result: ~700 MB of IndexedDB → 49.4 MB** on the real `kty-de-en`, through the real
importer. The flag is still off, so the extension still runs the IndexedDB backend — see Stage 5.

## Read order

Two clusters. Read across them, not down the old timeline.

**What it is (the plan):**

| File                                             | What it holds                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [design.md](design.md)                           | Current architecture: schema, codec, inflection synthesis, queries                            |
| [pseudocode.md](pseudocode.md)                   | The whole scheme end to end, as pseudocode                                                    |
| [backend-worker.md](backend-worker.md)           | **Stage 5 blocker + fix**: the backend must run in a worker, not the Safari background page   |
| [safari-opfs-blocker.md](safari-opfs-blocker.md) | **Current blocker**: Safari rotates the extension origin every launch, so OPFS cannot persist |
| [safari-idb-snapshot.md](safari-idb-snapshot.md) | The fix for it, designed but not built: an IndexedDB snapshot owns the database file          |
| [progress.md](progress.md)                       | What's built, what's left (the Stage 5 gate), watch-outs, file map                            |

**Why it is that way (the record):**

| File                                                 | What it holds                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| [decisions.md](decisions.md)                         | Decision log — every choice, with rationale and live/dead status        |
| [history/sizing.md](history/sizing.md)               | Bottom-up byte budget: why the inflections, not the codec, are the DB   |
| [history/zstd.md](history/zstd.md)                   | Why zstd was built, measured, and rejected in favour of deflate         |
| [history/original-plan.md](history/original-plan.md) | The first draft (superseded): feasibility spike, rejected architectures |

## Status

- **Stages 0–4 are implemented and green.** The SQLite backend (`DictionaryDatabaseSqlite`) has full
  API parity with the IndexedDB backend, passes the real importer/translator fixtures end-to-end
  (identity + deflate), and passes the **real Safari** checks.
- **The codec is decided: deflate** ([decisions.md](decisions.md) #26).
- **Inflection synthesis is implemented** (schema v4/v5): rules are induced at import, derivable
  form-of rows are dropped, and `findTermsBulk` synthesizes them on lookup — 947,070 → 293,262 rows,
  verified against the source ZIP (0 lost, 0 invented over 41,921 forms).
- **The flag `USE_SQLITE_BACKEND` is `true`** (`ext/js/dictionary/dictionary-backend-config.js`), and
  the whole path is verified in the installed extension: import, lookup, and inflection synthesis at
  `safari-web-extension://`.
- **The backend-in-a-worker blocker is fixed** — a dedicated worker owns the one OPFS connection and
  the background page proxies to it; imports suspend it ([backend-worker.md](backend-worker.md)).
- **Stage 5 is BLOCKED on storage durability.** Safari regenerates the extension's origin UUID on
  **every launch**, and OPFS is partitioned by origin, so an imported dictionary is stranded on every
  restart — while IndexedDB and `localStorage` survive. Measured and settled in
  [safari-opfs-blocker.md](safari-opfs-blocker.md). The engine, schema, codec and importer are all
  fine; only _where the bytes live_ is wrong.
- **The fix is designed, not built:** an IndexedDB snapshot owns the database file and is restored
  into a cold OPFS pool at open — [safari-idb-snapshot.md](safari-idb-snapshot.md). Two measurements
  gate it (whether WebKit reclaims the per-launch orphaned OPFS copies, and the real restore cost).
- **What still gates the refactor:** that fix, then a restart-survival check at the extension origin,
  then removing the IndexedDB path and the flag. Full checklist in [progress.md](progress.md) →
  Stage 5.

## The numbers, once

Measured on `kty-de-en` (947,070 term rows) through the real `DictionaryImporter`, deflate:

| Stage                             | Whole DB    |
| --------------------------------- | ----------- |
| IndexedDB baseline (app-reported) | ~700 MB     |
| SQLite, identity codec            | 366.4 MB    |
| SQLite, deflate                   | 170.5 MB    |
| + inflection synthesis (v4)       | 56.8 MB     |
| + empty reading index (v5)        | **49.4 MB** |

Two conclusions the measurements forced, kept here so they are not relitigated elsewhere:

- **The ~100 MB target was unreachable by compression, and irrelevant once the schema changed.** Of
  the 170.5 MB deflate database, ~78 MB was index + row overhead no codec touches. The lever was
  never the codec — it was that **90% of the rows are inflections**. See
  [history/sizing.md](history/sizing.md).
- **zstd's best case saved ~13 MB on ~150 MB for a custom toolchain and ~24 MB of RAM.** Rejected.
  See [history/zstd.md](history/zstd.md).

## Commands

```sh
npm run build -- --target safari      # build only the safari variant
./rebuild-safari.sh                   # rebuild + reinstall into Safari (quits/relaunches it)
npm test                              # full vitest suite (includes the SQLite backend tests)
npm run test:safari                   # run the backend in REAL Safari, backgrounded (no focus steal)
npm run measure:storage               # measure codecs + real DB size against the real kty-de-en
npx tsc --noEmit -p jsconfig.json     # main type-check
npm run test:ts:test                  # type-check the test/ project
npx eslint . --ignore-pattern '**/*.json'
```
