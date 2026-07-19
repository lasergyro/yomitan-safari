# plan/ — dictionary storage backend refactor

Replace the Safari fork's IndexedDB dictionary store with **SQLite-WASM on OPFS**: a columnar schema,
a per-row deflate-compressed payload, and inflection rules induced from each dictionary so its
form-of rows can be dropped and synthesized on lookup. Branch: **`safari-refactor`**.

**Measured result: ~700 MB of IndexedDB → 49.4 MB** on the real `kty-de-en`, through the real
importer. The flag is still off, so the extension still runs the IndexedDB backend — see Stage 5.

## Read order

Two clusters. Read across them, not down the old timeline.

**What it is (the plan):**

| File                                   | What it holds                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| [design.md](design.md)                 | Current architecture: schema, codec, inflection synthesis, queries                          |
| [pseudocode.md](pseudocode.md)         | The whole scheme end to end, as pseudocode                                                  |
| [backend-worker.md](backend-worker.md) | **Stage 5 blocker + fix**: the backend must run in a worker, not the Safari background page |
| [progress.md](progress.md)             | What's built, what's left (the Stage 5 gate), watch-outs, file map                          |

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
- **The flag `USE_SQLITE_BACKEND` is `false`** (`ext/js/dictionary/dictionary-backend-config.js`), so
  the IndexedDB path is still the only live one and nothing user-visible has changed.
- **Stage 5 is in progress, and is now BLOCKED on a newly found bug.** Done: the importer calls
  `finalizeImport()` (item 3), the SAH-Pool grows for large DBs (item 6), and the settings-page
  migration UX is built and proven against WebKit's IndexedDB (item 2). But **extension-origin
  verification (item 1) ran against the real installed extension and found that the SQLite backend
  cannot open OPFS in the Safari background page** (sync access handles are Worker-only): the import
  succeeds but no lookup can read it back. The fix — run the backend in one dedicated DB worker with
  the background page proxying to it — is designed in [backend-worker.md](backend-worker.md) and
  **must land before the flag can flip**.
- **What still gates flipping it:** the backend-in-a-worker fix, then re-running item 1, then the flag
  flip and removing the IndexedDB path. Full checklist in [progress.md](progress.md) → Stage 5.

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
