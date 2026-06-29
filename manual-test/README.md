# Manual test pages

Static HTML pages for manually exercising the Safari inline popup against
scenarios that are awkward to cover with automated tests (frame layout, popup
sizing/positioning, scroll behavior). The sample text is German, since German
declension produces long, ambiguous results that stress the popup layout.

Safari **disables web extensions on `file://` URLs**, so the pages must be
served over HTTP to be scannable.

## Usage

```sh
./manual-test/serve.sh
```

Then open in Safari (with inline scanning enabled):

- <http://127.0.0.1:8723/test-plain.html> — single document, no frames.
- <http://127.0.0.1:8723/test-iframe.html> — page with an embedded `iframe`
  pinned bottom-right.

Use a custom port with `PORT=9000 ./manual-test/serve.sh`.

## What each page checks

| Page                 | Scenario                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-plain.html`    | Single document. Scan a word in the fixed bottom-right box; the popup should keep its configured width/height while scrolling.                                          |
| `test-iframe.html`   | Scan in the main text (popup over the page), then inside the green bottom-right `iframe` — the popup should render over the **root** page, not be clipped to the frame. |
| `frame-content.html` | Loaded inside the iframe of `test-iframe.html`; not opened directly.                                                                                                    |

## Notes

- These are manual fixtures: they are not part of `npm test` and are not built
  into the extension.
- If scanning does nothing, check Safari → Settings → Extensions → Yomitan and
  allow the extension on `127.0.0.1`.
