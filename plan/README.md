# plan/ — dictionary storage backend refactor

Replace the Safari fork's IndexedDB dictionary store (~1.2 GB for one language) with
**SQLite-WASM on OPFS**, storing the heavy definition payload as a **compressed BLOB with a
per-dictionary trained dictionary** in a **columnar schema** that eliminates repeated strings.
Target: ~1.2 GB → ~100 MB. Branch: **`safari-refactor`**.

## Resume here (after a context reset)

- **Read order:** this file → [03-progress.md](03-progress.md) (what's done + what's left) →
  [02-decisions.md](02-decisions.md) (why) → [01-design.md](01-design.md) (full reference: schema,
  measured numbers, feasibility).
- **Status:** Stages 0–4 are implemented and green; **the flag is still off**, so the extension
  still runs the IndexedDB backend and nothing user-visible has changed.
  `DictionaryDatabaseSqlite` has full API parity, passes the real importer/translator fixtures
  end-to-end (identity **and** deflate codecs), passes 12/12 checks in **real Safari**, and is
  wired behind `createDictionaryDatabase()`.
- **Two things are NOT done**, and both gate the Stage 5 flip:
  1. the **[zstd codec](zstd/README.md)** (blocked on a custom WASM build), and
  2. **extension-origin verification** (`./rebuild-safari.sh` + a manual scan pass).
     See [03-progress.md](03-progress.md) → "Stage 5".
- **Feature flag:** `USE_SQLITE_BACKEND` in `ext/js/dictionary/dictionary-backend-config.js`
  (currently `false` — the IndexedDB path is still the only live one).

## Doc map

Numbered oldest → newest; read them in order.

| File                               | Purpose                                                                              | Changes                         |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| [README.md](README.md)             | Index + resume-here + status                                                         | often                           |
| [01-design.md](01-design.md)       | Full design reference: baseline, measurements, feasibility, schema, staged plan      | rarely                          |
| [02-decisions.md](02-decisions.md) | Condensed decision log (what + why + status)                                         | when a decision is made/revised |
| [03-progress.md](03-progress.md)   | Implementation log per stage, watch-outs, file map, what's left                      | every work session              |
| [zstd/](zstd/README.md)            | **Outstanding task**: zstd + trained-dictionary codec (blocked on a zstd WASM build) | when picked up                  |

## Commands

```sh
npm run build -- --target safari      # build only the safari variant
./rebuild-safari.sh                   # rebuild + reinstall into Safari (quits/relaunches it)
npm test                              # full vitest suite (includes the SQLite backend tests)
npm run test:safari                   # run the backend in REAL Safari, backgrounded (no focus steal)
npx tsc --noEmit -p jsconfig.json     # main type-check
npm run test:ts:test                  # type-check the test/ project
npx eslint . --ignore-pattern '**/*.json'
```
