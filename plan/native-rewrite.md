# Design: move the engine into the native app; the extension becomes display and UI

**Status: stages N0–N2 are built.** The engine runs in the Safari app extension, in JavaScriptCore,
over the system `libsqlite3`, reading a database in the app container. The app builds and signs, and
`npm run test:jsc` proves the native host answers identically to node on the same compiled database.
Stage N3 (translator native), N4 (services), N6 (iOS) remain — see [Staging](#staging) for exactly
what is done.

Supersedes [safari-idb-snapshot.md](safari-idb-snapshot.md), which was never built and is now
abandoned rather than held as a fallback: the OPFS storage layer it patched no longer exists in the
extension.

**Goal, as stated:** as much logic as possible lives in the native app; the browser extension deals
with display and UI.

**Why this is now on the table:** the storage blocker
([safari-opfs-blocker.md](safari-opfs-blocker.md)) has no good in-browser answer, and the bridge
turned out to be cheap — ~1 ms fixed, ~60 MB/s ([native-engine-probe.md](native-engine-probe.md)).
Moving the engine native makes the origin rotation, OPFS, the orphan leak, the per-launch copy, the
wasm heap and the single-connection worker dance all disappear at once, rather than trading one for
another. It is also the only direction that leads anywhere useful for a standalone macOS app.

---

## The constraint that shapes everything

**Yomitan's language logic is not data — it is live JavaScript.** Every deinflection rule carries a
closure and a compiled regex:

```js
// language-transforms.js
export function suffixInflection(inflectedSuffix, deinflectedSuffix, conditionsIn, conditionsOut) {
    return {
        isInflected: suffixRegExp,
        deinflect: (text) => text.slice(0, -inflectedSuffix.length) + deinflectedSuffix,
        …
    };
}
```

and `LanguageTransformer` calls them directly (`isInflected.test(text)`, `deinflect(text)`). That is
**1.1 MB across 23 languages in 16 transform files**, upstream-maintained and actively changing.
Most rules come from the mechanical `suffixInflection`/`prefixInflection` helpers and _are_
expressible declaratively — but not all: German, English and Spanish alone hand-write 32 bespoke
closures, and German's separable-prefix rules build regexes at module load.

So "port the logic to Swift" is not a mechanical translation. It is a permanent fork of the most
actively-developed part of upstream Yomitan, with the subtlest correctness properties in the project
(inflection synthesis is currently verified at **0 lost / 0 invented over 41,921 forms**).

### Three ways to satisfy the goal

| route                                                        | logic runs in the app? | forks from upstream? | effort     |
| ------------------------------------------------------------ | ---------------------- | -------------------- | ---------- |
| **A.** Port everything to Swift                              | yes                    | **permanently**      | very large |
| **B.** Leave the core in the extension                       | **no**                 | no                   | small      |
| **C.** Host the JS core in **JavaScriptCore** inside the app | **yes**                | no                   | moderate   |

**Recommendation: C.** `JavaScriptCore.framework` is a system framework on both macOS and iOS. The
existing JS core — translator, deinflection, the deflate codec with its trained dictionaries,
inflection synthesis, the query layer — runs _unmodified_ inside the native app, with **native
SQLite underneath it instead of SQLite-WASM on OPFS**. The logic genuinely lives in the app process,
which is the stated goal, and upstream changes keep merging.

This reframes the project usefully: **it is not a rewrite of the engine, it is a rewrite of the
engine's storage binding and host.** The 1,600-line SQLite backend, the codec and the inflection
rules keep their vitest coverage because they keep being the same code.

Route A stays available _afterwards_, incrementally, for any piece that proves hot or that we want
to shed JS from. Nothing here forecloses it.

---

## Target architecture

```
┌─ Safari extension (JS) ─────────────── display and UI only ──┐
│  content scripts   text-scanner, hit-testing, DOM extraction │
│  display           popup, structured content, templates      │
│  settings UI       HTML, backed by native state              │
│  native-client     thin shim: replaces the API/backend calls │
└───────────────────────────┬──────────────────────────────────┘
                            │ sendNativeMessage (one-shot, JSON)
┌───────────────────────────▼─ Native app (Swift) ─────────────┐
│  message router    the appex; validates and dispatches       │
│  JSC host          the unmodified JS core:                   │
│                      translator, deinflection,               │
│                      codec, inflection synthesis             │
│  SQLite binding    system libsqlite3, exposed to JSC         │
│  services          Anki, audio, options store                │
│  dictionary mgmt   install / list / delete / verify          │
└───────────────────────────▲──────────────────────────────────┘
                            │
┌───────────────────────────┴─ Build time (node) ──────────────┐
│  dictionary compiler:  .zip  ──►  .sqlite3                   │
│  (the existing importer, run headless)                       │
└──────────────────────────────────────────────────────────────┘
```

### What the extension keeps

Everything that must touch the page or the DOM, and nothing else:

- **`text-scanner.js`** (1,711 lines) and the frontend — hover/selection hit-testing, extracting the
  candidate text run. This cannot move; it needs live layout. (Mind the visual-viewport offset trap
  already recorded for Safari.)
- **Display** — the popup, structured-content rendering, templates, audio playback UI.
- **Settings UI** — the HTML pages, now reading and writing native state.
- **A native-client shim** replacing today's `API`/`Backend` message surface. Ideally this keeps the
  _same method names_ (`termsFind`, `kanjiFind`, `getDictionaryInfo`, …) so the display layer is
  untouched and the swap is invisible above it.

### What moves native

- Dictionary storage and every query.
- The payload codec and its per-dictionary trained dictionaries.
- Inflection rule induction and synthesis.
- The translator and all deinflection.
- Options/profile storage, Anki, audio fetching, dictionary media.

---

## Which process: appex or main app

The extension can only talk to **its own appex** (`sendNativeMessage` → `SafariWebExtensionHandler`).
So the appex is always the entry point. The question is whether the engine _lives_ there.

- **Start: everything in the appex.** Simplest, one process, and the probe shows it stays warm
  between calls on macOS.
- **Later: main app + XPC**, with the appex as a thin forwarder. This is what a standalone macOS app
  wants anyway — a long-lived process holding the database and serving both the app's own UI and the
  extension. Defer it, but do not design anything that blocks it: keep the message router a thin
  dispatch layer with no engine state of its own.

**Appex lifetime is a real constraint.** The process can be terminated between calls, so the engine
must survive a cold start cheaply — lazy open, cached handle, and no assumption that state from the
previous call is still there. Measure cold-start cost early (JSC init + bundle parse + DB open); if
it is slow, that is the argument for moving to a long-lived main-app process sooner rather than
later.

---

## The protocol

**Transport:** one-shot request/response over `sendNativeMessage`. There is **no `connectNative`** in
Safari, so there is no server push and no long-lived port. Everything is a call.

**Envelope**, mirroring the existing internal API shape so the shim stays thin:

```
→  {action: string, params: object}
←  {result: any}  |  {error: {message, stack?, data?}}
```

**Consequences to design around:**

1. **No push ⇒ long operations need job polling.** A dictionary install returns a `jobId`; the UI
   polls `jobStatus(jobId)` for progress. This replaces today's worker `onProgress` streaming.
2. **Concurrency.** The handler may be invoked for overlapping requests. SQLite access must be
   serialized on a dedicated queue (native SQLite is not the single-connection trap SAH-Pool was, but
   one writer at a time is still the sane model).
3. **Payload sizes.** 4 MB round-trips fine (68 ms). The hard cap is **unknown — find it early**, and
   chunk anything that could exceed it (dictionary media, large result sets).
4. **Serialization shape is unproven.** The probe used a flat ASCII string. Real traffic is nested
   objects with binary BLOBs, needing base64 (+33%) or `Data`. **Re-measure with a realistic result
   set before locking the protocol** — this is probe caveat #1 and it is the biggest remaining
   unknown in the design.

**First-cut action list:** `termsFind`, `kanjiFind`, `termsFindDetails`, `getDictionaryInfo`,
`getMedia`, `optionsGet`, `optionsSet`, `dictionaryList`, `dictionaryInstall`, `dictionaryDelete`,
`jobStatus`, `ankiRequest` (exists), `audioFetch`.

---

## The JSC host

The core is bundled and evaluated in a `JSContext`. Practical requirements, none exotic but all
needing doing:

- **Bundle to a single script.** JSC has no ES-module loader; the core has to be rolled up (esbuild
  or rollup) into one file. A build step, added beside the existing extension build.
- **Shim the platform.** Bare JSC has no DOM, no `TextEncoder`/`TextDecoder`, no `fetch`, no
  `console`. The core needs a small host shim; audit exactly what it touches (the codec uses typed
  arrays and pako — pure JS, fine; `TextDecoder` **is** used and needs a shim, and note the existing
  Safari watch-out about handing WASM-heap views to web APIs stops applying once there is no WASM).
- **Bridge SQLite.** Expose a small synchronous host object — `exec`, `prepare`, `bind`, `step`,
  `column`, `finalize` — over system `libsqlite3`. The existing backend already funnels every query
  through a narrow handle interface (`openDictionaryDatabaseHandle` injects the module), so this
  substitutes at a seam that already exists.
- **No JIT on iOS.** Third-party apps get the interpreter only. Deinflection is small work, but this
  is another reason to measure on device rather than assume.

**pako goes away eventually.** Once the codec runs natively, deflate with a preset dictionary is
system `zlib` (`deflateSetDictionary`/`inflateSetDictionary`) — and since deflate is ~90% of import
time ([decisions.md](decisions.md) #37), that matters if in-app import ever returns. Not needed
for the pre-generated path.

---

## The dictionary pipeline

This is the part that removes the most complexity, and it is what makes the whole direction worth it.

**Compile at build time, not in the browser.** A node tool takes a Yomitan dictionary `.zip` and
emits a finished `.sqlite3` — schema, compressed payloads, trained codec dictionary, induced
inflection rules, dropped derivable rows, `ANALYZE`, `VACUUM`. This tool **already substantially
exists**: `npm run measure:storage -- --db` runs the real importer headless in node to produce a real
database. It needs promoting from a measurement script to a supported build artifact.

**Ship or serve.** Either bundled in the app's `Resources` or downloaded and verified (hash +
schema-version check) into the container.

**Install** is then a file copy plus a schema-version check, not a 152-second import.

**What this deletes from the Safari target:**

- the in-browser importer and its worker,
- `suspendDatabase`/`resumeDatabase` and the whole OPFS single-connection handoff,
- the trained-dictionary handshake at import time,
- the legacy-IndexedDB migration UX,
- `USE_SQLITE_BACKEND` and the dual-backend split (Stage 5 item 7, reached by a different road).

---

## Storage location

The database lives in the **appex container**
(`~/Library/Containers/dev.yomitan.safari.extension/…`) — stable, keyed by bundle identifier, no
origin involved.

**Open question with a real risk:** if the main app must also read it (the standalone-app direction),
the file belongs in a shared **App Group** container instead. App Groups need a provisioning
entitlement, and the build currently signs with a **free Personal Team** — verify early whether that
combination is available, because it changes where the file lives and moving it later is a
migration.

---

## Testing

The strategy has to survive the core moving hosts. Four layers:

1. **vitest, unchanged.** The core is the same JS, so the existing SQLite-backend, codec, inflection
   and translator tests keep running in node against `:memory:`. This is the main reason route C
   beats route A — route A would have thrown this coverage away.
2. **JSC equivalence harness.** Run the _bundled_ core inside a `JSContext` against a fixture
   database and assert identical results to the vitest run. This catches bundling breakage, missing
   shims, and any JSC/V8 behavioral divergence. **This is the new gate and should exist from stage 1.**
3. **XCTest** for the Swift layer: message routing, the SQLite binding, job lifecycle, error
   mapping, chunking.
4. **Extension-origin protocol test.** `npm run test:safari` loses its purpose (there is no OPFS
   backend to prove), and is replaced by driving the installed extension over the console channel
   from [safari-opfs-blocker.md](safari-opfs-blocker.md#reproducing-it) — assert a real `termsFind`
   round-trips natively and returns the synthesized `schützen` for `geschützt`, the same end-to-end
   proof used today.

---

## Staging

Each stage lands independently and leaves the extension working. **Do not big-bang this.**

**Stage N0 — de-risk. DONE, and the answers changed the design in one place.**

- _Serialization shape._ Sidestepped rather than measured: **everything crosses as one JSON string**
  in both directions, so the probe's flat-string numbers apply directly instead of the question being
  re-opened for a property list of nested rows. See [decisions.md](decisions.md) #41.
- _Size cap._ Still unmeasured, and now handled by construction: the only payload that could
  plausibly approach it is a database install, which is chunked at 3 MB (#45). Worth measuring if a
  result set ever grows unbounded.
- _JSC cold start._ **8–10 ms** on macOS for context creation + parsing the 379 KiB bundle + opening
  the database. Comfortably inside a hover budget even from cold, which is what makes "engine in the
  appex" viable without a long-lived process. Reported by `NativeEngineHost.startupMilliseconds` and
  printed by the harness's `--startup`.

**Stage N1 — protocol skeleton. DONE.** Swift message router, error mapping, the JS-side client
shim (`NativeEngineClient`), and the `{action, params}` → `{result} | {error}` envelope.

**Stage N2 — queries native. DONE.** The whole dictionary query surface is behind the shim:
`DictionaryDatabaseNative` implements the `DictionaryDatabase` API and forwards to the engine, which
is the unmodified `DictionaryDatabaseSqlite` hosted in JavaScriptCore over the Swift SQLite binding.
The OPFS/SAH-Pool path was not merely stopped — it was deleted (#44).

**Stage N3 — translator native.** _Remaining._ Deinflection and result assembly move into the JSC
host, so `termsFind` is one call. The engine's action table is the place to add it; nothing in the
transport needs to change.

**Stage N4 — services.** _Remaining._ Options, Anki, audio, media. Also where the settings UI is
pointed at `installDatabase()` instead of the archive importer.

**Stage N5 — delete.** _Mostly done, ahead of schedule._ The OPFS backend, the owner worker, the
suspend/resume API, the migration UX and `USE_SQLITE_BACKEND` are gone. What is left is the
IndexedDB backend, which is upstream's and still serves the non-Safari targets, and the in-browser
importer, which those targets still need.

**Stage N6 — iOS**, if wanted: drop `--macos-only`, and confront JSC-without-JIT and appex memory on
device.

### Turning it on

`USE_NATIVE_BACKEND` in `ext/js/dictionary/dictionary-backend-config.js` is **`false`**. It stays
false until a dictionary can be installed from the settings UI (stage N4): with it on and no
database in the container, the extension comes up correctly but with nothing to look up, and the
only way to fix that today is to call `installDatabase()` by hand. Flip it together with that UI.

---

## Relationship to the snapshot plan

[safari-idb-snapshot.md](safari-idb-snapshot.md) is **abandoned.** It was the fallback if N0 raised a
red flag — a punitive size cap, a slow cold start, no App Group on a free team. N0 raised none: cold
start is 8–10 ms, the size question is answered by chunking, and the App Group question does not
arise until the standalone app does. The layer it patched (OPFS storage inside the extension) has
since been deleted, so it is kept as a record of the reasoning, not as a plan.

---

## Risks, honestly

- **This is much bigger than anything in this refactor so far** — a Swift app, a protocol, a JS host
  environment, and a build-time dictionary pipeline. The staging exists so it can be abandoned
  half-way with something still working.
- **Route C's bet is that hosting upstream JS in JSC is cheaper than porting it.** If the shim
  surface turns out to be large, or JSC-in-appex proves slow or memory-constrained, that bet is
  wrong and the choice is back between route A (fork) and route B (logic stays in the extension).
  N0 is where that is found out.
- **Display stays JS and stays in the extension**, so the popup/structured-content layer keeps
  tracking upstream normally. Good for maintenance, but it means "everything native" is never
  literally true — and shouldn't be; the DOM is where display belongs.
- **iOS distribution** is a genuine cliff: free Personal Team means a 7-day sideload expiry, so a
  usable iOS build means the App Store.
- **Safari-only by construction.** The SQLite work becomes unusable on Chrome/Firefox. Accepted
  deliberately — this is a Safari fork.
- **Media across the bridge.** Dictionary images currently come out of the database as blobs and get
  drawn in a worker. That path needs redesigning around chunking or a native-served local URL; it is
  the least-designed corner of this document.
