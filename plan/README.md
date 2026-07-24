# plan/ — dictionary backend refactor

Replace the Safari fork's IndexedDB dictionary store with **SQLite**: a columnar schema, a per-row
deflate-compressed payload, and inflection rules induced from each dictionary so its form-of rows can
be dropped and synthesized on lookup. Branch: **`safari-refactor`**.

**Measured result: ~700 MB of IndexedDB → 49.4 MB** on the real `kty-de-en`, through the real
importer.

**The engine now lives in the native app.** It was first built inside the extension on OPFS and it
worked — but it could not survive a Safari restart, because Safari rotates the extension origin on
every launch. So it moved: the same engine runs in the Safari **app extension**, in JavaScriptCore,
over the system `libsqlite3`, reading a database in the app container, and the browser extension
keeps display and UI. The schema, codec, inflection synthesis and query strategy carried over
**unchanged** — no engine code was modified at all; only the `sqlite3` module injected into it.

## Read order

Three clusters. Start with the first.

**Where it is going (start here):**

| File                                             | What it holds                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [safari-opfs-blocker.md](safari-opfs-blocker.md) | **The blocker**: Safari rotates the extension origin every launch, so OPFS cannot persist |
| [native-rewrite.md](native-rewrite.md)           | **The plan and its status**: the engine in the native app, staged N0-N6                   |
| [../native/README.md](../native/README.md)       | **What was built**: layout, the build, the test gate, installing a dictionary             |
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
| [safari-idb-snapshot.md](safari-idb-snapshot.md)       | Abandoned — the smaller in-browser fix, never built                      |
| [history/backend-worker.md](history/backend-worker.md) | Retired: the owner-worker/proxy split, and the Safari traps it uncovered |
| [history/sizing.md](history/sizing.md)                 | Bottom-up byte budget: why the inflections, not the codec, are the DB    |
| [history/zstd.md](history/zstd.md)                     | Why zstd was built, measured, and rejected in favour of deflate          |
| [history/original-plan.md](history/original-plan.md)   | The first draft (superseded): feasibility spike, rejected architectures  |

## Status

**Built:**

- **The engine, in the app.** `DictionaryDatabaseSqlite` runs in JavaScriptCore inside the Safari app
  extension, over a Swift binding to system `libsqlite3`, reading `dictionaries.sqlite3` in the app
  container. The app builds and signs. Cold start — context creation, parsing the 379 KiB bundle,
  opening the database — is **8–10 ms**.
- **The bridge.** `{action, params}` → `{result} | {error}`, one JSON string in each direction over
  `sendNativeMessage`, measured at ~1 ms fixed and ~60 MB/s
  ([native-engine-probe.md](native-engine-probe.md)).
- **The extension-side backend.** `DictionaryDatabaseNative` implements the same
  `DictionaryDatabase` API, so the translator, the backend and the settings UI are untouched by the
  move. Behind `USE_NATIVE_BACKEND`, which is **off** until dictionaries can be installed from the
  settings UI.
- **The dictionary pipeline.** `npm run compile:dictionary` turns a `.zip` into a finished
  `.sqlite3` using the real importer, so installation is a chunked, staged, validated file copy
  rather than a 152-second in-browser import.
- **The gate.** `npm run test:jsc` answers the same requests through node (SQLite-WASM) and through
  the real Swift host (libsqlite3) against **the same compiled database**, and requires identical
  answers. 15/15.
- **The codec is decided: deflate** ([decisions.md](decisions.md) #26), and **inflection synthesis is
  implemented** (schema v4/v5): 947,070 → 293,262 rows, verified against the source ZIP (0 lost, 0
  invented over 41,921 forms).

**Deleted, because the native engine made them a second way to do the same thing:** the OPFS/SAH-Pool
opener, the owner-worker proxy and `suspendDatabase`/`resumeDatabase`, the legacy-IndexedDB migration
and its settings controller, the vendored `sqlite3.wasm`, `test/safari/`, and the
`USE_SQLITE_BACKEND` flag. Two backends remain, each with one reason to exist: **native** for Safari,
**IndexedDB** for every other browser.

**Remaining** ([native-rewrite.md](native-rewrite.md) → Staging): the translator moving into the JSC
host (N3); options, Anki, audio, media, and pointing the settings UI at `installDatabase()` (N4);
iOS (N6).

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
./rebuild-safari.sh                   # build the extension + the app, sign, reinstall into Safari
npm run build -- --target safari      # build only the safari web-extension bundle
npm run build:native-core             # bundle the engine for JavaScriptCore
npm run compile:dictionary -- a.zip --out dictionaries.sqlite3
npm test                              # full vitest suite (includes the SQLite backend tests)
npm run test:jsc                      # the native gate: node vs. JavaScriptCore, same database
npm run measure:storage               # measure codecs + real DB size against the real kty-de-en
npx tsc --noEmit -p jsconfig.json     # main type-check
npm run test:ts:test                  # type-check the test/ project
npx eslint . --ignore-pattern '**/*.json'
```
