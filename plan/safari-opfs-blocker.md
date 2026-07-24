# OPFS is not durable in a Safari web extension

Status: **settled by measurement, 2026-07-22.** This invalidates the storage half of the SQLite
migration on the Safari target. The SQLite engine, schema, importer, codec and inflection synthesis
are all unaffected — only the question of _where the database bytes live_.

## The symptom

An imported dictionary (`kty-de-en`, 947k terms, 49.4 MB) is present and queryable for as long as
Safari stays running, and is gone after Safari is restarted. `getDictionaryInfo()` returns `[]`, and
`navigator.storage.estimate()` reports a fresh, near-empty store.

## The cause

Safari regenerates the extension's `safari-web-extension://<UUID>` origin **on every launch**, on
purpose: a stable base URL would let any page fingerprint which extensions a user has installed by
probing for web-accessible resources. Apple documents the consequence for developers — assuming the
host is stable across launches "might cause bugs", and suspended extension-hosted tabs fail to
reload after a restart for exactly this reason.

OPFS is partitioned per origin. A rotating origin therefore means a fresh, empty OPFS on every
launch, with the previous one left behind unreachable. This is **orphaning, not eviction**: no
storage-persistence grant would prevent it (and Safari never grants one anyway — see the watch-out
in [progress.md](progress.md)).

## The measurement

Three consecutive Safari launches, **with no rebuild between them** (verified: the appex's
`pluginkit` registration UUID and timestamp stayed at `01196D03-…` / `2026-07-22 15:39:44Z`
throughout, and the app bundle was untouched):

| launch | origin UUID  |
| ------ | ------------ |
| 1      | `E464192D-…` |
| 2      | `BA47DF21-…` |
| 3      | `FC556108-…` |

Before restart #2, one marker was written into every storage mechanism available to an extension
page. After the restart, at the new origin:

| storage                | survived the restart?    |
| ---------------------- | ------------------------ |
| OPFS                   | **no** (`NotFoundError`) |
| IndexedDB              | yes                      |
| `localStorage`         | yes                      |
| `chrome.storage.local` | yes                      |

So WebKit _does_ keep extension storage under a stable identity — `chrome.runtime.id` is the
constant `dev.yomitan.safari.extension (9LMPV4ZRP8)` across all of this — but that stable identity
is applied to IndexedDB/localStorage and **not** to OPFS. That asymmetry is what makes the legacy
IndexedDB dictionary store survive restarts while the SQLite/OPFS one cannot.

It also explains the earlier "storage still shows ~500 MB" mystery: each launch after an import
leaves another orphaned copy of the database on disk, and nothing in the extension can ever reach or
delete them. A user who imports once and restarts ten times leaks ten copies.

### Reproducing it

Everything below is scriptable; no security-relevant clicks are involved (do **not** synthesize the
host-permission or extension-enable grants — see [DEV.md](../DEV.md)).

Getting a page at the extension origin is the only awkward part, because `open -a Safari
"safari-web-extension://…"` is rejected by LaunchServices and AppleScript's `set URL of tab` refuses
the scheme. The way in is the background page's own console:

1. **Develop → Web Extension Background Content → Yomitan Popup Dictionary → Personal** opens a Web
   Inspector on the background page. Beware: AX reports _stale, duplicated_ positions for the
   repeated "Personal" rows in that submenu, so clicking `menu item i` lands on the wrong extension.
   Derive the row's y from the first row's y plus the uniform 24 pt row pitch and `click at {x, y}`.
2. In that console, evaluate `chrome.tabs.create({url:'settings.html'})`. **Paste** it (`pbcopy`,
   then ⌘V) rather than `keystroke` it — the console auto-closes brackets and quotes, which mangles
   typed input.
3. That tab's URL carries the current origin UUID, and AppleScript `do JavaScript … in <tab>` can
   now drive it normally.

## What this rules out

- **Persistence.** Already ruled out independently; `persist()` always resolves `false` in WebKit.
- **Waiting for a fix.** The rotation is a deliberate privacy feature, not a bug. The _arguably_
  buggy part is that OPFS is not covered by the same stable partition IndexedDB gets — worth a
  WebKit report, but not something to design around.
- **Any VFS choice.** SAH-Pool vs. the default OPFS VFS is irrelevant; both live in OPFS.

## Options for the storage layer

**Decided: an IndexedDB snapshot owns the file, with OPFS kept as the working copy.** Designed in
[safari-idb-snapshot.md](safari-idb-snapshot.md), which also records why the alternatives lost — a
block VFS over IndexedDB charges an Asyncify tax on every query forever, `:memory:` charges grow-only
wasm memory proportional to total dictionary size, and native-container storage over
`nativeMessaging` relocates the durable copy without removing the OPFS working copy, so it solves
nothing IndexedDB does not already solve more cheaply. See that doc's fallback ladder for what
happens if the per-launch orphaned OPFS copies turn out never to be reclaimed.
