# Design: move the engine into the native app; the extension becomes display and UI

**Status: stages N0–N3 and N5 are built.** The engine — storage, queries, the codec,
inflection synthesis **and the translator** — runs in the Safari app extension, in JavaScriptCore,
over the system `libsqlite3`, reading a database in the app container. The app builds and signs, and
`npm run test:jsc` proves the native host answers identically to node on the same compiled database,
including full deinflected lookups. Stage N4 (options, Anki, audio) and N6 (iOS) remain — see
[Staging](#staging) for exactly what is done.

Supersedes [safari-idb-snapshot.md](history/safari-idb-snapshot.md), which was never built and is now
abandoned rather than held as a fallback: the OPFS storage layer it patched no longer exists in the
extension.

**Goal, as stated:** as much logic as possible lives in the native app; the browser extension deals
with display and UI.

**Why this is now on the table:** the storage blocker
([safari-opfs-blocker.md](history/safari-opfs-blocker.md)) has no good in-browser answer, and the bridge
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

**The contract is [native-protocol.md](native-protocol.md), and it is the only place it is written
down.** Actions, envelope, encodings, install and what a second host must implement all live there;
`npm run test:jsc` is its executable form. This section keeps only the four constraints that shaped
the staging below.

1. **One-shot, no push.** Safari has no `connectNative`, so there is no port and no server-side
   progress streaming. Everything is a call, and nothing may depend on a port.
2. **Concurrency.** The handler may be invoked for overlapping requests, so engine access is
   serialized on one queue — a `JSContext` is not re-entrant and the connection is opened `NOMUTEX`.
3. **Payload sizes.** 4 MB round-trips fine (68 ms); the hard cap was never measured.
4. **Serialization shape.** The probe timed a flat ASCII string, and a property list of nested rows
   with BLOBs might have behaved differently.

Constraints 3 and 4 were the two open questions at the start; what they turned into is **Stage N0**
below.

Two things this section used to specify that were **designed away rather than built**, recorded so
nobody looks for them: a `jobId`/`jobStatus` polling API for long operations (installs are
`installBegin`/`installChunk`/`installCommit`/`installAbort` instead, driven by the client), and an
in-bridge dictionary-install action taking an archive ([decisions.md](decisions.md) #50 — archives
are consumed on the build side and never cross the wire).

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

**Compile at build time, not in the browser. BUILT.** A node tool takes a Yomitan dictionary `.zip`
and emits a finished `.sqlite3` — schema, compressed payloads, trained codec dictionary, induced
inflection rules, dropped derivable rows, `ANALYZE`, `VACUUM`. It is
[`dev/bin/compile-dictionary.js`](../dev/bin/compile-dictionary.js) (`npm run compile:dictionary`),
which drives the real `DictionaryImporter` headless in node against SQLite-WASM.

_The plan originally said this "already substantially exists" as `npm run measure:storage -- --db`.
It did not: `measure-storage.js` mirrors `DictionaryImporter._packTermEntry` rather than running the
importer, which is exactly the terms-only harness whose figures [history/README.md](history/README.md#the-progress-log) retracted
under [decisions.md](decisions.md) #35. It remains a codec/size measurement tool; the compiler is a
separate, real one._

**Ship or serve.** Either bundled in the app's `Resources` or downloaded and verified (hash +
schema-version check) into the container. _Neither is built — a user compiles their own `.zip` and
installs it from the settings page ([decisions.md](decisions.md) #50)._

**Install** is then a file copy plus a schema-version check, not a 152-second import.

**What this deleted from the Safari target** (all done, stage N5):

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

1. **vitest, unchanged. DONE.** The core is the same JS, so the existing SQLite-backend, codec,
   inflection and translator tests keep running in node against `:memory:`. This is the main reason
   route C beats route A — route A would have thrown this coverage away.
2. **JSC equivalence harness. DONE** — `npm run test:jsc`, 21/21. Runs the _bundled_ core inside a
   `JSContext` against the same compiled database node reads and requires identical results. This
   catches bundling breakage, missing shims, and any JSC/V8 behavioral divergence. It grew one job
   the plan did not foresee: it is also the executable form of
   [native-protocol.md](native-protocol.md).
3. **XCTest** for the Swift layer: message routing, the SQLite binding, job lifecycle, error
   mapping, chunking. _Not built._ What exists instead is `test:jsc` driving the real host end to
   end, plus `test/native-host-shims.test.js`, which pins the schema version the Swift installer
   validates against.
4. **Extension-origin protocol test.** _Not built as a script._ `npm run test:safari` lost its
   purpose (there is no OPFS backend to prove) and was deleted with it. What replaces it is a manual
   check against the installed extension: **[DEV.md](../DEV.md) → The native engine → Checking the
   installed extension end to end**, which is the only place that recipe is written down. It is the
   one thing neither vitest nor `test:jsc` can see, because both run the engine outside Safari.

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
- _JSC cold start._ **8–10 ms** on macOS at the time — context creation + parsing the then-379 KiB
  bundle + opening the database. Comfortably inside a hover budget even from cold, which is what
  makes "engine in the appex" viable without a long-lived process. It has since grown with the
  translator ([README.md](README.md#the-numbers-once)) and is still inside that budget. Reported by
  `NativeEngineHost.startupMilliseconds`; the harness prints it with `--startup`, which needs a
  `--request` alongside it because the engine starts lazily.

**Stage N1 — protocol skeleton. DONE.** Swift message router, error mapping, the JS-side client
shim (`NativeEngineClient`), and the `{action, params}` → `{result} | {error}` envelope.

**Stage N2 — queries native. DONE.** The whole dictionary query surface is behind the shim:
`DictionaryDatabaseNative` implements the `DictionaryDatabase` API and forwards to the engine, which
is the unmodified `DictionaryDatabaseSqlite` hosted in JavaScriptCore over the Swift SQLite binding.
The OPFS/SAH-Pool path was not merely stopped — it was deleted (#44).

**Stage N3 — translator native. DONE.** `termsFind`, `kanjiFind` and `getTermFrequencies` are engine
actions; `TranslatorNative` in the extension forwards to them. A lookup is now **one** round trip
carrying only the entries that survived, where before it was half a dozen carrying every candidate
that was considered.

The transport needed one addition: `FindTermsOptions` holds a `Map`, a `Set|null` and live `RegExp`
objects, all three of which `JSON.stringify` turns into `{}` **silently** — a lookup would return
nothing rather than fail. `encodeFindTermsOptions` in `native-protocol.js` handles them, and the
equivalence gate passes a real `textReplacements` pattern so the rebuild path is exercised.

Cost: the language modules came with it, roughly tripling the bundle and taking cold start from
single-digit to tens of milliseconds — sizes and timings in
[README.md](README.md#the-numbers-once). Paid once per app-extension process, which stays warm
between calls on macOS. The bundle is minified by default so the artifact the gate tests is the one
that ships.

**Stage N4 — services.** _Remaining._ Options, Anki and audio still run in the extension.

**Stage N5 — delete. DONE.** The OPFS backend, the owner worker, the suspend/resume API, the
migration UX, `USE_SQLITE_BACKEND`, **the IndexedDB backend**, the Chrome offscreen document, the
real-Safari test runner and the in-browser import path are all gone. One backend remains.
(`dictionary-importer.js` stays as a build-time module for `npm run compile:dictionary`; nothing in
the extension imports it.)

**Stage N6 — iOS**, if wanted: drop `--macos-only`, and confront JSC-without-JIT and appex memory on
device.

### There is no flag

`USE_NATIVE_BACKEND` is gone along with the alternative it selected. `Backend` constructs
`DictionaryDatabaseNative` and `TranslatorNative` directly, and the settings UI installs a compiled
`.sqlite3` (`npm run compile:dictionary`) by streaming it into the app container.

**Two affordances in the settings UI now fail on purpose**: "Check for Updates" and the recommended
dictionaries list both offer Yomitan `.zip` archives, which this build cannot consume. They report
the install error rather than having been removed — removing them means unpicking the update machinery
threaded through `dictionary-controller.js`, which is its own change.

---

## Relationship to the snapshot plan

[safari-idb-snapshot.md](history/safari-idb-snapshot.md) is **abandoned.** It was the fallback if N0 raised a
red flag — a punitive size cap, a slow cold start, no App Group on a free team. N0 raised none: cold
start has grown with the translator but stays comfortably inside a hover budget
([README.md](README.md#the-numbers-once)); the size question is answered by chunking; and the App
Group question does not arise until the standalone app does. The layer it patched (OPFS storage
inside the extension) has since been deleted, so it is kept as a record of the reasoning, not as a
plan.

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
