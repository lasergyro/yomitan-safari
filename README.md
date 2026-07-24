# Yomitan

This extension supports scanning live text in images, the native OCR model for macOS. However, extensions cannot run in local files, so you will need a web based image viewer for local files. See [https://github.com/uAIex/image-viewer](https://github.com/uAIex/image-viewer)

## Building

1. Install [Node.js](https://nodejs.org/) and [npm](https://www.npmjs.com/).
2. Run `npm ci`.
3. Run `npm run license-report:html`.
4. Run `npm run build`.
5. Build output is written to `builds/`.

Step 4 is a prerequisite for the Safari build below, not an alternative to it: it generates
`ext/lib/`, which is gitignored and which `build-safari.sh` copies verbatim. Running only
`build-safari.sh` on a fresh clone produces an extension with an empty `lib/`.

## Safari on macOS

The dictionary engine on this fork does not run in the browser — it runs in the native app extension,
in JavaScriptCore, over the system SQLite. `build-safari.sh` builds both halves. See
[`native/README.md`](native/README.md) for what that means and
[`plan/`](plan/) for why.

Run:

```sh
./build-safari.sh --version 26.2.17.0
```

This generates:

- `builds/yomitan-safari-web-extension`
- `builds/yomitan-safari-app`

Open the generated Xcode project:

- `builds/yomitan-safari-app/Yomitan Safari/Yomitan Safari.xcodeproj`

In Xcode:

1. Select the `Yomitan Safari` scheme.
2. Set the destination to `My Mac`.
3. In Signing & Capabilities, set the same Developer Team on both `Yomitan Safari` and `Yomitan Safari Extension`.
4. Build and run the app.
5. If needed, you can run without enabling developer mode by signing both targets and using the signed app directly.

`./rebuild-safari.sh` does all of the above unattended — build, sign with a free Personal Team, and
reinstall into `/Applications` — once the Xcode setup above has been done once.

## Dictionaries

**This build does not import Yomitan `.zip` archives.** Dictionaries are compiled to SQLite once, on
the command line, and the settings page installs the compiled file into the app container:

```sh
npm run compile:dictionary -- kty-de-en.zip jmdict.zip --out dictionaries.sqlite3
```

Then open the extension's settings, go to Dictionaries, and import `dictionaries.sqlite3`.

The compiled file **is** the dictionary store, so installing one replaces everything previously
installed — pass every archive you want in one command, as above. Compiling does the work an
in-browser import used to do on every user's machine (unzip, compress, induce inflection rules,
`VACUUM`), which is what takes `kty-de-en` from ~700 MB of IndexedDB to 49.4 MB and its install from
~152 s to a file copy. See [`plan/native-protocol.md`](plan/native-protocol.md) → Non-goals.

Two settings affordances still offer `.zip` archives — "Check for Updates" and the recommended
dictionaries list — and they fail at install with a message saying so.

## Scanning

- On Safari for macOS, inline auto-scanning is tracked per domain.
- Use the toolbar popup toggle to enable or disable inline auto-scanning for the current domain.
- On Safari for macOS, Live Text in images is supported when you select the text with the mouse.

## Manual test pages

The [`manual-test/`](manual-test/) folder contains static HTML pages for manually
exercising the Safari inline popup (frame layout, popup sizing, scroll behavior).
Safari disables extensions on `file://` URLs, so serve them over HTTP:

```sh
./manual-test/serve.sh
```

Then open <http://127.0.0.1:8723/test-iframe.html> or
<http://127.0.0.1:8723/test-plain.html> in Safari. See
[`manual-test/README.md`](manual-test/README.md) for details.

## Development notes

See [`DEV.md`](DEV.md) for development learnings, including how to drive a real
logged-in Safari from the shell to inspect a live page's rendered DOM and
hit-testing (used to diagnose page-specific scanning bugs).
