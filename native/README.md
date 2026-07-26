# native/ — the Yomitan engine, as a native app

The dictionary engine does not run in the browser on this fork. It runs here, in the Safari **app
extension**, over the system `libsqlite3`, reading a database in the app container.

**Why:** Safari regenerates the extension's `safari-web-extension://<UUID>` origin on **every
launch**, and OPFS is partitioned by origin — so a dictionary imported into OPFS is stranded on
every restart, and every launch leaks another copy. The app container is keyed by bundle identifier
and does not rotate. See [../plan/history/safari-opfs-blocker.md](../plan/history/safari-opfs-blocker.md) for the
measurement that settled it, and [../plan/native-rewrite.md](../plan/native-rewrite.md) for the
design.

**What is _not_ here:** a reimplementation of Yomitan. The engine's language logic is live JavaScript
— closures and compiled regexes across 23 languages, upstream-maintained — so it is **re-hosted in
JavaScriptCore**, not ported to Swift. The Swift in this directory is a SQLite binding, a JSC host,
a message router and a file installer. Everything above the SQL is the same code vitest runs.

**What runs here:** storage, every query, the payload codec, inflection synthesis, and the
translator — so a lookup is one `sendNativeMessage` round trip that returns finished dictionary
entries. What stays in the extension is what needs the DOM: scanning, the popup, and the settings UI.

**This is one host, not the only possible one.** The engine is JavaScript and the same bundle runs
unmodified anywhere; a host supplies four platform functions, a message router and a file installer.
A Linux host for Firefox is a node script — `node:sqlite` plus stdio framing — and most of it already
exists as `answerInNode` in [`../dev/bin/test-native-core.js`](../dev/bin/test-native-core.js). The
contract is [../plan/native-protocol.md](../plan/native-protocol.md); do not add anything to this
directory that the protocol does not describe.

## Layout

| Path                                                    | What it is                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Sources/YomitanNative/`                                | The app-extension sources. Copied into the generated Xcode project.                              |
| `Sources/YomitanNative/SqliteBridge.swift`              | System `libsqlite3`, exposed to JS with the handle interface the engine already speaks.          |
| `Sources/YomitanNative/NativeEngineHost.swift`          | The `JSContext`: platform surface, bundle evaluation, and the timer pump.                        |
| `Sources/YomitanNative/SafariWebExtensionHandler.swift` | The message router. Thin by design — the engine may move to a long-lived main-app process later. |
| `Sources/YomitanNative/DictionaryStore.swift`           | Container paths, and the staged/validated install of a compiled database.                        |
| `Sources/YomitanNative/OptionsStore.swift`              | The options/profile store: one `options.json` in the container, read and written atomically.     |
| `Tools/jsc-harness/`                                    | A CLI that runs the bundle in a real `JSContext`. The equivalence gate.                          |
| `Resources/yomitan-core.js`                             | **Generated** (`npm run build:native-core`), gitignored. Minified by default.                    |

## The build

`build-safari.sh` does all of it:

1. `dev/bin/build-native-core.js` rolls the engine into `yomitan-core.js` (JavaScriptCore has no
   module loader, so the import graph has to be flattened) and drops it in the web-extension
   directory, from where `safari-web-extension-converter --copy-resources` picks it up.
2. The converter regenerates the Xcode project — **with `--force`, so it overwrites everything**.
3. The post-processing step copies `Sources/YomitanNative/*.swift` into the generated extension
   target and registers the extra files in `project.pbxproj`.

The consequence worth internalising: **never edit anything under `builds/yomitan-safari-app/`.** It
is regenerated on every build. Edit the sources here.

`libsqlite3` and `JavaScriptCore` are both system frameworks and are autolinked by `import`, so
there is no build-phase change to maintain.

The bundle is **minified by default**, so that the artifact `npm run test:jsc` exercises is the one
that ships — building it two different ways would defeat the point of the gate. It also buys back
cold start, which is paid every time the app extension is reclaimed
([plan/README.md](../plan/README.md#the-numbers-once) has the sizes and timings; they are not
repeated here). `--no-minify` gives a readable bundle for debugging in the harness.

## Testing

```sh
npm run test:jsc          # the equivalence gate: node vs. JavaScriptCore, same compiled database
npm run test:unit         # vitest, including the host shims and the protocol encoders
npm test                  # the whole gate (lint, types, vitest, build); test:jsc is NOT in it
```

`test:jsc` builds the bundle, builds the harness with `swiftc`, compiles the fixture dictionary with
the real importer, and then answers the same requests through both hosts, requiring identical
answers. It is what catches the failures vitest structurally cannot: a bundle that will not evaluate
in JSC, a missing platform shim, and a SQLite binding that returns a BLOB as a string or an integer
as a float.

## Installing a dictionary

```sh
npm run compile:dictionary -- kty-de-en.zip --out dictionaries.sqlite3
```

Then stream it into the container with `DictionaryDatabaseNative.installDatabase()` — which is what
the settings page's dictionary import does. The transfer is staged and the file's header and schema
version are checked before the live database is replaced, so an interrupted install cannot leave the
user without their dictionaries.

The version it checks against is `DictionaryStore.expectedSchemaVersion`, a Swift literal mirroring
`DICTIONARY_SQLITE_SCHEMA_VERSION` because a host cannot import the JS constant.
`test/native-host-shims.test.js` reads the literal out of this source and asserts the two match: a
schema bump that missed it would leave the installer rejecting every valid database.
