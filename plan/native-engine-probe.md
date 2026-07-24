# Probe: what the Safari native-messaging bridge actually costs

**Measured 2026-07-22 on macOS 26.5.2, Apple silicon, against the real installed extension.** This
exists to answer one question before anyone commits to it: if SQLite ran natively in the Swift app
instead of as WASM in the extension, would the `sendNativeMessage` round trip be fast enough to sit
in the hover path?

**Answer: yes, comfortably.** ~1 ms of fixed overhead per call and ~60 MB/s of payload throughput.
The bridge is not the bottleneck, and the objection that killed this option on paper does not
survive contact with a measurement.

## Numbers

`ping` echoes a payload of a caller-requested size and returns a native wall-clock stamp so the two
legs can be told apart. All times in milliseconds, from `performance.now()` in the extension's
background page.

| case                   |   up | down   |   n | median | p90 | max |
| ---------------------- | ---: | ------ | --: | -----: | --: | --: |
| empty (the floor)      |    0 | 0      |  30 |  **1** |   1 |   2 |
| hover-ish              | 1 KB | 32 KB  |  30 |  **2** |   2 |   3 |
| heavy lookup           | 4 KB | 256 KB |  20 |  **5** |   6 |  18 |
| bulk (an import batch) | 4 MB | 1 KB   |   5 | **68** |  69 |  69 |

Derived:

- **Fixed cost per round trip: ~1 ms.** The empty case is 1 ms median, 2 ms max, with no wake-up
  outlier after a single warm-up call — the app-extension process stays warm between calls.
- **Throughput: ~60 MB/s, and symmetric.** 4 MB up in 68.45 ms ≈ 58.8 MB/s; 256 KB down in 4.11 ms
  ≈ 60.8 MB/s. Cost is linear in payload size with no observed cliff.
- **The legs are independent.** The wall-clock split attributes the 4 MB case's 68 ms almost entirely
  to the request leg (68.45 up, ~0 down) and the 256 KB case's 5 ms mostly to the response leg
  (1.51 up, 4.11 down), exactly as expected. No hidden per-call asymmetry.

## What this means

- **A hover is affordable.** 2 ms for a realistic query shape, against a budget of tens of
  milliseconds. Native SQLite query time lands on top of this, but native SQLite is faster than the
  WASM build, so the engine side is not a concern.
- **Bulk transfer is affordable too.** ~60 MB/s means the whole 49.4 MB database moves in ~0.85 s,
  and an import's ~170 MB of compressed payload costs ~3 s of bridge time spread over ~40 batches —
  negligible beside the ~152 s the import already spends in pako deflate ([decisions.md](decisions.md) #37).
- **This corrects an earlier assumption.** The design notes previously assumed chunking ~50 MB
  through a plist-serialized one-shot bridge would be "brutal" and rejected native storage partly on
  that basis. That reasoning was wrong: the transport is roughly an order of magnitude cheaper than
  assumed. (Native _storage_ is still pointless — it does not remove the OPFS working copy, which is
  what leaks. Native _engine_ is a different proposition, and this probe is about that one.)

## Caveats — do not over-read this

1. **The payload was an ASCII string, not structured data.** Real traffic is rows containing binary
   BLOBs, which need either base64 (+33%) or `Data`, and a property-list dictionary of many rows may
   serialize more slowly than one flat string. These numbers are a **transport floor**, not a
   prediction for realistic result sets. Re-measure with a realistic row shape before committing.
2. **macOS only.** iOS is untested and is the platform with tighter memory limits and more
   aggressive process reclamation — the "stays warm between calls" property in particular may not
   hold there.
3. **This machine, unloaded.** No competing extension traffic, no memory pressure.
4. **Echo only.** No SQLite work, no disk I/O on the native side.

## How to re-run it

The `ping` action lives in the Swift handler template embedded in
[build-safari.sh](../build-safari.sh) (**not** in the generated
`builds/yomitan-safari-app/…/SafariWebExtensionHandler.swift`, which
`safari-web-extension-converter --force` overwrites on every build). It is inert unless called.

The probe script itself is not committed — it is ~90 lines of throwaway JS. To rebuild it: call
`chrome.runtime.sendNativeMessage(appId, {action: 'ping', payload, echoBytes})` in a loop, where
`appId` is `chrome.runtime.id` with the trailing ` (TEAMID)` stripped, exactly as
[anki-connect.js](../ext/js/comm/anki-connect.js) derives it. Safari may return a promise _and_ call
the callback, so handle both. Warm up once before timing, and report medians rather than means — the
distribution is tight but the first call is not representative.

Run it from the background page's console, reached via Develop → Web Extension Background Content →
Yomitan → Personal. The full recipe for driving that console from the shell, including the
stale-AX-position trap in that submenu, is in
[safari-opfs-blocker.md](safari-opfs-blocker.md#reproducing-it).

## Where this leaves the native-engine option

Latency was the main technical objection and it is answered. What remains unresolved is scope, not
speed:

- **Thin vs. thick split.** Thin — Swift owns "open the database, run this parameterized SQL, return
  rows", while the deflate codec, trained dictionaries and inflection synthesis stay in JS — keeps
  the bulk of this refactor's intellectual content, and its tests, in JS. Thick (porting the codec
  and rule induction to Swift) forks permanently from upstream Yomitan.
- **Pre-generated databases.** If the `.sqlite3` is produced at build time from the dictionary
  archive and shipped with the app or downloaded, the in-browser import path disappears entirely —
  which removes the importer, the trained-dictionary handshake and the suspend/resume worker dance
  from the Safari target at once. This is the variant worth designing, and it is a substantially
  different project from the IDB snapshot.
- **iOS distribution.** A free Personal Team means a 7-day sideload expiry; shipping means the App
  Store.
- **It makes the SQLite backend Safari-only by construction**, foreclosing any Chrome/Firefox path
  for it.
