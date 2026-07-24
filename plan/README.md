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

| File                                             | What it holds                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [native-rewrite.md](native-rewrite.md)           | **The plan and its status**: the engine in the native app, staged N0-N6         |
| [../native/README.md](../native/README.md)       | **What was built**: layout, the build, the test gate, installing a dictionary   |
| [native-protocol.md](native-protocol.md)         | **The wire contract**: what a second host (Linux, Firefox) implements           |
| [native-engine-probe.md](native-engine-probe.md) | The measurement that made it viable: the native bridge costs ~1 ms and ~60 MB/s |

**What exists today (carries over):**

| File                           | What it holds                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------ |
| [design.md](design.md)         | The backend as built: schema, codec, inflection synthesis, queries, watch-outs |
| [pseudocode.md](pseudocode.md) | The inflection scheme end to end, as pseudocode                                |
| [decisions.md](decisions.md)   | Decision log — every **live** choice, with its rationale                       |

**Why it is that way (the record):**

| File                                   | What it holds                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [history/README.md](history/README.md) | **Start here for anything historical**: the decisions that died, the progress log, what was deleted |
| [history/](history/)                   | and, beside it, the six documents it indexes — the OPFS blocker, the byte budget, the zstd verdict  |

**Everything directly under `plan/` describes the current system; everything under `plan/history/`
describes something that is not in the tree.** That split is the whole filing rule. A decision that
stops being true moves from [decisions.md](decisions.md) to
[history/README.md](history/README.md#historical-decisions) rather than being edited in place or
deleted — its number goes with it and is never reused, so a `#21` cited from code still means one
thing.

## Status

**Built:**

- **The engine, in the app.** `DictionaryDatabaseSqlite` **and the translator** run in JavaScriptCore
  inside the Safari app extension, over a Swift binding to system `libsqlite3`, reading
  `dictionaries.sqlite3` in the app container. The app builds and signs. Cold start is paid once per
  app-extension process; the figure is in [The numbers, once](#the-numbers-once).
- **The bridge.** `{action, params}` → `{result} | {error}`, one JSON string in each direction over
  `sendNativeMessage`. The contract is [native-protocol.md](native-protocol.md); what it costs is in
  [The numbers, once](#the-numbers-once).
- **The extension-side clients.** `DictionaryDatabaseNative` and `TranslatorNative` keep the method
  names their callers already used, so `Backend`, the display layer and the settings UI were
  untouched by the move. There is no flag: it is the only backend.
- **Installing.** The settings UI streams a compiled `.sqlite3` into the app container, staged and
  validated before the live database is replaced.
- **The dictionary pipeline.** `npm run compile:dictionary` turns a `.zip` into a finished
  `.sqlite3` using the real importer, so installation is a chunked, staged, validated file copy
  rather than a 152-second in-browser import.
- **The gate.** `npm run test:jsc` answers the same requests through node (SQLite-WASM) and through
  the real Swift host (libsqlite3) against **the same compiled database**, and requires identical
  answers — including full deinflected lookups. 21/21.
- **The codec is decided: deflate** ([decisions.md](decisions.md) #26), and **inflection synthesis is
  implemented** (schema v4/v5): 947,070 → 293,262 rows, verified against the source ZIP (0 lost, 0
  invented over 41,921 forms).

**Deleted, because the native engine made them a second way to do the same thing:** the OPFS/SAH-Pool
opener, the owner-worker proxy and `suspendDatabase`/`resumeDatabase`, the legacy-IndexedDB migration
and its settings controller, the vendored `sqlite3.wasm`, `test/safari/` and its `npm run test:safari`
script, the `USE_SQLITE_BACKEND` flag, **the IndexedDB backend**, the Chrome offscreen document, and
the in-browser import path — the import worker and every caller of it. One backend remains.
`dictionary-importer.js` itself survives under `ext/` and still ships in the bundle, but nothing in
the extension imports it: it is now build-time-only, driven by `npm run compile:dictionary` and the
tests.

**Remaining** ([native-rewrite.md](native-rewrite.md) → Staging): options, Anki and audio moving
native (N4); iOS (N6). Two settings affordances — "Check for Updates" and the recommended
dictionaries list — offer `.zip` archives this build cannot consume and now fail at install with a
clear message rather than having been removed.

**Also deleted, on the same principle:** the vendored `ext/lib/pako.js` and the `dev/lib/pako.js`
that generated it. The codec's dynamic-import fallback to it was the extension path before the engine
moved native; afterwards nothing took it, while esbuild still resolved it statically and bundled a
**second** copy of pako into `yomitan-core.js`. pako is now injected at every construction site and
the codec throws without it.

## The numbers, once

**This section is the only place these figures live**, so nothing else has to be kept in step with
them. They are **point-in-time records, not a maintained dashboard** — each one is dated by the work
that produced it and none of them is a budget anything is checked against. Re-measure when a number
starts mattering (something feels slow, a size regresses), not because code changed; a stale figure
here costs nothing, and chasing them costs real time.

The one exception is a claim that would mislead: if a change makes a number here **wrong in
direction** — a lever that no longer works, a cost that moved by an order of magnitude — fix the
sentence, not necessarily the digits.

### The database

Measured on `kty-de-en` (947,070 term rows) through the real `DictionaryImporter`, deflate:

| Stage                             | Whole DB    |
| --------------------------------- | ----------- |
| IndexedDB baseline (app-reported) | ~700 MB     |
| SQLite, identity codec            | 366.4 MB    |
| SQLite, deflate                   | 170.5 MB    |
| + inflection synthesis (v4)       | 56.8 MB     |
| + empty reading index (v5)        | **49.4 MB** |

Two conclusions the measurements forced, kept here so they are not relitigated elsewhere:

- **The ~100 MB target was unreachable by compression, and irrelevant once the schema changed.**
  **78.1 MB** of the pre-drop database was index + row overhead no codec touches (49.5 index + 28.5
  row overhead). That breakdown was measured on the terms-only harness database of **149.7 MB**, not
  on the 170.5 MB above — the two figures come from different inputs and should not be subtracted
  from each other (#35); what carries is the proportion, which no codec can reach. The lever was
  never the codec — it was that **90% of the rows are inflections**. See
  [history/sizing.md](history/sizing.md).
- **zstd's best case saved ~13 MB on ~150 MB for a custom toolchain and ~24 MB of RAM.** Rejected.
  See [history/zstd.md](history/zstd.md).

### The engine bundle and its cold start

`native/Resources/yomitan-core.js`, and the cost of standing the engine up in a `JSContext`: context
creation + parsing the bundle + opening the database. Paid once per app-extension process, which
stays warm between calls on macOS — so this is a startup cost, not a per-lookup one, and it has never
been observed to matter in use. Medians of 25 interleaved runs of the `test:jsc` harness on
macOS 26.5.2, Apple silicon, against the fixture database, 2026-07-24.

| bundle                             | size        | cold start |
| ---------------------------------- | ----------- | ---------- |
| before the translator moved native | 379 KiB     | 8–10 ms    |
| with the translator, unminified    | 1.20 MB     | ~46 ms     |
| **with the translator, minified**  | **569 KiB** | **~41 ms** |

- **Minification is worth ~5 ms**, which is why it is the default rather than a release-only step
  ([decisions.md](decisions.md) #49). `--no-minify` is the debugging escape hatch.
- **The translator's language modules are what cost the 30-odd ms**, not the engine — 379 KiB →
  1.20 MB of bundle ([native-rewrite.md](native-rewrite.md) → Stage N3).
- Run-to-run spread is roughly ±3 ms, so treat differences smaller than that as noise. Dropping the
  double-bundled pako below took 617 → 569 KiB and left cold start inside that spread.
- **How to re-measure, if it ever matters:** `builds/native/jsc-harness --bundle <core.js>
--database <db> --request '{"action":"prepare","params":{}}' --startup`. The `--request` is not
  optional — the engine starts lazily, so `--startup` alone reports `0.0`.

### The bridge

~1 ms fixed per round trip, ~60 MB/s of payload, symmetric and linear. Method, caveats and the full
table: [native-engine-probe.md](native-engine-probe.md).

## Commands

```sh
./rebuild-safari.sh                   # build the extension + the app, sign, reinstall into Safari
./build-safari.sh --version X.Y.Z     # the bundle + the Xcode project, without signing/installing
npm run build:libs                    # regenerate ext/lib/* (gitignored; build-safari.sh copies it)
npm run build:native-core             # bundle the engine for JavaScriptCore
npm run compile:dictionary -- a.zip --out dictionaries.sqlite3
npm run test:unit                     # vitest (includes the SQLite backend tests)
npm test                              # the whole gate: eslint + tsc + css/html/json/md + vitest
                                      #   (+ the options and json-schema suites) + a dry-run build
npm run test:jsc                      # the native gate: node vs. JavaScriptCore, same database
npm run measure:storage               # measure codecs + DB size against the real kty-de-en
npx tsc --noEmit -p jsconfig.json     # main type-check
npm run test:ts:test                  # type-check the test/ project
npx eslint . --ignore-pattern '**/*.json'
```

`npm run build -- --target safari` still works and is what `rebuild-safari.sh` runs first, but it
does **not** produce the shipped bundle: `build-safari.sh` deletes
`builds/yomitan-safari-web-extension`, rebuilds it from `ext/` with its own manifest step, and adds
`yomitan-core.js`. What the earlier build is load-bearing for is its side effect — `buildLibs()`,
which regenerates the gitignored `ext/lib/*` that `build-safari.sh` then copies.
