# Design: an IndexedDB snapshot so the database survives a Safari restart

**Status: designed, never built — ABANDONED.** [native-rewrite.md](native-rewrite.md) was built
instead: the engine moved into the native app, which removes the OPFS storage layer this document
patches rather than working around it. It was held as the fallback until the stage-N0 measurements
came back — cold start 8–10 ms, the size question answered by chunking, the App Group question not
yet in play — and none of them raised the red flag it was insurance against. Nothing below is wrong;
the layer it applies to no longer exists.

This is the fix for the blocker in [safari-opfs-blocker.md](safari-opfs-blocker.md) — read that
first; it establishes the constraint this design works around.

**The shape in one sentence:** keep the SAH-Pool exactly as it is and keep every query running
against OPFS at full speed, but hold the authoritative copy of the database file in **IndexedDB**,
writing it at the points the database changes and restoring it into a cold pool at open.

## Why this shape

Safari regenerates the extension's origin UUID on every launch. OPFS is partitioned by origin, so it
comes up empty each time; IndexedDB, `localStorage` and `chrome.storage.local` do not (measured —
see the blocker doc). The database therefore has to live in one of the survivors, but SQLite's VFS
interface is **synchronous** and the only synchronous durable storage in any browser is OPFS sync
access handles. Something has to give:

| option                               | cost                                                                                                               | verdict                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Block VFS over IndexedDB (wa-sqlite) | Asyncify tax on **every query, forever**; replaces the vendored SQLite build; per-record IDB overhead on ~6k pages | rejected                              |
| `:memory:` + one IDB blob            | whole DB resident in **grow-only** wasm memory, additive per dictionary, never returned to the OS                  | rejected — see [RAM](#why-not-memory) |
| **IDB snapshot + OPFS working copy** | one full-file copy per launch, and double storage                                                                  | **chosen**                            |

The deciding property is that the chosen option's cost is paid **once per launch and is flat in
dictionary count**, while both rejected options charge either every query or every byte, forever.

It also touches remarkably little: no new WASM, no new dependency, no change to the schema, the
codec, the importer, inflection synthesis, the query paths, or the owner/proxy worker split from
[backend-worker.md](history/backend-worker.md).

### Why not `:memory:`

Worth stating explicitly because it looks cheaper than it is. WASM linear memory is **grow-only** —
`memory.grow` never returns pages to the OS, and SQLite freeing a page only returns it to the wasm
allocator. So a `:memory:` database is not "50 MB while in use"; it is a permanent high-water mark
for the life of the worker, set by the largest thing that ever happened (including the import peak)
and additive across dictionaries. Five dictionaries is ~250 MB pinned in a background page Safari is
free to jetsam. The OPFS working copy instead holds RAM roughly flat: SQLite's page cache is the
default ~2 MB (`open-sqlite.js` sets `page_size`, `synchronous` and `temp_store` but never
`cache_size`), independent of database size. The only term that grows is `_inflectionCache`, which
is per **dictionary**, not per byte.

## The API this rests on

The vendored SAH-Pool utility already provides everything needed
(`ext/lib/sqlite3.js:15235-15334`, in the vendored SQLite-WASM build that this fork no longer ships):

| method                            | sync?     | notes                                                                                                                                |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `exportFile(name) -> Uint8Array`  | **sync**  | allocates the **whole file** as one array. No chunked variant exists.                                                                |
| `importDb(name, bytes) -> number` | sync      | validates the `SQLite format 3` header; requires `size >= 512 && size % 512 === 0`.                                                  |
| `importDbChunked(name, callback)` | **async** | `callback()` returns chunks until `undefined`; truncates first, validates the header on the first chunk, same 512 rule on the total. |
| `getFileNames() -> string[]`      | sync      | how a cold pool is detected.                                                                                                         |

Note the asymmetry, because it decides the memory profile at each end: **restore can stream, export
cannot.** That is the one place this design has an unavoidable allocation spike.

## Mechanism

### Writing the snapshot

Snapshot points are exactly the operations that mutate the file **and** have a well-defined
completion:

1. **`finalizeImport()`** — [dictionary-database-sqlite.js:419](../ext/js/dictionary/sqlite/dictionary-database-sqlite.js#L419).
   Already the consistent point: it builds the inflection tables, drops derivable rows, `ANALYZE`s
   and `VACUUM`s. Snapshot after the `VACUUM`, so the stored bytes are the compact ones.
2. **`deleteDictionary()`**
3. **`purge()`**

**(2) and (3) are not optional.** Miss them and a user deletes a dictionary, restarts Safari, and the
deleted dictionary is back — a stale snapshot silently resurrecting data is worse than the bug being
fixed. Both already exist as owner-side actions in the RPC surface, so both are single call sites.

Deliberately **not** snapshot points: `bulkAdd` / `bulkUpdate`. They run thousands of times during an
import; snapshotting each would write ~50 MB per batch. An import that dies half-way therefore leaves
the previous snapshot intact, which is the correct outcome — a partial import is not worth
preserving, and the OPFS working copy is discarded at the next launch anyway.

Sequence at a snapshot point:

```
bytes = pool.exportFile('/dict.sqlite3')   // sync, ~49.4 MB, one allocation
blob  = new Blob([bytes])                  // hand off to IDB's file-backed storage
bytes = null                               // drop the array reference promptly
await snapshotStore.put({version, schemaVersion, byteLength, savedAt, blob})
```

Stored as a **Blob**, not a `Uint8Array`: WebKit backs IDB blobs with separate files rather than
serializing them into the record through structured clone, and it is what makes the streaming
restore below possible via `blob.slice()`.

### Restoring the snapshot

At open, in owner mode only, and only for `vfs === 'opfs'`:

```
pool = await sqlite3.installOpfsSAHPoolVfs({name: 'yomitan-dict', initialCapacity})
if (pool.getFileNames().length === 0) {          // cold origin — nothing here
    snapshot = await snapshotStore.get()
    if (snapshot !== null) {
        await pool.importDbChunked(path, nextChunkFrom(snapshot.blob))
    }
}
db = new pool.OpfsSAHPoolDb(path)                // opens the restored file, or creates an empty one
```

The restore must happen **between** installing the pool and constructing the database handle, and it
streams: `nextChunkFrom` walks the blob with `blob.slice(offset, offset + CHUNK).arrayBuffer()`, so
peak memory is one chunk. Use a **4 MiB** chunk — a multiple of both 512 (the API's requirement) and
the 8192-byte `page_size`.

Schema migration needs no special handling and must not get any: `createDictionarySchema` already
migrates on open by `PRAGMA user_version`
([dictionary-sqlite-schema.js:156](../ext/js/dictionary/sqlite/dictionary-sqlite-schema.js#L156)), so
a snapshot written by an older build is restored, then migrated, by the existing path. The envelope
carries `schemaVersion` for diagnostics and for refusing a snapshot from a **newer** build than the
running code, which migration cannot handle.

### Where the code goes

Put the policy in `open-sqlite.js` behind an **injected** snapshot store, mirroring how `sqlite3`
itself is injected (decisions.md #10): the node tests pass `vfs:'memory'` and no store, the extension
worker passes the real IDB-backed one. That keeps the IDB plumbing out of the vitest path — node has
no IndexedDB — while leaving the _policy_ (cold-pool detection, envelope validation, fallback)
testable with an in-memory fake.

The write side is a small method on `DictionaryDatabaseSqlite` called from the three mutation points,
guarded so it is a no-op when there is no store (tests, `:memory:`).

## Interaction with the existing worker topology

Nothing about [backend-worker.md](history/backend-worker.md) changes, but two interactions must hold:

- **Imports run in their own worker**, which holds the pool while the background's owner is
  terminated (`suspendDatabase`). That worker builds its backend through the same
  `createDictionaryDatabase()` factory, so putting the snapshot write inside the backend means the
  import worker performs it — correct, since it is the one holding the pool at `finalizeImport()`.
- **On resume**, the background spawns a fresh owner. Within one Safari session the OPFS file is
  still there, so `getFileNames()` is non-empty and **no restore happens**. The restore path costs
  nothing on the frequent case; it fires once per Safari launch.

The legacy-storage migration UX is unaffected — it deletes the old IndexedDB database `dict`, while
the snapshot lives in its own database under its own name.

## Costs, honestly

**Startup.** One ~49.4 MB read from IDB plus a write into OPFS on every Safari launch, on the
`prepare()` path the background already awaits. Expect a few seconds, scaling with total dictionary
size — five dictionaries means ~250 MB moved at every launch, which is the weak point of this design.
`prepare()` has no progress channel today, so this is silent; whether it needs one is an open
question below. **Unmeasured — measure it first** (see step 1 of the build order).

**Export spike.** `exportFile` has no chunked form, so the write side materializes the whole file as
one `Uint8Array` and then copies it into a Blob: a transient ~100 MB in the worker's JS heap (not
wasm memory — this is GC-reclaimable, unlike the `:memory:` option). It happens at `finalizeImport`,
where the import has already peaked higher. Acceptable, but it is the one allocation this design
cannot stream.

**Double storage.** ~49.4 MB in IDB plus ~49.4 MB in OPFS.

**The orphan leak is not fixed, and may be the real shippability question.** Every launch writes a
fresh working copy into the new origin's OPFS and abandons the previous one. Nothing inside the
extension can reach or delete another origin's OPFS, so this is unmitigable from our side — only
WebKit's own eviction can reclaim it, and **whether it does is unverified**. This is almost certainly
what the observed ~500 MB was. If eviction never runs, disk grows by ~49.4 MB per launch without
bound, and that would be a ship blocker on its own. Measuring it is step 1 of the build order for
exactly that reason.

The leak is a property of **using OPFS as the working store at all**, not of this snapshot scheme, so
the escape routes all give OPFS up rather than relocating the durable copy (native container storage
in particular does **not** help — see [Rejected alternatives](#rejected-alternatives-recorded)). If
step 1 shows the copies are never reclaimed, the ladder is:

1. **`:memory:` + the same IDB snapshot.** No OPFS, so no leak, at the grow-only wasm RAM cost above.
   That cost stops being disqualifying once unbounded disk growth is on the other side of the scale,
   and the snapshot store built here is reused unchanged — only the working store differs.
2. **Keep the IndexedDB backend on Safari**, shipping SQLite only where OPFS is durable. Cheapest to
   reach, but it freezes the flag and both code paths in place and forfeits Stage 5 item 7.

## Build order

Deliberately front-loaded with the two measurements that could invalidate the design, before any
real code is written.

1. **Measure the orphan leak and the restore cost.** Import once, then launch Safari ~10 times,
   recording `navigator.storage.estimate()` each time. Monotonic growth of ~49.4 MB/launch confirms
   the leak is real and unreclaimed; flat or sawtooth means WebKit evicts and the concern is closed.
   Time a manual `exportFile` → IDB → `importDbChunked` round-trip on the real 49.4 MB file in the
   same run. Both are scriptable — the recipe for reaching the extension origin is in
   [safari-opfs-blocker.md](safari-opfs-blocker.md#reproducing-it). **Do not skip this**; the numbers
   decide whether to build the rest.
2. **The snapshot store**, standalone: open/put/get/delete against IDB, Blob-valued, envelope
   versioned, with the in-memory fake for tests.
3. **The restore path** in `open-sqlite.js`, injected, guarded on `vfs === 'opfs'` and a cold pool.
4. **The write path** at the three mutation points.
5. **`test:safari` coverage** (below).
6. **The extension-origin gate**: import, quit Safari, relaunch, confirm the dictionary is still
   there and `termsFind('geschützt')` still returns the synthesized `schützen`.

## Testing

The existing three-layer split holds, and the middle layer is where this actually gets proven:

- **vitest (node, `:memory:`)** — policy only, against the in-memory fake store: cold pool +
  snapshot ⇒ restore attempted; warm pool ⇒ not attempted; snapshot from a newer schema ⇒ refused;
  corrupt envelope ⇒ falls back to empty rather than throwing out of `prepare()`.
- **`npm run test:safari`** — the real proof, and the reason this runner exists. It runs inside a
  module worker, which has **both** real IDB and real OPFS sync access handles, so it can do the
  whole round trip that node cannot: import fixture data → snapshot → `pool.wipeFiles()` to simulate
  a fresh origin → reopen → assert the restore ran and queries answer correctly. Add a guard that a
  **warm** pool does _not_ restore, since a silent restore-every-open would be a large invisible
  regression.
- **Extension origin** — the real restart, per step 6.

## Failure modes to handle explicitly

Every one of these must leave the user with a working (if empty) extension rather than a `prepare()`
that throws, because `backend.js` swallows a failed prepare into a `log.error` and every subsequent
query then reports "Database not open" — the exact silent failure documented in
[backend-worker.md](history/backend-worker.md).

| condition                                 | behavior                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| No snapshot, cold pool                    | fresh install — open an empty database                                  |
| Snapshot present, warm pool               | ignore the snapshot; do not restore                                     |
| Corrupt snapshot / header check fails     | catch, discard the partial file, open empty; surface a re-import prompt |
| Snapshot `schemaVersion` newer than build | refuse to restore, open empty                                           |
| IDB write fails (quota, disk)             | log and continue — the import itself still succeeded                    |
| Restore interrupted mid-stream            | partial file discarded on the next open (header check catches it)       |

`importDbChunked` already fails safe on its own: it clears the SAH's associated path on any throw, so
a partially written file is not left mapped under the database name.

## Rejected alternatives, recorded

- **Page-level incremental snapshotting** (`dbstat`-diffed pages, or the SQLite session extension)
  would avoid rewriting 49.4 MB when one dictionary of five is deleted. Rejected for now: it trades a
  rare full rewrite for permanent complexity and a hand-rolled consistency argument. Revisit only if
  the measured full-write cost proves painful.
- **`kvvfs`** — targets `localStorage`/`sessionStorage`, ~5 MB ceiling. Not viable at any size.
- **Native container storage over `nativeMessaging`** — the app's container
  (`~/Library/Containers/dev.yomitan.safari.extension/…`) is keyed by bundle identifier and is
  genuinely stable, and the bridge already exists (`SafariWebExtensionHandler.swift` serves
  `ankiRequest` today; the safari variant already promotes `nativeMessaging` into `permissions`).
  **Rejected, and specifically _not_ a fallback for the orphan leak** — an earlier draft of this doc
  claimed it was, which is wrong. The leak comes from the OPFS **working** copy plus the rotating
  origin, and native storage does not remove the working copy: SQLite still needs synchronous
  storage, so OPFS is still there and still orphaned per launch. It only relocates the _durable_
  copy, which IndexedDB already does. (The "~50 MB through the bridge would be brutal" half of the
  original argument was **wrong** and is retracted — the bridge measures ~1 ms fixed and ~60 MB/s, so
  that transfer is under a second: [native-engine-probe.md](native-engine-probe.md). The reason
  native storage loses is that it fixes nothing, not that it is slow.)
- **Running SQLite natively in the Swift app** — a genuinely different architecture that makes the
  origin rotation, OPFS, the leak, the per-launch copy and the wasm heap all disappear at once, and
  the bridge is now measured fast enough to carry it
  ([native-engine-probe.md](native-engine-probe.md)). Not rejected on the merits — it is simply a
  much larger project than this one, it makes the SQLite backend Safari-only by construction, and it
  is most attractive in the variant where the database is **pre-generated at build time** and the
  in-browser import path goes away entirely. Out of scope here; this design does not foreclose it.
- **Waiting for a WebKit fix.** The origin rotation is deliberate; the arguably-buggy part is that
  OPFS is not covered by the same stable partition IndexedDB gets. Worth filing, not worth blocking
  on.

## Open questions for the implementation chat

1. **Does `prepare()` need a progress channel?** A multi-second silent restore at every launch is
   poor, but plumbing progress through `prepare` touches the RPC contract. Depends on the step-1
   timing.
2. **Snapshot on a timer or at shutdown, as well?** Currently the three mutation points are the only
   triggers, which is sufficient for correctness. A background page has no reliable shutdown hook, so
   probably not.
3. **Should the working copy be deleted on a clean exit** to blunt the orphan leak? Same missing
   shutdown hook, and rotation happens between sessions regardless — probably unimplementable.
4. **Does this change the Stage 5 item 7 endgame** (remove the IndexedDB path and the flag)? It
   should not: SQLite remains the single backend on Safari and the snapshot is an implementation
   detail beneath it. Worth confirming once built.
