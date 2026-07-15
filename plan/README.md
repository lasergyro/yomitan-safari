# plan/ — dictionary storage backend refactor

Replace the Safari fork's IndexedDB dictionary store (~1.2 GB for one language) with
**SQLite-WASM on OPFS**, storing the heavy definition payload as a **zstd-compressed BLOB with
a per-dictionary trained dictionary** in a **columnar schema** that eliminates repeated strings.
Target: ~1.2 GB → ~100 MB. Branch: **`safari-refactor`**.

## Resume here (after a context reset)

- **Read order:** this file → [progress.md](progress.md) (what's done + exact next step) →
  [decisions.md](decisions.md) (why) → [design.md](design.md) (full reference: schema, measured
  numbers, feasibility, staged plan).
- **Status:** Stage 0 done; Stage 1 in progress. The **term backend core**
  (`DictionaryDatabaseSqlite`: `bulkAdd('terms'|'dictionaries')`, `findTermsBulk`,
  `findTermsExactBulk`) is committed and green, with a fixture-driven parity test against the
  IndexedDB backend. **Not yet done:** the rest of the query/import surface (meta/kanji/media
  stores, full importer run) and worker wiring behind `USE_SQLITE_BACKEND`. See progress.md →
  "Next steps".
- **Latest commit:** `a7ba6f19`. **Tag:** `stage-1` (marks start of Stage 1).
- **Feature flag:** `USE_SQLITE_BACKEND` in `ext/js/dictionary/dictionary-backend-config.js`
  (currently `false` — the IndexedDB path is still the only live one).

## Doc map

| File                         | Purpose                                                                                                 | Changes                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| [README.md](README.md)       | Index + resume-here + status                                                                            | often                           |
| [progress.md](progress.md)   | Implementation log, file map, next steps, open questions                                                | every work session              |
| [decisions.md](decisions.md) | Condensed decision log (what + why + status)                                                            | when a decision is made/revised |
| [design.md](design.md)       | Full design reference: baseline, measurements, feasibility, schema, staged plan, risks, reference index | rarely                          |

## Commands

```sh
npm run build -- --target safari      # build only the safari variant
./rebuild-safari.sh                   # rebuild + reinstall into Safari (quits/relaunches it)
npx vitest run test/sqlite-backend-smoke.test.js   # the SQLite backend tests
npx tsc --noEmit -p jsconfig.json     # main type-check
npm run test:ts:test                  # type-check the test/ project
npx eslint . --ignore-pattern '**/*.json'
```
