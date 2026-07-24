# plan/ — dictionary backend refactor

Replace the Safari fork's IndexedDB dictionary store with **SQLite**: a columnar schema, a per-row
deflate-compressed payload, and inflection rules induced from each dictionary so its form-of rows can
be dropped and synthesized on lookup. Branch: **`safari-refactor`**.

**Measured result: ~700 MB of IndexedDB → 49.4 MB** on the real `kty-de-en`, through the real
importer.

**The project has been redirected.** That backend was built inside the extension on OPFS, and it
works — but it cannot survive a Safari restart, because Safari rotates the extension origin on every
launch. So the **engine moves into the native app** and the extension becomes display and UI. The
schema, codec, inflection synthesis and query strategy all carry over unchanged; the core is
re-hosted, not rewritten.

## Read order

Three clusters. Start with the first.

**Where it is going (start here):**

| File                                             | What it holds                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [safari-opfs-blocker.md](safari-opfs-blocker.md) | **The blocker**: Safari rotates the extension origin every launch, so OPFS cannot persist |
| [native-rewrite.md](native-rewrite.md)           | **The plan**: the engine moves into the native app; the extension becomes display and UI  |
| [native-engine-probe.md](native-engine-probe.md) | The measurement that made it viable: the native bridge costs ~1 ms and ~60 MB/s           |

**What exists today (carries over):**

| File                           | What it holds                                                      |
| ------------------------------ | ------------------------------------------------------------------ |
| [design.md](design.md)         | The backend as built: schema, codec, inflection synthesis, queries |
| [pseudocode.md](pseudocode.md) | The inflection scheme end to end, as pseudocode                    |
| [progress.md](progress.md)     | What's built, what's deleted by the redirect, watch-outs, file map |

**Why it is that way (the record):**

| File                                                   | What it holds                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [decisions.md](decisions.md)                           | Decision log — every choice, with rationale and live/dead status         |
| [safari-idb-snapshot.md](safari-idb-snapshot.md)       | On hold — the smaller in-browser fix, kept as the fallback               |
| [history/backend-worker.md](history/backend-worker.md) | Retired: the owner-worker/proxy split, and the Safari traps it uncovered |
| [history/sizing.md](history/sizing.md)                 | Bottom-up byte budget: why the inflections, not the codec, are the DB    |
| [history/zstd.md](history/zstd.md)                     | Why zstd was built, measured, and rejected in favour of deflate          |
| [history/original-plan.md](history/original-plan.md)   | The first draft (superseded): feasibility spike, rejected architectures  |

## Status

**Built and working (in the extension, on OPFS):**

- The SQLite backend (`DictionaryDatabaseSqlite`) has full API parity with the IndexedDB backend,
  passes the real importer/translator fixtures end to end (identity + deflate), and passes the real
  Safari checks (23/23). `USE_SQLITE_BACKEND` is **on**.
- **The codec is decided: deflate** ([decisions.md](decisions.md) #26).
- **Inflection synthesis is implemented** (schema v4/v5): rules are induced at import, derivable
  form-of rows are dropped, and `findTermsBulk` synthesizes them on lookup — 947,070 → 293,262 rows,
  verified against the source ZIP (0 lost, 0 invented over 41,921 forms).
- Verified in the installed extension at `safari-web-extension://`: import, lookup, and a
  synthesized inflection (`geschützt` → `schützen`).

**The blocker that redirected it:**

- Safari regenerates the extension's origin UUID on **every launch**, and OPFS is partitioned by
  origin, so an imported dictionary is stranded on every restart — while IndexedDB and
  `localStorage` survive. Measured and settled in
  [safari-opfs-blocker.md](safari-opfs-blocker.md). The engine, schema, codec and importer are all
  fine; only _where the bytes live_ is wrong.

**Where it is going:**

- **The engine moves into the native app** ([native-rewrite.md](native-rewrite.md)). The extension
  keeps scanning, the popup and the settings UI; storage, queries, the codec, inflection synthesis
  and the translator move behind a `sendNativeMessage` protocol, with dictionaries **compiled to
  SQLite at build time** instead of imported in the browser. The origin rotation, OPFS, the orphan
  leak and the single-connection worker dance all become moot at once.
- **What made it viable:** the native bridge measures ~1 ms fixed and ~60 MB/s
  ([native-engine-probe.md](native-engine-probe.md)) — a hover-shaped call is 2 ms.
- **The core is re-hosted, not rewritten.** Yomitan's language logic is live JS closures across 23
  languages, so it runs unmodified in **JavaScriptCore** inside the app, over native SQLite. The
  vitest suites keep working because it is the same code.
- **What gates it:** the stage-N0 measurements (realistic-payload serialization, the message size
  cap, JSC cold start in the appex). Staging and risks in [native-rewrite.md](native-rewrite.md);
  the in-browser fallback is [safari-idb-snapshot.md](safari-idb-snapshot.md).

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
