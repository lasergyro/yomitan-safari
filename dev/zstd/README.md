# zstd + ZDICT WASM build

Builds the WebAssembly module behind `ext/js/dictionary/zstd-payload-codec.js`.

```sh
npm run build:zstd      # needs emscripten: brew install emscripten
```

**Run this once after cloning**, and again only to upgrade zstd or change build flags. The output
(`dev/vendor/zstd/zstd.js`) is gitignored and cached locally — this script is what's committed, not
its ~500 KB result — and `npm run build:libs` copies it into `ext/lib/`. Until it has been run, the
zstd tests fail with a message pointing back here.

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

The build is `-sSINGLE_FILE=1`, so the wasm is embedded in the .js: one artifact, no sibling-`.wasm`
path resolution, and no dependence on Safari serving `application/wasm` correctly. It costs ~8% over
a separate `.wasm`.

## Measuring against a real dictionary

```sh
npm run measure:zstd            # payload codec ratios on the real kty-de-en dictionary
npm run measure:zstd -- --db    # ...and import it into SQLite for a true database size
npm run measure:zstd -- --rows=20000   # a fast subset run
```

`measure.js` downloads `kty-de-en` (~24 MB, checksum-pinned) into the gitignored `dictionaries/` and
caches it. This is the only measurement that settles deflate-vs-zstd, and it already overturned the
design's headline number — full results and the reasoning live in
[../../plan/zstd/README.md](../../plan/zstd/README.md).

Useful knobs: `--train=N` (rows to train the dictionary on), `--dict-cap=BYTES`, `--level=N`,
`--rows=N`. Dictionary capacity is the dominant lever on ratio and costs nothing on decode, but a
larger dictionary is only trainable by buffering proportionally more of the import.

Background and measurements: [../../plan/zstd/README.md](../../plan/zstd/README.md).
