# DEV notes

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
