# DEV notes

## Measuring dictionary storage for real

```sh
npm run measure:storage            # payload codec ratios + decode cost on the real kty-de-en
npm run measure:storage -- --db    # ...plus a true SQLite database size and per-lookup timing
```

Downloads the real `kty-de-en` (~24 MB, checksum-pinned, cached in the gitignored `dictionaries/`).
Worth knowing before optimising anything: the fixture dictionary and synthetic corpora predict real
ratios badly, and this script is what found the 75 ms full table scan on every lookup. Current
numbers: **~150 MB** total with deflate, of which **78.1 MB is indexes + row overhead that no codec
touches**. See [plan/history/zstd.md](plan/history/zstd.md).

Note that this script's `rest` column is **not** "indexes" — it is indexes _plus_ the terms table's
own non-payload bytes, and it is not stable across codecs (page fill differs). For a real per-index
breakdown use `dbstat`, which is compiled into `@sqlite.org/sqlite-wasm`:

```sql
SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;
```

[plan/history/sizing.md](plan/history/sizing.md) has the full bottom-up budget — including that 26.5 MB
of the index is degenerate and droppable, and that 90% of `kty-de-en`'s rows are inflected-form stubs
costing 60.5 MB of the 71.5 MB payload.

## Running tests in real Safari without stealing focus

```sh
npm run test:safari     # SQLite/OPFS dictionary backend, in real Safari, backgrounded
```

`open -g -a Safari <url>` loads a page in the **real** browser but, thanks to `-g`, never brings
it to the foreground — so an automated run doesn't interrupt you. Pair it with a loopback HTTP
server that serves the harness and collects results via `fetch('/results')`, and you have a
headless-ish Safari runner:

```sh
open -g -a Safari "http://127.0.0.1:8730/"   # real Safari, no focus change
```

`127.0.0.1` is a **secure context**, so OPFS works with no COOP/COEP and no HTTPS (see the
Tailscale section below for why that matters off-localhost).

Why not the obvious alternatives:

- **`safaridriver`** (WebDriver, built into macOS) has **no headless mode** — every session opens
  a focus-stealing automation window. It also needs `safaridriver --enable` plus _Develop → Allow
  Remote Automation_.
- **Playwright's `webkit`** is genuinely headless, but it is a WebKit build from trunk, not the
  Safari your users run. Fine for engine smoke tests; not evidence about Safari itself.

Caveats: background tabs get their timers throttled (harmless for WASM/promise-driven work, but
don't build timing assertions on it), and each run leaves a tab open. See
[test/safari/README.md](test/safari/README.md).

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
