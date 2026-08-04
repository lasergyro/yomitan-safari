# DEV notes

> **Heads-up on direction.** The dictionary engine no longer runs in the extension — it runs in the
> Safari app extension, in JavaScriptCore, over system `libsqlite3`. See
> [native/README.md](native/README.md), [plan/native-rewrite.md](plan/native-rewrite.md), and
> [plan/history/safari-opfs-blocker.md](plan/history/safari-opfs-blocker.md) for why. The OPFS notes below are kept
> for the secure-context facts, which still matter for anything else that wants OPFS.

## Measuring dictionary storage for real

```sh
npm run measure:storage            # payload codec ratios + decode cost on the real kty-de-en
npm run measure:storage -- --db    # ...plus a true SQLite database size and per-lookup timing
```

Downloads the real `kty-de-en` (~24 MB, checksum-pinned, cached in the gitignored `dictionaries/`).
Worth knowing before optimising anything: the fixture dictionary and synthetic corpora predict real
ratios badly, and this script is what found the 75 ms full table scan on every lookup.

**Do not read this script's totals as the shipped database size.** It mirrors the importer's packing
rather than running it, so its figures are terms-only and understated, and it measures the database
_before_ the inflection drop: it reports **~150 MB** with deflate, of which **78.1 MB is indexes +
row overhead that no codec touches**. What actually ships is **49.4 MB**, measured through the real
`DictionaryImporter` — the table in
[plan/README.md](plan/README.md#the-numbers-once) is the one to quote. Why the harness understates:
[plan/decisions.md](plan/decisions.md) #35. Why compression was the wrong lever:
[plan/history/zstd.md](plan/history/zstd.md).

Note that this script's `rest` column is **not** "indexes" — it is indexes _plus_ the terms table's
own non-payload bytes, and it is not stable across codecs (page fill differs). For a real per-index
breakdown use `dbstat`, which is compiled into `@sqlite.org/sqlite-wasm`:

```sql
SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;
```

[plan/history/sizing.md](plan/history/sizing.md) has the full bottom-up budget — including that 90%
of `kty-de-en`'s rows are inflected-form stubs costing 60.5 MB of the 71.5 MB payload, which is what
the inflection scheme went after. It also reports 26.5 MB of degenerate index; **~8.5 MB of that was
fiction** — the partial predicate it assumed excluded no rows, because the importer rewrites an empty
reading to the expression ([plan/decisions.md](plan/decisions.md) #35). What shipped instead is
`reading <> expression` (#36), which does empty the index on a German dictionary.

`--db` runs the real importer headless in node, which is where
[dev/bin/compile-dictionary.js](dev/bin/compile-dictionary.js) came from. That script is now the
supported build artifact (`npm run compile:dictionary`); this one stays a measurement tool, and it
reports sizes from `page_count * page_size` rather than writing a file.

## The native engine

The dictionary engine runs in the Safari **app extension**, not in the browser — see
[native/README.md](native/README.md) for the layout and [plan/native-rewrite.md](plan/native-rewrite.md)
for why. Day-to-day:

```sh
./rebuild-safari.sh                 # extension + app, signed and reinstalled into Safari
npm run test:jsc                    # node vs. JavaScriptCore on the same compiled database
npm run compile:dictionary -- kty-de-en.zip --out dictionaries.sqlite3
```

Two things that will otherwise cost an afternoon:

- **Never edit anything under `builds/yomitan-safari-app/`.** `safari-web-extension-converter` is run
  with `--force` on every build and regenerates the whole project. The Swift sources live in
  `native/Sources/YomitanNative/` and are copied in, with the extra files registered in
  `project.pbxproj`, by `build-safari.sh`.
- **`npm run test:jsc` is not covered by `npm test`.** It needs `swiftc`, so it is a separate
  command — but it is the only thing that catches a bundle that will not evaluate in JavaScriptCore,
  a missing platform shim, or a SQLite binding that marshals a value differently from the WASM build.
  Run it after touching anything under `ext/js/native/`, `ext/js/dictionary/sqlite/`, or
  `native/Sources/`.

`rebuild-safari.sh` updates the installed bundle **in place** rather than replacing it, because
removing the app makes Safari treat the extension as uninstalled — which drops its enablement and
host permissions, both of which are manual to restore (see below). It does not put the dictionary at
risk either way: that lives in the app container, keyed by bundle id, not in the extension's website
data.

There used to be a `npm run test:safari` here, which ran the OPFS backend in real Safari over a
loopback server. It went with the OPFS backend. What replaces it is `test:jsc` for the engine, plus
the manual end-to-end check below.

### Seeding a dictionary into the container (`SEED_DICTIONARY`)

Importing a real dictionary (kty-de-en is ~49 MB) through the settings page on every rebuild is
tedious. This build-flag does it for you — it writes the two files an import-and-enable would have
produced, straight into the app container, as if the dictionary had been downloaded and activated:

```sh
SEED_DICTIONARY=~/dicts/kty-de-en.zip SEED_LANGUAGE=de ./rebuild-safari.sh
```

The input may be a `.zip` (compiled on the fly with `compile:dictionary`) or an already-compiled
`.sqlite3`. `SEED_LANGUAGE` also sets each profile's scanning language, so a German dictionary is
usable without a trip to the settings page. Under the hood it is
[dev/bin/seed-dictionary.js](dev/bin/seed-dictionary.js), which can be run on its own:

```sh
node dev/bin/seed-dictionary.js kty-de-en.zip --language de   # write into the container
node dev/bin/seed-dictionary.js kty-de-en.zip --print         # print options.json, touch nothing
```

It merges into the container's existing `options.json` when there is one (so it does not clobber
other settings) and generates a default otherwise, using the same `OptionsUtil` the extension does,
so the version and shape are what the extension expects to read back. `rebuild-safari.sh` runs it
while Safari is quit, so the app extension reads the seeded files when it relaunches. On a
**first-ever** install the container does not exist yet — open Safari once (which creates it), then
re-run. The dictionary title it registers is read from the compiled database through the same engine
node runs in `test:jsc`, so it matches what lookups key off.

### Driving the installed extension

`open -g -a Safari <url>` loads a page in the **real** browser but, thanks to `-g`, never brings it
to the foreground — so an automated run doesn't interrupt you. Pair it with AppleScript's
`do JavaScript "<expr>" in <tab>` (target the tab by URL substring — see the inspection section
below) and you can synthesize a scan and read back whether Yomitan's popup
(`iframe.yomitan-popup`, injected after a scan) appeared with a definition. That popup's `src` is
`safari-web-extension://<UUID>/…`, which also _discovers the extension origin at runtime_, so the
extension's own `search.html` can then be driven for a clean lookup.

The other way to a driveable page at the extension origin, when no page has been scanned yet, is the
background page's own console. It is the only way in from cold, because `open -a Safari
"safari-web-extension://…"` is rejected by LaunchServices and AppleScript's `set URL of tab` refuses
the scheme:

1. **Develop → Web Extension Background Content → Yomitan → Personal** opens a Web Inspector on the
   background page. Beware: AX reports _stale, duplicated_ positions for the repeated "Personal" rows
   in that submenu, so clicking `menu item i` lands on the wrong extension. Derive the row's y from
   the first row's y plus the uniform 24 pt row pitch and `click at {x, y}`.
2. In that console, evaluate `chrome.tabs.create({url:'search.html'})`. **Paste** it (`pbcopy`, then
   ⌘V) rather than `keystroke` it — the console auto-closes brackets and quotes, which mangles typed
   input.
3. That tab's URL carries the current origin UUID, and `do JavaScript … in <tab>` can drive it
   normally from there.

The residual manual gate is not the automation — it is **Apple's security model**: the extension has
to be _enabled and granted host permission_ in Safari Settings → Extensions once (a deliberate
manual step; do not synthesize those clicks). Both survive a rebuild, which is why
`rebuild-safari.sh` updates the bundle in place.

One-time enablement, if `do JavaScript` returns nothing: **Develop → Developer Settings… → Allow
JavaScript from Apple Events** must be on (Safari's prefs are sandboxed, so `defaults write
com.apple.Safari` fails — toggle it in the UI or via System Events, see below). The terminal also
needs macOS Automation permission for Safari.

Why not the obvious alternatives for browser automation: **`safaridriver`** (WebDriver, built into
macOS) has **no headless mode** — every session opens a focus-stealing automation window; and
**Playwright's `webkit`** is genuinely headless but is a WebKit build from trunk, not the Safari your
users run. Fine for engine smoke tests; not evidence about Safari itself.

### Checking the installed extension end to end

vitest and `test:jsc` both run the engine **outside Safari**, so neither can see the extension talking
to its own app extension. This is the only check that covers that seam. It is manual on purpose — a
single lookup after a change to the bridge, not something worth a runner.

Get a driveable `search.html` at the extension origin by either route above. Then, with `kty-de-en`
installed, put an **inflected** form into `#search-textbox`, click `#search-button`, and read back the
entry headwords: **`geschützt` must yield `schützen`.**

That one lookup covers the whole seam — the host answers under the bundle id `native-host-ids.js`
derives, the database read is the one in the app container, the translator ran natively, and, because
`geschützt`'s own row is dropped at compile time and rebuilt from the induced rules, inflection
synthesis survived the round trip. **The failure shape to watch for is an empty result with no
error**, not an exception: the encoders in `native-protocol.js` exist precisely because a `Map`, `Set`
or `RegExp` that reaches `JSON.stringify` unencoded stringifies to `{}`, and the lookup then quietly
returns nothing.

**Options now cross the same bridge** (`optionsLoad`/`optionsSave` → `options.json` in the container).
Neither vitest nor `test:jsc` can see that seam either. To check it: open the settings page, change a
visible setting, **quit and relaunch Safari**, and confirm the change stuck — that proves the write
reached the container and the next launch read it back, not `chrome.storage.local`. On the very first
launch after this change lands, existing settings should be **preserved**, not reset: `optionsLoad`
returns nothing, the extension migrates the legacy `chrome.storage.local` copy once, and the following
save writes it into the container.

### Automated end-to-end check (`npm run test:safari:e2e`)

The manual pass above depends on a scriptable entry into the extension, which Safari does not give us:
the `safari-web-extension://` origin rotates every launch and there is no cold way in (a synthesized
scan needs the content script already granted on some page and the popup only reveals the origin, not
a driveable page). So instead of reaching **into** the extension, the extension reaches **out**.

`dev/bin/test-safari-e2e.js` serves a loopback HTTP endpoint on `127.0.0.1`, opens it as a background
tab with `open -g` (no focus steal, an ordinary http origin so none of the scheme/seed problems
apply), and a **build-gated content-script bridge** (`ext/js/native/loopback-test-bridge.js`, injected
only on `127.0.0.1`/`localhost`, and only when the build was made with `YOMITAN_TEST_BRIDGE=1`) runs
in the extension's isolated world, long-polls the runner for `{action, params}` commands, and relays
each to the background service worker — the same `chrome.runtime` message surface the real UI uses.
The service worker does the native round trip; the answer comes back over the socket. This is the one
layer vitest and `test:jsc` cannot reach, because both run the engine outside Safari.

```sh
YOMITAN_TEST_BRIDGE=1 ./rebuild-safari.sh                     # once: build+install with the bridge
npm run compile:dictionary -- dictionaries/kty-de-en.zip --out /tmp/kty.sqlite3
npm run test:safari:e2e -- --database /tmp/kty.sqlite3        # install, drive, assert, restore
```

It installs the compiled database (backing up whatever was there), then asserts four seams in order:
the appex answers and reads the database (`getDictionaryInfo`); a settings write crosses the bridge
into `options.json` (registering the dictionary — the options-save seam, [plan/decisions.md](plan/decisions.md) #52);
a real lookup deinflects natively (**`geschützt` → `schützen`**, the same assertion as the manual
recipe); and native TTS answers (`getTextToSpeechVoices` returns the full installed set — 183 on this
machine, where Safari's `speechSynthesis` shows one — and `getTextToSpeechAudio` renders a WAV clip).
It restores the options and database it found on the way in (`KEEP=1` to leave them). The
bridge **never ships**: a normal `./rebuild-safari.sh` omits the content-script entry entirely, so the
installed extension you use day to day has no loopback code in it. Rebuild without the flag to remove
it.

The residual manual gate is unchanged and is Apple's, not the harness's: the extension must be
**enabled and granted host permission** once in Safari Settings → Extensions (do not synthesize those
clicks), and **Allow JavaScript from Apple Events** is not needed here at all — this path uses no
`do JavaScript`.

## Automated Safari inspection (macOS)

How to drive a real, logged-in Safari from the shell to inspect a live page's
rendered DOM and hit-testing. This is how the `allango.net` react-pdf
non-selectable-text bug was diagnosed.

### Why: `source of document` is not enough

For single-page apps, AppleScript's `source of document` returns only the
initial HTML shell (e.g. `<div id="root"></div>`), not the rendered DOM. To see
what the user actually sees, you must execute JavaScript in the page and read
back `document.documentElement.outerHTML` (or query it directly).

### One-time setup: allow JavaScript from Apple Events

`do JavaScript` fails until this is enabled. In current Safari it is **not** a
direct Develop-menu item anymore — it lives under **Develop → Developer
Settings…** as the checkbox _Allow JavaScript from Apple Events_.

Enable it via UI scripting (requires the automation/accessibility permission):

```sh
osascript <<'EOF'
tell application "System Events"
  tell process "Safari"
    tell menu bar item "Develop" of menu bar 1
      click
      click menu item "Developer Settings…" of menu 1
    end tell
  end tell
end tell
delay 1
tell application "System Events"
  tell process "Safari"
    repeat with w in windows
      repeat with g1 in groups of w
        repeat with g2 in groups of g1
          try
            set b to (first checkbox of g2 whose name is "Allow JavaScript from Apple Events")
            if (value of b) is 0 then click b
          end try
        end repeat
      end repeat
    end repeat
  end tell
end tell
EOF
```

Close the settings sheet afterward (click its **Done** button). This is a
persistent Safari setting — consider turning it back off when finished.

### Run JS reliably: pass code as an argument, don't inline it

Escaping quotes inside `osascript -e "... do JavaScript \"...\" ..."` is a
nightmare and silently truncates. Instead, write the JS to a file and pass it as
an argument to a small AppleScript that takes `{js}`:

`run.applescript`:

```applescript
on run {js}
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t contains "allango.net" then
          return do JavaScript js in t
        end if
      end repeat
    end repeat
  end tell
  return "target tab not found"
end run
```

```sh
JSCODE=$(cat probe.js)
osascript run.applescript "$JSCODE"
```

The JS should be an IIFE that `return`s a string. Wrap the body in
`try { ... } catch(e){ return 'ERR: '+e.message+' @ '+e.stack; }` — otherwise a
thrown error just yields empty output with no hint why.

### Target the right tab explicitly — `document 1` is a moving target

`document 1` / `current tab` changes whenever the user (or your own
`activate`/UI scripting) switches tabs, and it silently ran JS against
`teams.cloud.microsoft` mid-session once. Always iterate `windows` → `tabs` and
match by URL substring (see `run.applescript` above).

### Foreground the tab before hit-testing

**Background tabs give unreliable / zeroed layout.** `getBoundingClientRect`,
`elementFromPoint`, `elementsFromPoint`, and `caretRangeFromPoint` returned
nothing useful until the target tab was made frontmost. Same probe: 0 hits in
the background, 10/20 hits once foregrounded. Activate first:

```applescript
tell application "Safari"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "allango.net" then
        set current tab of w to t
        set index of w to 1
        return "activated"
      end if
    end repeat
  end repeat
end tell
```

### Keep the display awake during test runs

Automatic display sleep interferes with foreground-dependent hit-testing (the
tab effectively stops being "visible"). Prevent it for the duration of a run:

```sh
caffeinate -d osascript run.applescript "$JSCODE"   # -d = prevent display sleep
# or hold it awake for a whole session in the background:
caffeinate -d -t 3600 &
```

## Serving local test pages to iOS Safari over Tailscale (HTTPS)

Some web APIs — notably **OPFS** (`navigator.storage.getDirectory`,
`createSyncAccessHandle`) — require a **secure context**. Only `https://` and
`http://localhost` / `http://127.0.0.1` qualify. A plain `http://` URL to a LAN
or Tailscale IP is **not** secure, so OPFS/SQLite-WASM silently becomes
unavailable there. To test such pages on a real iPhone you therefore need HTTPS
with a trusted cert.

The `manual-test/` pages are served over plain HTTP on `127.0.0.1` (see
`manual-test/serve.sh`). To reach them from an iPhone with a trusted cert, front
that local server with `tailscale serve`:

1. **One-time:** enable HTTPS certificates for the tailnet at
   <https://login.tailscale.com/admin/dns> → **HTTPS Certificates → Enable**
   (MagicDNS must be on). Without this, `tailscale cert` / `tailscale serve`
   fail with _"your Tailscale account does not support getting TLS certs"_.

2. Start the local HTTP server, then proxy it over HTTPS on the tailnet:

   ```sh
   ./manual-test/serve.sh &                 # http://127.0.0.1:8723
   tailscale serve --bg 8723                # https://<host>.<tailnet>.ts.net/ -> :8723
   tailscale serve status                   # confirm the mapping
   ```

3. Open `https://<host>.<tailnet>.ts.net/<path>` on the iPhone (Tailscale on).
   iOS resolves the MagicDNS name and trusts the `*.ts.net` cert automatically,
   giving a secure context.

4. Tear it down when finished:

   ```sh
   tailscale serve --https=443 off
   ```

Notes:

- The Mac's own `curl` may fail to resolve its `*.ts.net` name (local resolver
  quirk) even though iOS resolves it fine. Validate the proxy locally by forcing
  the IP: `curl --resolve host.tailnet.ts.net:443:<tailscale-ip> https://host.tailnet.ts.net/...`.
- iOS OPFS quota is generous in practice (~38 GB observed on iOS 26), not the
  oft-cited ~1 GB WebView cap. Confirm per-device with `navigator.storage.estimate()`.

### Hit-testing gotchas found on this page

- Under **pinch-zoom / CSS transforms**, a text span's `getBoundingClientRect`
  center does not necessarily sit over that span. Don't trust a span rect as a
  probe point; instead sample a grid over the page and let `elementsFromPoint`
  tell you the real stack.
- `elementsFromPoint` returns the full z-ordered stack (dedupe it — it can
  contain duplicates). Use it to discover occluding overlays.
- A full-page `<canvas>` overlay (here Konva.js `.konvajs-content`) with a
  transparent CSS background sits above real text and swallows all pointer/caret
  hit-testing, even though it has no text of its own. `user-select: none` on the
  text does **not** block Safari's `caretRangeFromPoint` — disabling
  `pointer-events` on the transparent overlays is enough to reach the text
  underneath. This is exactly what Yomitan's `_caretRangeFromPointExt` does.
