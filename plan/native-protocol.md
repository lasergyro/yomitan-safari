# The native bridge protocol

**Status: implemented and stable.** This is the contract between the browser extension and whatever
native host holds the dictionary engine. It exists because a second host is plausible — Linux and
Firefox — and until now the contract was implicit in the Swift implementation plus a TypeScript
type file, which is a bad thing to ask a second implementer to reverse-engineer.

**The engine is not part of this contract.** The engine is JavaScript
([`ext/js/native/native-core.js`](../ext/js/native/native-core.js)) and every host runs the same
bundle. What a host implements is the seven-function platform surface underneath it, a message
router, and the file-installer actions. Everything in "Engine actions" below is already written and
is not a host's problem.

Executable version of this document: **`npm run test:jsc`**. It answers the same requests through
node and through the real host and requires identical replies. A host that passes it is conformant;
a claim here that contradicts it is a bug in this document.

---

## Layers

```
  extension                        host process                      the engine
┌──────────────────┐   one JSON   ┌──────────────────┐            ┌──────────────────┐
│ NativeEngine     │  string each │  router          │  action +  │ NativeCore       │
│ Client.invoke()  ├─────────────►│  ├ host actions ─┤  params    │ (the JS bundle,  │
│                  │◄─────────────┤  └ "engine" ─────┼───────────►│  identical       │
│ .invokeHost()    │              │                  │◄───────────┤  everywhere)     │
└──────────────────┘              └──────────────────┘   result   └──────────────────┘
                                    ▲ per-host code       or error   ▲ shared code
```

Two kinds of action, and the split is deliberate:

- **Host actions** are about files and processes — installing a database, reporting whether the host
  is alive. They never reach the engine, and each host implements them itself.
- **Engine actions** are about dictionary data. The router forwards them verbatim and returns the
  reply verbatim; it does not parse them. Adding one is a change to the engine only.

---

## Addressing the host

The only browser-specific part of the engine bridge, and the one module a second host's client has to
care about: [`ext/js/native/native-host-ids.js`](../ext/js/native/native-host-ids.js).

| Browser              | How the host is named                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Safari**           | By **bundle identifier**. There is no registry; the host is the app extension inside the containing app. `chrome.runtime.id` reports it, with ` (TEAMID)` appended. |
| **Firefox / Chrome** | By a **name registered on the machine**, in a native-messaging manifest under a well-known directory. `chrome.runtime.id` is unrelated to it.                       |

The client offers candidates in order and remembers whichever answers, so a wrong guess costs one
failed call on the first lookup of a session:

1. Safari's bundle-id pair (app and appex), derived only when `chrome.runtime.id` actually looks like
   a reverse-DNS bundle id — a Firefox extension id (`{uuid}`, `name@domain`) does not, and skipping
   it saves a pointless round trip.
2. `REGISTERED_NATIVE_HOST_NAME` — currently `dev.yomitan.engine`.

A Linux/Windows installer writes a manifest whose `"name"` is exactly that constant, for example to
`~/.mozilla/native-messaging-hosts/dev.yomitan.engine.json`. **Changing the constant orphans every
installed host**, so treat it as permanent.

### `ankiRequest` addresses the host separately

`ankiRequest` is in the host-action table below because it is served by the same handler, but its
client is not `NativeEngineClient`: [`ext/js/comm/anki-connect.js`](../ext/js/comm/anki-connect.js)
predates the engine and builds its own candidate list, with the **same** bundle-id derivation and a
**different** last resort — the legacy `yomitan_anki` registered name, not
`REGISTERED_NATIVE_HOST_NAME`. [`build-safari.sh`](../build-safari.sh) then rewrites that array at
build time with the concrete bundle ids, so the `--bundle-identifier` flag reaches it.

The two lists are deliberately not merged — an upstream user with a `yomitan_anki` host registered
would lose it — but the derivation is duplicated, and a second host implementing `ankiRequest` has to
satisfy both paths. Treat `native-host-ids.js` as authoritative for the engine and this paragraph as
the note that Anki is the exception.

---

## Transport

**One JSON string in each direction.** Not a nested property list or a structured-clone object.

This is load-bearing rather than stylistic. The only transport measurement we have
([native-engine-probe.md](native-engine-probe.md)) timed a single flat ASCII string, and its first
caveat was that a property list of many nested rows might serialize very differently. Sending one
string keeps those numbers applicable instead of reopening the question per result shape, moves the
structural cost to `JSON.parse` — fast, and profileable in the browser — and sidesteps plist's lack
of a byte-array type that survives `SFExtensionMessageKey` intact.

Measured: **~1 ms fixed per round trip, ~60 MB/s of payload**, symmetric and linear.

**One-shot, because Safari has no `connectNative`.** There is no port, no push, and no server-side
progress streaming. A host on a browser that _does_ have `connectNative` may hold a port instead —
`NativeEngineClient._send` is the only method that would change and the wire format would not — but
nothing may _require_ a port, or the Safari host stops working.

---

## Envelope

### Host actions

Request: a flat object with `action` and whatever that action needs.

```jsonc
{ "action": "installChunk", "chunk": "<base64>" }
```

Reply: a flat object. `error` (a string) means failure; anything else is success.

```jsonc
{"ok": true, "bytesWritten": 3145728}
{"error": "The uploaded file is not a usable dictionary database: schema version 4, expected 5"}
```

### Engine actions

Request: the host action `engine`, whose `request` field is **a JSON string** the host does not
parse.

```jsonc
{ "action": "engine", "request": "{\"action\":\"termsFind\",\"params\":{…}}" }
```

Reply: `response` carries the engine's JSON string verbatim.

```jsonc
{
  "response": "{\"result\":{\"dictionaryEntries\":[…],\"originalTextLength\":3}}",
}
```

Inside that string, exactly one of two keys:

```jsonc
{"result": …}                                             // `undefined` is normalized to null
{"error": {"message": "…", "name": "Error", "stack": "…"}}
```

A failure _before_ the engine is reached — unknown action, engine failed to start — comes back as
the host-level `{"error": "…"}` instead. The client handles both, so a host that cannot start its
engine still produces a legible error rather than a malformed-response one.

---

## Encoding rules

Four shapes do not survive `JSON.stringify`, and **all four fail silently** — they stringify to
`{}` or to a plain object, so the call succeeds and returns nothing rather than throwing. That is
why they live in one module,
[`ext/js/native/native-protocol.js`](../ext/js/native/native-protocol.js), imported by both ends.

| Shape                                 | On the wire                                    | Encoder                  |
| ------------------------------------- | ---------------------------------------------- | ------------------------ |
| `Map` / `Set` of enabled dictionaries | `string[]` of names                            | `encodeDictionarySet`    |
| `ArrayBuffer` media content           | base64 (+33%; off the hover path)              | `encodeMediaResults`     |
| `FindTermsOptions`                    | `Map`→entries, `Set`→array, `RegExp`→src+flags | `encodeFindTermsOptions` |
| `Error`                               | `{message, name, stack}`                       | `serializeError`         |

Two traps worth stating outright, because both have already bitten:

- **The enabled-dictionary argument is a `Map`, not a `Set`.** Callers pass the translator's
  `Map<string, FindTermDictionary>`, whose default iterator yields `[key, value]` pairs — spreading
  it sends pairs, not names. `keys()` is what both shapes agree on.
- **`textReplacements` holds live `RegExp` objects.** Source and flags cross; the regex is rebuilt on
  the far side. `test:jsc` passes a real pattern so this path is exercised rather than assumed.

Binary in the other direction (installing a database) is base64 too, chunked — see below.

---

## Host actions

| Action          | Request fields | Reply                                                    | Notes                                                                    |
| --------------- | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `engineStatus`  | —              | `{ok, databasePath, databaseBytes, startupMilliseconds}` | Must **not** start the engine — it would report its own cold-start cost. |
| `installBegin`  | —              | `{ok}`                                                   | Closes the engine's handle; opens a staging file.                        |
| `installChunk`  | `chunk`        | `{ok, bytesWritten}`                                     | `chunk` is base64.                                                       |
| `installCommit` | —              | `{ok, databaseBytes}`                                    | Validates, then replaces the live database.                              |
| `installAbort`  | —              | `{ok}`                                                   | Discards the staging file. Idempotent.                                   |
| `optionsLoad`   | —              | `{ok, options?}`                                         | Reads `options.json`. `options` is **omitted** when the file is absent.  |
| `optionsSave`   | `options`      | `{ok, bytesWritten}`                                     | Writes the options JSON string atomically. `options` is that string.     |
| `ankiRequest`   | `url`, …       | `{status, responseText}`                                 | Loopback-only HTTP proxy. Predates the engine; addressed separately.     |
| `ping`          | `echoBytes`, … | `{ok, receivedBytes, nativeTimestampMs, payload}`        | The latency probe. Inert unless called.                                  |

### Install requirements

A host must get three things right here, all for the same reason — a user who loses their
dictionaries has lost hours:

1. **Stage, do not write in place.** A transfer interrupted half-way (the host is terminated, the
   browser closes) would otherwise leave a truncated file where a working database was.
2. **Validate before swapping.** Check the `SQLite format 3\0` magic at offset 0 and the schema
   version — a big-endian `uint32` at offset 60, `PRAGMA user_version` — against the version the
   engine reports. This catches the two realistic mistakes: uploading the `.zip` by accident, and
   installing a database built by an incompatible version.
3. **Remove `-journal`, `-wal` and `-shm` beside the old file.** They belong to the database being
   replaced, and leaving them lets SQLite recover the _previous_ database's transaction into the new
   file.

Chunking is 3 MB (see `INSTALL_CHUNK_BYTES`). `sendNativeMessage` has no documented size limit, the
largest round trip ever measured was 4 MB, and a 49 MB message is the sort of thing that works on a
developer's machine and fails on a user's.

### Why options are a host action

`optionsLoad`/`optionsSave` are **host** actions, not engine actions, even though the protocol
otherwise prefers engine actions (a host implements none of those). Options are not dictionary data,
and the dictionary database is replaced wholesale on every install — which options must survive — so
they cannot share its file and the engine has no reason to hold them. The store is one small
`options.json` beside the database in the app container; the extension keeps every line of the
versioned options migration (`options-util.js`) and only the bytes move. `optionsSave` must write
atomically (stage-and-rename), for the same reason the installer stages: a crash mid-write must not
truncate a working options file. The one payload is small and unchunked. A first `optionsLoad` that
finds no file omits `options` entirely, which is the extension's cue to migrate its legacy
`chrome.storage.local` copy once and otherwise fall back to defaults ([decisions.md](decisions.md)
#52).

---

## Engine actions

Forwarded verbatim; a host implements none of these. Params and returns are typed in
[`types/ext/native-bridge.d.ts`](../types/ext/native-bridge.d.ts) → `EngineApiSurface`, which is the
authority.

| Group      | Actions                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle  | `prepare`                                                                                                                                                                    |
| Dictionary | `getDictionaryInfo`, `getDictionaryCounts`, `dictionaryExists`, `deleteDictionary`, `purge`                                                                                  |
| Queries    | `findTermsBulk`, `findTermsExactBulk`, `findTermsBySequenceBulk`, `findTermMetaBulk`, `findKanjiBulk`, `findKanjiMetaBulk`, `findTagMetaBulk`, `findTagForTitle`, `getMedia` |
| Translator | `termsFind`, `kanjiFind`, `getTermFrequencies`, `clearDatabaseCaches`                                                                                                        |
| Audio      | `getTermAudioInfoList`, `downloadTermAudio`                                                                                                                                  |

`prepare` returns `{schemaVersion, dictionaryCount}` and is the version handshake. Every other action
prepares implicitly, because a host process may be terminated between calls and a client cannot be
made responsible for noticing — **except the two audio actions**, which touch no dictionary state and
so do not open the database. That is deliberate: it is what lets a client with no dictionaries
installed (a future game or desktop overlay) still fetch audio.

The audio actions run upstream `AudioDownloader` in the engine, over `fetch` below rather than the
browser's. Bytes come back base64 in `downloadTermAudio`'s `{data, contentType}`; audio is small
enough to need none of the chunking a database install does. Two source types are not yet handled
natively and return empty rather than throwing: `text-to-speech*` (browser `speechSynthesis`, still
played extension-side) and `custom-json` (its schema fetch wants a `chrome` the engine does not
have).

---

## What a host must implement

Seven functions and a router. That is the whole of it.

```ts
openDatabase(path: string): SqliteDatabaseHandle  // the interface in types/ext/sqlite-wasm.d.ts
databasePath(): string                            // where the database lives on this platform
log(level: string, message: string): void         // engine logging, to wherever this OS logs
now(): number                                     // monotonic milliseconds
fetch(request): {status, url, headers, bodyBase64, error?}  // one synchronous HTTP round trip
resolveUrl(url: string, base: string): string     // new URL(url, base).href
sha256(base64: string): string                    // SHA-256 of base64 bytes, base64 out
```

Plus: evaluate the bundle in a JavaScript engine, pump it, and route messages.

**`fetch` is synchronous and blocking**, which is not a limitation but the fit: the engine runs on
one queue that the host holds until a call settles (there is no async-I/O path — the async surface is
microtask-only), so a blocking fetch returns the whole body without the pump loop having to learn
about the network. It backs the audio downloader; `resolveUrl` and `sha256` back the two
web-platform bits that are easy to get subtly wrong, so a host supplies correct native ones rather
than the engine reimplementing them (native/Sources/YomitanNative/NativeEngineHost.swift; the JS
shims are `ext/js/native/native-web-shims.js`).

**Scope of `fetch`, stated because it is a real widening.** Unlike `ankiRequest`, which is
loopback-only, this reaches whatever host an audio source names — including arbitrary
`custom`/`custom-json` URLs a user configures. It is the same outbound traffic the extension already
made, now from the host process; a host should still refuse non-`http(s)` schemes, as the Safari one
does.

**The SQLite handle is where the risk is.** Two conversions are silent when wrong and are pinned by
`test:jsc`:

- **BLOBs must arrive as `Uint8Array`.** A BLOB read back as a string decompresses to garbage rather
  than failing.
- **Whole numbers must bind as INTEGER, not REAL.** A REAL `3.0` does not match an INTEGER `3` in an
  index seek, so lookups quietly miss.

**Pumping the engine.** Promises settle on their own wherever microtasks are drained (JavaScriptCore
does this when a native call returns; node has a real loop). Timers do not, in an embedded engine:
the Swift host calls `yomitanNativeRunNextTimer` in a loop while a call is unsettled, and treats
"unsettled with no timers left" as a deadlock rather than spinning. A node host gets this free and
can ignore it.

**Serialize everything.** One engine, one queue. A `JSContext` is not re-entrant, the SQLite
connection is opened `NOMUTEX`, and the engine caches prepared statements across calls.

### A node host, concretely

Most of one already exists: `answerInNode` in
[`dev/bin/test-native-core.js`](../dev/bin/test-native-core.js) is ~40 lines that build the host
object and call `core.invoke`. A shipping Linux host is that, plus:

- `node:sqlite` (built in since node 22, which this repo already requires) instead of SQLite-WASM, so
  there are no native dependencies to build;
- the stdio native-messaging framing — a `uint32` little-endian length prefix, then UTF-8 JSON;
- the install actions against XDG paths, and the `optionsLoad`/`optionsSave` pair reading and
  writing an `options.json` beside the database — both are file I/O, no engine involved;
- a real `fetch` (any HTTP client) in place of the gate's fixture one, plus `resolveUrl`/`sha256`
  from `node:url` and `node:crypto`;
- an installer that writes the native-messaging manifest.

---

## Non-goals

Stated so nobody adds them by reflex:

- **No archive import.** Dictionaries are compiled from `.zip` to `.sqlite3` on the build side
  (`npm run compile:dictionary`), and a host installs a finished file. There is deliberately no
  action that hands an archive across the bridge — the importer, the trained-codec handshake and the
  ~152 s of deflate stay off every user's machine. See [decisions.md](decisions.md) #50.
- **No push, no server-initiated messages.** Safari cannot, so nothing may depend on it. A long
  operation is therefore driven by the client, one call at a time — which is what the install
  actions are. **Nothing polls today**, and a `jobId`/`jobStatus` polling API was designed and then
  dropped in favour of that ([native-rewrite.md](native-rewrite.md) → The protocol); if some future
  operation cannot be split into client-driven calls, polling is the fallback, not the pattern.
- **No assumption about maximum message size.** Never measured; chunk anything unbounded.
- **`maxResults` truncation stays in the extension.** It is a display preference, and the engine's
  answer should not depend on a setting it has no other reason to know.

---

## Changing the protocol

- **Adding an engine action** touches the engine and the type file only. No host changes.
- **Adding a host action** must be implemented by every host, so prefer an engine action.
- **Changing an encoding** means changing `native-protocol.js`, which both ends import — that is the
  point of it being one module.
- **Changing the schema version** means `DICTIONARY_SQLITE_SCHEMA_VERSION`, the mirror in each host's
  installer, and recompiling every published database. A host cannot import the JS constant, so every
  host mirrors it as a literal and a bump that misses one leaves that host rejecting every valid
  database. `test/native-host-shims.test.js` reads
  `DictionaryStore.expectedSchemaVersion` out of the Swift source and asserts it matches — **a second
  host must add its own check there**, because nothing else in the suite can see a host's literal.
