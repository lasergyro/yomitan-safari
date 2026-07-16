# Real-Safari backend checks

Runs the SQLite/OPFS dictionary backend in **actual Safari**, in the background, and reports pass/fail
to the terminal.

```sh
npm run test:safari
```

## Why this exists

The vitest suite runs the SQLite backend under node with an in-memory VFS. That covers query and
import semantics, but it cannot touch the parts that actually gate shipping:

- the **OPFS SAH-Pool VFS** (needs a browser, a secure context, and worker sync access handles),
- the **vendored** `ext/lib/sqlite3.js` + `sqlite3.wasm` loading over HTTP,
- WebKit's own WASM behavior and storage quota.

It earns its keep: its first run caught a real bug node could not see — `prepare()` built a second
sqlite3 runtime on every call, so any close/reopen (including `purge()`) failed with
`InvalidStateError` because the first runtime's SAH pool still held the OPFS handles.

## How it works

1. `run.js` serves the repo over `http://127.0.0.1:8730`. Loopback is a **secure context**, so OPFS
   is available with no COOP/COEP (that is precisely why the backend uses SAH-Pool over the default
   OPFS VFS).
2. It opens the harness with **`open -g -a Safari`**. `-g` launches/uses real Safari **without
   bringing it to the foreground**, so your focus is never stolen.
3. `harness.html` spawns `worker.js` as a module worker — WebKit only exposes sync access handles to
   workers, the same reason the extension keeps its DB in a worker.
4. The worker imports the real backend from `ext/js/**` and the real vendored WASM from `ext/lib/**`,
   runs the checks, and posts results back to `/results`. The runner prints them and exits non-zero
   on failure.

`safaridriver` is deliberately not used: it has no headless mode and always opens a focus-stealing
automation window. Playwright's `webkit` would be headless but is a WebKit build, not the Safari the
users actually run.

## Options

| Env var      | Default  | Meaning                                 |
| ------------ | -------- | --------------------------------------- |
| `PORT`       | `8730`   | Port for the local server.              |
| `TIMEOUT_MS` | `120000` | How long to wait for results.           |
| `KEEP_OPEN`  | unset    | Suppress the "tab stays open" reminder. |

Requires `npm run build:libs` to have produced `ext/lib/sqlite3.js`, `ext/lib/sqlite3.wasm` and
`ext/lib/pako.js`. The test uses its own origin (`127.0.0.1`), so its OPFS data is separate from the
installed extension's and cannot corrupt your real dictionaries; it purges its own data on entry and
exit. Each run leaves a Safari tab open.

## What it does not cover

The extension origin itself (`safari-web-extension://…`): CSP, the DB worker spawned from the
offscreen document, and the real import/scan flow. That still needs `./rebuild-safari.sh` and a
manual pass — see [../../plan/03-progress.md](../../plan/03-progress.md).
