# Yomitan

This extension supports scanning live text in images, the native OCR model for macOS. However, extensions cannot run in local files, so you will need a web based image viewer for local files. See [https://github.com/uAIex/image-viewer](https://github.com/uAIex/image-viewer)

## Building

1. Install [Node.js](https://nodejs.org/) and [npm](https://www.npmjs.com/).
2. Run `npm ci`.
3. Run `npm run license-report:html`.
4. Run `npm run build`.
5. Build output is written to `builds/`.

## Safari on macOS

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
