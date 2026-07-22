# Design: run the SQLite backend in a worker (Stage 5 blocker)

**Status: BUILT and VERIFIED AT THE EXTENSION ORIGIN.** A dedicated worker owns the connection, the
background proxies to it, and imports suspend it. 23/23 in real Safari at `127.0.0.1`, and in the
installed extension `kty-de-en` imports and answers lookups:

```
getDictionaryInfo   -> "kty-de-en (947070 terms)"
termsFind("geschützt") -> geschützt, schützen
```

`schützen` is the proof: that form-of row was **dropped at import**, so the pointer came from
inflection synthesis — the whole path (background page -> proxy -> worker -> OPFS -> SQLite ->
deflate -> synthesis -> translator) works at `safari-web-extension://`. This
is the fix for the bug that real-extension verification (Stage 5 item 1) surfaced: with
`USE_SQLITE_BACKEND` on, the extension imports correctly but cannot read the database back.

Read this document in order: the bug and its root cause, then the constraint, then
[RETRACTED](#retracted-sharedworker-does-not-work-in-safari-web-extension-pages) (the SharedWorker
hub that failed at the extension origin), then
[BUILT](#built-dedicated-worker--suspendresume-23-23-in-real-safari) for the shape that shipped.

`npm run test:safari` covers **both sides** of the seam. `test/safari/page-checks.js` runs in the
harness **page** — a Window, the same context the extension's background page is — and asserts:

- `createSyncAccessHandle` is undefined off a Worker (the bug itself, pinned as a regression guard),
- `prepare()` from a page proxies to the owning worker and reports prepared (105 ms),
- writes, `findTermsBulk` (exact + prefix) and **`getDictionaryInfo` — the exact call that returned
  "Database not open" in the extension** — all succeed over the proxy.

That layer exists because neither vitest (node, in-memory) nor `worker.js` (already inside a worker)
can see the page context the bug lived in.

## The bug, and how it was found

Flipping the flag, rebuilding, and importing `kty-de-en` into the real Safari extension: the import
finished (the OPFS file is **49.4 MB**, the exact expected post-drop/VACUUM size — `finalizeImport`
ran correctly), but the UI "crashed out of the import menu" and no lookups worked. Driving the live
extension over the `open -g` + AppleScript `do JavaScript` channel (DEV.md), the extension's own
`getDictionaryInfo` API returned:

```
Error: Database not open
  _require @ …/sqlite/dictionary-database-sqlite.js:1521
  getDictionaryInfo @ …/sqlite/dictionary-database-sqlite.js:934
  _onApiGetDictionaryInfo @ …/background/backend.js:1033   ← calls the SQLite backend directly
```

### Root cause (confirmed empirically)

1. The Safari build's background is a **persistent page** (`background.html`), not a service worker.
2. Safari has **no `chrome.offscreen`**, so `backend.js` takes its non-offscreen branch
   ([backend.js:69–73](../ext/js/background/backend.js)) and constructs `DictionaryDatabaseSqlite`
   **in the background page's main thread**.
3. `DictionaryDatabaseSqlite.prepare()` opens the OPFS SAH-Pool **in that same context**, but OPFS
   sync access handles are **Worker-only**. Verified live from a Window context in the real
   extension: `FileSystemFileHandle.prototype.createSyncAccessHandle` is **`undefined`** on the main
   thread (present inside a Worker). So `prepare()` throws, [backend.js:341–345](../ext/js/background/backend.js)
   swallows it into a `log.error`, `_db` stays null, and every query is "Database not open".

The **import** works only because it runs in its own dedicated worker
(`dictionary-worker-main.js`), where sync access handles exist — and because the failed background
open means nothing else is holding the single-connection pool at import time.

### Why the test suite didn't catch it

`npm run test:safari` runs the backend **inside a module worker already**, and vitest runs it in
node with `vfs:'memory'`. Neither exercises the background-**page** main-thread context that the
real extension uses. Only driving the installed extension does — which is exactly what item 1 is for.

## The constraint that dictates the design

The OPFS **SAH-Pool VFS is single-connection and worker-only**: exactly one Worker may hold the
pool's exclusive sync access handles at a time. So:

- The connection **must** live in a Worker (not the background page, not an offscreen document —
  both are Window contexts; the same `createSyncAccessHandle` gap would hit Chrome's offscreen path,
  but SQLite ships for Safari, so Chrome is out of scope here).
- **Only one** Worker can hold it. Today two separate workers touch the DB — the DB worker
  (`dictionary-database-worker-main.js`, media/SVG offload) and the import worker
  (`dictionary-worker-main.js`) — plus the background page tries to. That has to collapse to one
  owner.

The Safari background is a **persistent page**, so — unlike a Chrome service worker — it can host one
long-lived dedicated worker directly. That is the lever.

## Current topology (what exists)

- **Background page** (`backend.js`, persistent, Window): holds `_dictionaryDatabase` and calls it
  directly for every read (via `Translator`) and admin op. All page/popup/search reads funnel here
  through the `api.termsFind`/etc. message API.
- **DB worker** (`dictionary-database-worker-main.js` → `dictionary-database-worker-handler.js`):
  spawned today by the IndexedDB `DictionaryDatabase.prepare()` for **media/SVG offload only**. It
  runs its own `createDictionaryDatabase()` and exposes an `_apiMap` over a `MessagePort`
  (`connectToDatabaseWorker`) — currently one action, `drawMedia`. **This is the delegation vehicle
  to extend.**
- **Import worker** (`dictionary-worker-main.js` → `dictionary-worker-handler.js`): spawned
  per-import from the settings page; makes its own `createDictionaryDatabase()`, opens the DB,
  imports, `finalizeImport`s, closes, terminates.

The IndexedDB backend tolerates this fan-out because IndexedDB is multi-connection. SQLite/OPFS is
not.

## RETRACTED: `SharedWorker` does not work in Safari **web-extension pages**

The SharedWorker hub below was built, verified at `127.0.0.1` (24/24), then **failed at the extension
origin**. Driving the real settings page over `do JavaScript`, with the flag on and the extension
rebuilt:

| Probe (at `safari-web-extension://…`)                 | Result                         |
| ----------------------------------------------------- | ------------------------------ |
| `new SharedWorker(script, {type:'module'})`           | constructs, **no error event** |
| `port.postMessage({action:'isPrepared'})`             | **never replies** (timeout)    |
| a _fresh_ instance via `{name:'probe-…'}`             | also never replies             |
| the same module in a **dedicated** `Worker`           | loads fine, no error           |
| dynamic `import()` of the same module in the page     | loads fine                     |
| OPFS after all of it (`navigator.storage.estimate()`) | **empty, `usage: 0`**          |

So the module graph is worker-safe and the script is CSP-allowed (construction throws nothing), but
the `connect` event never fires and the worker never does anything — OPFS is untouched. It is not the
connect-listener style either: a control page on `127.0.0.1` serving the _same shape_ (module
SharedWorker + a static import) replied on **both** `self.addEventListener('connect', …)` and
`self.onconnect = …`.

**Conclusion: SharedWorker is silently non-functional in Safari web-extension pages.** The symptom in
the extension was the background page hanging forever on `await prepare()` (its RPC never answered),
which made every API call hang and left the settings page blank with `document.body.hidden === true`.

**Also learned the hard way:** the rebuild changed the extension's origin UUID
(`8BFC98A7…` → `B218D162…`), and Safari purged the old website data with it — the previously imported
49.4 MB `kty-de-en` is gone. `rebuild-safari.sh`'s in-place update preserves data only while the
registration survives; it did not here.

### BUILT: dedicated worker + suspend/resume (23/23 in real Safari)

The shipped shape, after the SharedWorker retraction:

- **The background page proxies to a dedicated worker** it spawns
  (`dictionary-database-worker-main.js`), which owns the one OPFS connection.
  `DatabaseOwnerClient` keeps the whole RPC surface; only `connect()` changed.
- **The import keeps its own worker.** The archive has to reach it as a _transferable_, which
  extension messaging cannot carry, so relaying the import through the background was never an
  option. Instead the background **lets go** for the duration: new `suspendDatabase` /
  `resumeDatabase` APIs, which `DictionaryWorker` wraps around every worker operation when the flag
  is on. `suspend` **terminates** the owner — closing the database is not enough, because the
  SAH-Pool keeps its OPFS handles for the worker's whole life.
- The `connectToDatabaseWorker` port-relay was evaluated and **rejected**: `_pmInvoke` routes through
  `navigator.serviceWorker.ready`, and the Safari build registers no service worker at all (its
  background is a page), so that promise never resolves. It is dead code on this path.

**Two bugs this shook out, both of the same family — a silent hang:**

1. **A message posted to a worker with no `message` listener yet is lost**, not queued. The handler
   registered its listener only after `await database.prepare()`, so the very first `prepare` request
   was dropped: it timed out even at 45 s while every later call succeeded. Listeners are now
   registered synchronously, before anything is awaited. (Measured after the fix: the owner is ready
   in **105 ms**.)
2. **A dead owner used to hang the caller forever.** `prepare` is now bounded by a timeout, so a
   worker that never starts surfaces as an error instead of wedging every API call behind it — which
   is precisely how the SharedWorker failure presented, with nothing in the log.

`test/safari/run.js` now serves `USE_SQLITE_BACKEND` as **on** regardless of what is committed: the
page-side checks build the SQLite backend explicitly, but the owner picks its backend through
`createDictionaryDatabase()`, so with the flag off the two halves would not match.

### The fallback, as originally sketched

Back to a **dedicated** worker owned by the persistent background page — already proven to work at
the extension origin, since the old import worker used OPFS there. The only open piece is how a
_second_ page (settings, for import) reaches that one owner, and the codebase already has the
mechanism: `connectToDatabaseWorker`. A page makes a `MessageChannel`, hands one end to the
background via `api.connectToDatabaseWorker(port)`, and the background forwards it to its worker —
exactly what `application.js` already does for the media-drawing worker. That gives every page a
_direct_ port to the single owner with no per-message relaying.

`DatabaseOwnerClient` keeps its whole RPC surface; only `connect()` changes — spawn-and-own in the
background, request-a-port-via-the-background elsewhere.

## Superseded: a **SharedWorker** can hold the connection — use it as the hub

Measured in real Safari (a SharedWorker on `127.0.0.1`, driven over the `do JavaScript` channel):

```json
{ "hasCtor": true, "hasMethod": true, "opened": true }
```

`FileSystemFileHandle.prototype.createSyncAccessHandle` **exists in a SharedWorker and actually
opens/writes/closes**. That is strictly better than a background-owned dedicated worker, because a
SharedWorker is _one instance per (origin, script)_ and every extension page shares the
`safari-web-extension://<UUID>` origin. So the background page **and** the settings page can each
connect to the **same** connection owner directly:

- no relaying imports through the background API,
- no close/reopen handoff dance between a background worker and a transient import worker,
- single-connection is guaranteed by the SharedWorker itself rather than by convention.

The owner/proxy split below is unchanged — only _which_ worker owns it. The connection handle is
abstracted behind one acquisition function so falling back to a dedicated worker (proven to work: the
current import worker uses OPFS at the extension origin) is a one-line change if needed.

**Still to verify:** SharedWorker construction at the _extension origin_ (CSP `script-src 'self'
'wasm-unsafe-eval'`; worker-src falls back to script-src, and the script is same-origin, so it should
pass). `safari-web-extension://` pages cannot be reached by `open` or AppleScript navigation — only
from the extension's own UI — so this check needs a Yomitan page opened by hand.

## Proposed design: one worker owns the connection; the background proxies to it

Give `DictionaryDatabaseSqlite` **two modes**, picked by context exactly as `DictionaryDatabase`
already does with `self.constructor.name === 'Window'`:

- **Owner mode (inside the DB worker):** the real backend. Opens OPFS (legal — it's a Worker),
  services an `_apiMap` over a `MessagePort`.
- **Proxy mode (in the background page):** opens nothing. On `prepare()` it spawns the one DB worker;
  every public method serializes `{action, params}` to the worker and awaits a correlated reply.

Then route **everything** through that one worker:

1. **Reads/admin (background → DB worker).** `findTermsBulk`, `findTermsExactBulk`,
   `findTermsBySequenceBulk`, `findTermMetaBulk`, `findKanjiBulk`, `findKanjiMetaBulk`,
   `findTagMetaBulk`, `findTagForTitle`, `getMedia`, `getDictionaryInfo`, `getDictionaryCounts`,
   `dictionaryExists`, `deleteDictionary`, `purge`, `isPrepared` — become proxy round-trips. This is
   the bulk of the new surface (~15 methods) and is a mechanical id-correlated request/response layer
   with transferables for BLOB/media payloads.
2. **Import (settings → DB worker), unified.** Instead of the separate `dictionary-worker-main.js`
   opening its own connection, route `importDictionary` to the **same** DB worker (add it to the
   worker's API; run the real `DictionaryImporter` there against the owner-mode backend, streaming
   `onProgress` back over the port as `DictionaryWorker` already does). One connection, no handoff.
   `deleteDictionary`/`getDictionaryCounts` from the settings page likewise target the DB worker.
3. **Media offload (unchanged in shape).** The media drawing worker keeps its direct
   `connectToDatabaseWorker` port to the DB worker; `drawMedia`/`getMedia` are served by the
   owner-mode backend there.

Net: exactly one Worker holds the OPFS connection for its whole life; reads queue behind an in-flight
import transaction (acceptable — imports are rare and the user is not scanning mid-import).

## Scope (files that change)

- `ext/js/dictionary/sqlite/dictionary-database-sqlite.js` — add proxy vs owner mode: worker spawn in
  proxy mode, an `_apiMap` of the full surface in owner mode, an id-correlated request/response
  client, transferable handling. **Largest piece.**
- `ext/js/dictionary/dictionary-database-worker-handler.js` — service the full DB `_apiMap` and the
  `importDictionary`/`deleteDictionary` operations over the port, with progress.
- `ext/js/background/backend.js` — no logic change if the proxy is transparent behind the existing
  `DictionaryDatabase` cast; verify the non-offscreen branch drives the proxy.
- `ext/js/pages/settings/…` import/delete path — target the shared DB worker instead of a throwaway
  `dictionary-worker-main.js` (or keep `DictionaryWorker` but have it forward to the DB worker).
- Types: message/apiMap definitions for the new actions.

`DictionaryDatabase` (IndexedDB) is untouched; the two backends still diverge behind the factory.

## How it gets verified (the loop that found the bug)

Each iteration, against the real installed extension:

1. `USE_SQLITE_BACKEND = true`, `./rebuild-safari.sh` (quits Safari — coordinated).
2. Re-import `dictionaries/kty-de-en.zip` (the migration notice should appear).
3. Over `do JavaScript`: call `getDictionaryInfo` (expect 1 dictionary, not "Database not open"),
   `termsFind` a German surface form (expect a synthesized-inflection hit), and confirm a real scan
   shows `iframe.yomitan-popup` with a definition.

`test:safari` stays the fast inner loop for the owner-mode backend; it cannot cover the proxy seam,
so the `do JavaScript` extension check becomes the gate for this work.

## Open questions for review

1. **Unify import into the DB worker (recommended) vs. keep a separate import worker with a
   close/handoff dance?** Unifying is cleaner and avoids two connections; it moves zip parsing into
   the DB worker (fine — it's a worker) but is a bigger diff to the import path.
2. **Proxy transparency vs. an explicit proxy class.** Extend `DictionaryDatabaseSqlite` with a mode
   flag (mirrors `DictionaryDatabase`), or split a `DictionaryDatabaseSqliteProxy` like
   `DictionaryDatabaseProxy`? The latter is cleaner but duplicates the surface signature.
3. **Worker lifecycle.** The persistent background page keeps the DB worker alive for the session; on
   an unexpected worker death, `prepare()` must be re-drivable. Do we add a heartbeat/respawn, or
   rely on the page's lifetime?
4. **Chrome/offscreen.** Out of scope (SQLite ships Safari-only), but the same Window-context gap
   means the offscreen path would need the same worker if SQLite ever ships there. Note only.
