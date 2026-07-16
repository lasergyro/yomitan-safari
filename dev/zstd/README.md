# zstd + ZDICT WASM build

Builds the WebAssembly module behind `ext/js/dictionary/zstd-payload-codec.js`.

```sh
npm run build:zstd      # needs emscripten: brew install emscripten
```

**You almost never need to run this.** The output (`dev/vendor/zstd/zstd.js`) is committed, and
`npm run build:libs` just copies it into `ext/lib/`. Re-run it only to upgrade zstd or change build
flags — then commit the result.

## Why a custom build

No published zstd WASM package exposes **`ZDICT_trainFromBuffer`**, the dictionary _trainer_.
`@bokuweb/zstd-wasm` and `zstd-codec` both offer compression with a _pre-existing_ dictionary but
contain no `ZDICT_*` symbols at all. Training is the entire point here: on real dictionary data an
untrained dictionary reaches ~2.8× where a trained one reaches ~5.5×.

## Files

- `build.sh` — downloads the official zstd release tarball, verifies its sha256 (refusing to build
  on a mismatch), compiles it with emscripten, and writes `dev/vendor/zstd/zstd.js`.
- `shim.c` — a thin C shim (`yz_*`) over zstd + ZDICT. It exists so every exported entry point is
  **32-bit clean**: zstd returns `size_t`/`unsigned long long`, which would otherwise reach JS as
  BigInt through emscripten's i64 legalization. It also reuses the CCtx/DCtx across calls and turns
  zstd's error sentinels into plain negative returns.
- `.build/` — gitignored cache of the downloaded tarball and extracted source.

The build is `-sSINGLE_FILE=1`, so the wasm is embedded as base64 in the .js: no binary in git, no
sibling-`.wasm` path resolution, and no dependence on Safari serving `application/wasm` correctly.

Background and measurements: [../../plan/zstd/README.md](../../plan/zstd/README.md).
