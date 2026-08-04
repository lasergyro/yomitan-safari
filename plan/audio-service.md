# Audio as a native service

Audio production — resolving a term to candidate sources, and downloading the bytes (for playback and
for Anki media) — runs in the native engine, not the extension. This is stage N4 of
[native-rewrite.md](native-rewrite.md), and it is shaped by a direction that reaches past Safari:
**the native app is to serve more than the browser extension** — a game overlay, perhaps a desktop
overlay. So the fetch-and-scrape work is built as a service any client can call, with playback left
to each client, rather than as something bolted to the extension. **TTS is the exception and stays in
the browser** (`speechSynthesis`): the extension already has the same system voices a native render
would use, so routing it native and back would be pure overhead — native TTS earns its place only for
a future client that has no browser at all (see "Sources, quality, and latency").

## What moved, and what did not

| Concern                                                   | Runs where                    | Why                                                                                         |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Resolve sources → candidate URLs (`getTermAudioInfoList`) | **engine**                    | network + HTML scrape; no DOM needed once `SimpleDOMParser` (parse5) is used                |
| Download bytes (`downloadTermAudio`)                      | **engine**                    | network; returns `{data(base64), contentType}`                                              |
| Fetch playback bytes (`getAudioUrlBytes`)                 | **engine**                    | the overlay cannot fetch the URL itself (below); host fetch, base64 back                    |
| Playback (`HTMLAudioElement` over a blob)                 | extension (display)           | needs the DOM; client-specific by nature                                                    |
| TTS                                                       | extension (`speechSynthesis`) | **stays browser-side by design** — same system voices; native only for a non-browser client |
| Note field-building                                       | extension (display)           | DOM-bound (`anki-template-renderer.js`); stays by the rule display always does              |

The two production paths were separate before (`getTermAudioInfoList` for playback,
`downloadTermAudio` for Anki media) and both moved together. Playback stays where the client is: the
Safari extension keeps `HTMLAudioElement`; a future non-browser client would play through its own
stack. That split — produce natively, play per-client — is the whole design.

### Playback must fetch its bytes natively too — the overlay cannot fetch cross-origin

Playback originally pointed `new Audio()` straight at the resolved remote URL, and the browser
fetched it. That works on the search page and the popup window (top-level extension pages) but
**fails silently in the in-page overlay**, which is an extension-origin iframe embedded in a
third-party page: Safari partitions/blocks a cross-origin media load from that frame, so the audio
never plays and the click appears to hang. So playback now downloads through the host as well —
`getAudioUrlBytes(url)` runs one anonymous `host.fetch` and returns the bytes base64, and the display
plays them from a **same-origin `blob:` URL** (which needs `blob:` in the extension `media-src` CSP;
`media-src *` does not cover `blob:`). The `HTMLAudioElement` and its jpod101 duration check are
unchanged — only the source of the bytes moved from the network to a blob. `getAudioUrlBytes` opens
no database and is `prepare`-exempt like the other two audio actions.

## How it runs: upstream code, native platform

The engine hosts upstream `AudioDownloader` **unmodified** (route C — the same bet the dictionary
engine makes: re-host the churning upstream JS rather than fork it). What it needs that bare
JavaScriptCore lacks is supplied around it:

- **`host.fetch` — synchronous and blocking.** The engine runs on one queue that the host holds
  until a call settles; there is no async-I/O path (the async surface is microtask-only). A blocking
  `URLSession`-over-semaphore fetch fits that exactly, and needs no change to the pump loop. This is
  also why an async `fetch` was _not_ chosen — it would force the harder redesign for no gain at
  audio's byte sizes.
- **Web-platform shims** ([`native-web-shims.js`](../ext/js/native/native-web-shims.js)): `URL`,
  `URLSearchParams`, `crypto.subtle.digest`, `AbortController`, `btoa`/`atob`. The two that are easy
  to get subtly wrong — relative-URL resolution and SHA-256 — delegate to native code correct by
  construction (`host.resolveUrl` via Foundation, `host.sha256` via CryptoKit). Each installs only
  if absent, so node keeps its real ones and the gate compares shim against genuine article.
- **`NativeRequestBuilder`/`NativeResponse`**: the `RequestBuilder` surface the downloader calls,
  over `host.fetch` instead of the browser's `fetch` + `declarativeNetRequest` header dance. The
  native fetch is anonymous by default (ephemeral, cookieless session), so there are no dynamic
  rules to add and remove.

Transport is base64 bytes in `downloadTermAudio`'s reply. Audio is tens-to-hundreds of KB — the
bridge round-trips 4 MB comfortably — so it needs none of the chunking a database install does, and
no media-server or local-URL machinery (that concern was raised for dictionary _images_, not audio).

## The gate

`npm run test:jsc` answers `getTermAudioInfoList` (a query built with no network — tests the
`URLSearchParams` shim), `downloadTermAudio` (fetch → `crypto.subtle.digest` → `btoa`) and
`getAudioUrlBytes` (host fetch → base64, the playback path) through both hosts against a shared
**fetch fixture**, so nothing hits the network and node's real URL/crypto/base64 must equal the JSC
shims. A divergence in any shim shows up there.

## Sources, quality, and latency — the open question

The shipped dictionary is **German** (`kty-de-en`), so this is a German audio question, not the
Japanese one upstream's examples assume. And the framing that matters most turns out to be **where
TTS runs**, not whether to add it.

### The source is already the user's choice

Nothing needs building for "let the user pick online vs TTS": Yomitan's **Audio → Audio sources** is
an add/remove/**reorder** list, and the order _is_ the preference — the display walks the sources
top-down and plays the first that answers (`display-audio.js` → `_onOptionsUpdated` reads
`audio.sources`). `text-to-speech` is one of those sources, with its own voice picker; a user can put
it first, put an online source first, or mix, and per word a shift-click menu plays a specific source
and "set primary" pins one. So the work here is not a mechanism — it is a good **default order** for
German and making sure each source is worth offering.

### TTS is rendered natively, because Safari's `speechSynthesis` exposes only one voice

The empirical question above is **answered, and it flips the earlier conclusion**. On this Mac
Safari's `speechSynthesis.getVoices()` returns **only `Anna`** — not the eight other installed German
voices, and, when a downloaded Enhanced/Premium voice was added, not that either, even after a
restart. So the extension genuinely **cannot reach the good voices through Web Speech**, and "TTS
stays in the browser, native buys nothing" is wrong: keeping playback on `speechSynthesis` locks the
user to `Anna`.

So the native app gains a **TTS endpoint**, and the display uses it when a `text-to-speech*` source is
selected:

- **`ttsVoices`** (host action) — `AVSpeechSynthesisVoice.speechVoices()` mapped to
  `{id, name, language, quality}`, so the settings voice picker offers the **full** installed set
  (all 180, with the Enhanced/Premium tier) instead of Safari's one.
- **`ttsSynthesize`** (host action) — `{text, voice, language}` → `AVSpeechSynthesizer` **offline
  render** to a 16-bit-PCM WAV, returned base64, which the display plays from the same `blob:` URL
  path `getAudioUrlBytes` already uses. Verified: `Schützen` renders to a 22 050 Hz mono WAV in ~0.5 s.

This is a **host action, not an engine action** — `AVSpeechSynthesizer` is AVFoundation, not
JavaScript, so it lives in the Swift router beside `ankiRequest`, not in the JSC engine. Two
implementation facts pin the design: `AVSpeechSynthesizer.write` delivers its buffers on the **main
run loop** (a background `DispatchQueue` never receives them — measured), so synthesis runs on the
appex **main queue**, which also means it does **not** block the engine queue's lookups; and offline
`write` is **macOS 10.15+**, so it is `@available`-guarded with the browser `speechSynthesis` path
kept as the fallback for the 10.14 floor (the same floor that forced `CommonCrypto` over CryptoKit).
The bytes are small (tens of KB), so no chunking — like `downloadTermAudio`.

### Enhanced/Premium voices: available, but downloaded, and absent by default

Measured on this dev Mac (2026-07-26) via `AVSpeechSynthesisVoice.speechVoices()`: **180 system
voices, every one `quality=default`** — nothing enhanced or premium is installed. The nine German
`de-DE` voices are `Anna` (`com.apple.voice.compact.de-DE.Anna`) plus eight
`com.apple.eloquence.de-DE.*` (`Eddy`, `Flo`, `Grandma`, `Grandpa`, `Reed`, `Rocko`, `Sandy`,
`Shelley` — the deliberately retro Eloquence set, low quality). So **out of the box the German TTS on
offer is poor**, which matters for any "TTS as a good default" claim.

macOS _does_ offer Enhanced and Premium (neural) German voices, but the user must **download** them
(System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…); their ids then
become `com.apple.voice.enhanced.*` / `com.apple.voice.premium.*`. The practical consequences:

- The extension can only offer what is installed, and `speechSynthesis.getVoices()` reflects that — so
  a good German TTS experience depends on the user having downloaded a good voice, which the settings
  UI should probably **prompt for** rather than assume.
- Whether a _downloaded_ Enhanced/Premium voice then shows up in Safari's `getVoices()` is the
  empirical question above; the compact/Eloquence voices measured here do, but that says nothing about
  the premium tier.

### The sources, and how their quality ranks — for German

- **Recorded audio.** For German the usable recorded sources are `language-pod-101` (GermanPod101),
  `lingua-libre` and `wiktionary` — **not** `jpod101`/`jisho`, which are Japanese-only. A human
  recording is the most natural option where it exists, but German coverage across these is spottier
  than Japanese jpod101, and a miss costs a network round trip to discover.
- **German TTS is well-suited — _with a good voice_.** German is largely phonetic with regular
  stress and **none of the pitch-accent subtlety** that holds synthetic Japanese back, so a neural
  German voice is close to parity with a recording for a single word. The catch is the voice: out of
  the box macOS has only the compact `Anna` and the retro Eloquence set (measured below), which are
  poor; a good result needs a **downloaded Enhanced/Premium** voice. So "TTS as the default" is
  reasonable _once a decent voice is installed_, with recorded audio a per-word bonus — but the
  default-voice quality, and whether Safari exposes the better ones, is exactly what has to be checked
  before committing to it.

A rough naturalness ranking for German, **to confirm by an actual listening test in Safari, not
assert** (the localhost driver in [DEV.md](../DEV.md) → _Driving the installed extension_ makes that
a real check, not a guess): _recorded human_ ≳ _neural German system voice (Enhanced/Premium)_ ≈
_Safari `speechSynthesis` (same voices)_ > _compact `Anna`_.

### Latency, measured

The user reports "a few seconds" from click to sound. A direct measurement of the online leg says the
network is **not** where those seconds go. `assets.languagepod101.com/dictionary/japanese/audiomp3.php`
for 打つ/うつ, from this dev machine, 2026-07-26 (a dev network, not a user's device):

| leg                                                                                             | time                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| request to the `audiomp3.php` **301 redirect**                                                  | ~0.60–0.71 s TTFB                        |
| full request **following** the redirect to the CDN (`cdn.innovativelanguage.com/.../80061.mp3`) | ~0.62–0.77 s total, 1920 B, `audio/mpeg` |

So the recorded-audio fetch itself is **sub-second** (one RTT for the redirect, one for the CDN;
`URLSession` follows the redirect for us). The multi-second delay is therefore mostly **elsewhere**,
and two contributors are already identified:

1. **The overlay's failed browser fetch.** Before the `getAudioUrlBytes` fix above, the overlay tried
   to `new Audio(remoteUrl)`, which Safari blocks in an embedded extension iframe — the click hangs on
   a load that never succeeds, then falls through to the fallback sound. This alone can read as "a few
   seconds of nothing". Fixing playback to use native bytes should collapse the common case toward the
   ~0.7 s the fetch actually costs.
2. **`host.fetch` blocks the engine queue.** The fetch is synchronous on the one serialized engine
   queue (why it was chosen — it fits the pump model), so a ~0.7 s audio download **also stalls any
   lookup** issued during it. On the interaction path that is felt as latency on the _next_ hover, not
   just on the audio.

The `1920 B` clip is small enough to be suspect — it may be jpod101's invalid-audio placeholder
rather than a real recording (the code already guards this by `audio.duration`); confirming that is
part of the measurement below, because "the source returned instantly but with nothing" is a
different problem from "the source is slow".

### Reducing the delay

In rough order of payoff, none yet built:

- **Prefetch on display, not on click.** Resolve and download the primary source when the entry
  renders, so the bytes are cached before the user clicks. Auto-play already primes the first entry;
  this extends the same idea to prime the click path, moving the ~0.7 s off the interaction entirely.
- **A content-addressed byte cache in the host** (the `resolveAudio`/`getAudioBytes` shape already
  sketched under "Not yet"): a repeat play, an Anki export of a term just heard, and prefetch-then-click
  all become a cache hit. Keyed by the resolved URL (or term+source), it also lets playback and the
  Anki download share one fetch instead of two.
- **TTS is already the fast path — in the browser.** For the extension there is nothing to build:
  `speechSynthesis` is local and instant, so preferring a German `speechSynthesis` voice when a
  recorded source is absent or slow removes the network from the common case entirely, with no bridge
  round trip. (Native `AVSpeechSynthesizer` buys nothing here; it is only for a non-browser client.)
- **Don't let the download stall lookups.** If prefetch and cache do not make this moot, the blocking
  `host.fetch` is the argument for an async-fetch path after all (the redesign audio-service.md
  currently declines) — but only if measurement shows lookups actually contending with downloads.

### How to measure it, repeatably

So a claim about latency is a number, not a feeling. A test-case harness (extend `test:jsc` or a
small standalone driver) timing, for a fixed term per source:

1. `getTermAudioInfoList` — resolution time (URL-only for jpod101; a real HTML scrape for jisho/
   wiktionary, which is a separate cost worth isolating).
2. `getAudioUrlBytes` — the fetch, and the returned byte count and content type (to catch the
   placeholder case).
3. time-to-first-sample for a local TTS render of the same term, as the comparison floor.

Report the three legs separately so the redirect, the scrape, and the decode are not blurred into one
"audio is slow". The online numbers above are the first row of that table; TTS and the scrape-heavy
sources are not yet filled in.

## Open: the pop-up view still has no audio

Reported after this session's build, and the **starting point for the next one**: audio plays on the
**search page** but **not in the in-page pop-up**. The observation was that the search page "works but
appears to still use the old system" — i.e. it may be playing the remote URL directly
(`new Audio(url)`), which a top-level extension page is allowed to do, while the pop-up needs the
`getAudioUrlBytes` → blob path this session added (and the native TTS path) and something in it is not
taking effect there.

What is already ruled in and out:

- **The native seams work.** `test:safari:e2e` is 6/6 through the installed appex — `getAudioUrlBytes`,
  `getTextToSpeechVoices`/`getTextToSpeechAudio` all answer. So the gap is **display-side, and specific
  to the pop-up**, not the host.
- **The CSP is in place.** The installed appex manifest ships `media-src * blob:` (verified), so a
  `blob:` audio element should be allowed in an extension-origin frame.

Where to look next:

- Confirm which path each context actually runs. Does the pop-up reach
  `display-audio.js` → `_createAudioFromInfo` → `_getPlayableAudioUrl` / `_createTtsAudio` at all, or
  fail earlier (the `api` call not resolving in the pop-up frame, or `AudioSystem.createAudio`'s
  `loadeddata` never firing for the blob)? And is the **search page bypassing** the blob path (still
  `new Audio(remoteUrl)`), which would explain "works but old system"?
- The pop-up and the search page are **different `Display`/`DisplayAudio` instances**; confirm both run
  the rebuilt code and that the audio options (sources) reached the pop-up instance.
- Whether the pop-up document actually inherits the extension `media-src` (it is an extension-origin
  iframe, but verify) and that `URL.createObjectURL` + `new Audio('blob:…')` is not blocked there.

## Not yet, and deliberately

- **Native TTS** (`AVSpeechSynthesizer`, offline-rendered) is not built. `text-to-speech*` resolve in
  the engine to a `{type:'tts', …}` **descriptor** (no bytes), which the browser speaks — so routing
  the synthesis native and back would usually be pure overhead. It is worth building for a
  **non-browser client** (no `speechSynthesis` at all), and _possibly_ for the extension too **if**
  Safari's `speechSynthesis` turns out not to expose the good Enhanced/Premium voices that
  `AVSpeechSynthesizer` can reach — the open question under "Sources, quality, and latency". Not a
  settled "buys nothing".
- **`custom-json`** resolves to nothing natively: its schema fetch wants a `chrome.runtime` the
  engine does not have, and shimming a `chrome` object into a non-extension process was not worth it
  for one source. It degrades to "no audio", not an error.
- **A content-addressed cache and a token surface** (`resolveAudio`/`getAudioBytes` with a native
  `playAudio` for headless clients) are the shape the multi-client vision wants, but not built:
  naming a token API before the cache exists would mislead. `getTermAudioInfoList`/`downloadTermAudio`
  keep their current semantics until then.
- **`_injectAnkiNoteMedia`** still orchestrates in the extension; its audio leg already calls the
  native `downloadTermAudio`, and its screenshot/clipboard legs need the extension anyway.
