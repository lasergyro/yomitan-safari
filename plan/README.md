# plan/ — dictionary storage backend refactor

Replace the Safari fork's IndexedDB dictionary store with **SQLite-WASM on OPFS**, storing the heavy
definition payload as a **deflate-compressed BLOB with a preset dictionary** in a **columnar schema**
that eliminates repeated strings. Branch: **`safari-refactor`**.

**Measured result: ~700 MB of IndexedDB → ~150 MB.** The original "~1.2 GB → ~100 MB" framing did not
survive measurement — the 1.2 GB baseline is unverified (the app reports ~700 MB), and ~100 MB is
unreachable by compression because ~78 MB of the database is indexes. See the numbers below.

## Resume here (after a context reset)

- **Read order:** this file → [03-progress.md](03-progress.md) (what's done + what's left) →
  [02-decisions.md](02-decisions.md) (why) → [01-design.md](01-design.md) (full reference: schema,
  measured numbers, feasibility).
- **Status:** Stages 0–4 are implemented and green and the codec is **decided: deflate**
  ([02-decisions.md](02-decisions.md) #26) — `createDictionaryDatabase()` now builds the SQLite
  backend with `DeflatePayloadCodec`. **The flag is still off**, so the extension still runs the
  IndexedDB backend and nothing user-visible has changed. `DictionaryDatabaseSqlite` has full API
  parity, passes the real importer/translator fixtures end-to-end (identity and deflate), and passes
  the **real Safari** checks.
- **Heads-up on the numbers — measured on the real `kty-de-en` (`npm run measure:storage`).
  Several claims in [01-design.md](01-design.md) do not survive it; its header lists them.**
  - **Whole-database sizes**: identity 345 MB, **deflate 149.7 MB** (from ~700 MB of IndexedDB).
    **~78 MB of that is indexes/keys, which no codec touches** — so **~100 MB is unreachable by
    compression**, and the remaining weight is the schema, not the payload. That, not the codec, is
    where any further size work goes.
  - **zstd was built, measured and rejected**; its ~13 MB edge did not pay for a custom toolchain,
    ~24 MB of RAM and import buffering. Removed in favour of deflate — [zstd/](zstd/README.md)
    keeps the evidence.
  - **A full table scan on every lookup was found and fixed** (75 ms → 0.064 ms). See
    [03-progress.md](03-progress.md) → "Query plans". This mattered far more than the codec choice,
    and only appeared on real data.
- **What gates the Stage 5 flip:** **extension-origin verification** (`./rebuild-safari.sh` + a
  manual scan pass) — see [03-progress.md](03-progress.md) → "Stage 5".
- **Feature flag:** `USE_SQLITE_BACKEND` in `ext/js/dictionary/dictionary-backend-config.js`
  (currently `false` — the IndexedDB path is still the only live one).

## Doc map

Numbered oldest → newest; read them in order.

| File                               | Purpose                                                                         | Changes                         |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| [README.md](README.md)             | Index + resume-here + status                                                    | often                           |
| [01-design.md](01-design.md)       | Full design reference: baseline, measurements, feasibility, schema, staged plan | rarely                          |
| [02-decisions.md](02-decisions.md) | Condensed decision log (what + why + status)                                    | when a decision is made/revised |
| [03-progress.md](03-progress.md)   | Implementation log per stage, watch-outs, file map, what's left                 | every work session              |
| [zstd/](zstd/README.md)            | Why zstd was built, measured and rejected; the real-data numbers                | closed                          |

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
