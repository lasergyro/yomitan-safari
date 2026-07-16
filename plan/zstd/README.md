# Task: zstd payload codec with a trained dictionary

**Status: NOT STARTED.** Blocked on producing a zstd WASM build (needs an emscripten + zstd source
toolchain). Everything else it plugs into is done and tested.

This is the final compression step of the storage refactor ([../01-design.md](../01-design.md) §4,
§6, §8.2). The backend, the codec seam, and an interim `deflate` codec already ship; this task
replaces the codec with zstd + a per-dictionary trained dictionary to hit the size target.

## Why

Measured on `kty-de-en` (983,520 term rows, payload ≈ 253 MB of compact JSON), compressing each row
independently so rows stay randomly decodable:

| Method                                        |     Ratio | Payload result |
| --------------------------------------------- | --------: | -------------- |
| per-row deflate, no dictionary                |     2.24× | 113 MB         |
| **per-row deflate + 32 KB preset dict** (now) | **3.55×** | ~71 MB         |
| per-row zstd −19, no dictionary               |     2.09× | —              |
| per-row zstd −19 + **raw** 112 KB dict        |     2.82× | —              |
| **per-row zstd −19 + ZDICT-trained dict**     | **5.52×** | **~46 MB**     |
| whole-corpus gzip (not random-access; floor)  |    ~12.8× | —              |

Two conclusions drive this task: a **shared dictionary is mandatory** (per-row compression of small
payloads is otherwise net-negative), and **training matters** — a raw/untrained dictionary only
reaches 2.82× where a ZDICT-trained one reaches 5.52×. That is the difference between ~71 MB and
~46 MB of payload, and it is the last big lever on the 1.2 GB → ~100 MB goal.

## Why not sqlite-zstd

`sqlite-zstd` is a Rust **loadable extension**. SQLite-WASM cannot load extensions dynamically (they
must be statically compiled in, which is bleeding-edge for Rust), and there is no WASM build. We do
app-level compression of the single heavy column instead, which reaches the same result with a
standard toolchain. See [../02-decisions.md](../02-decisions.md) #3.

## What to build

### 1. The WASM module

A zstd build exposing, at minimum:

- `ZDICT_trainFromBuffer(dictBuffer, dictBufferCapacity, samplesBuffer, samplesSizes, nbSamples)` —
  the training entry point. **This is the piece off-the-shelf zstd WASM packages usually omit**, and
  the reason a custom build is needed.
- `ZSTD_compress_usingCDict` / `ZSTD_decompress_usingDDict` (plus `ZSTD_createCDict` /
  `ZSTD_createDDict`), so the trained dictionary is loaded once and reused for every row rather than
  re-parsed per call.
- `ZSTD_compressBound`, `ZSTD_isError`, `ZSTD_getErrorName` for buffer sizing and diagnostics.

Build notes:

- Vendor it the same way as sqlite: emit an ESM `.js` + `.wasm` pair and copy them into `ext/lib/`
  from `dev/build-libs.js` (see `copySqlite`). `ext/lib/*` is gitignored and generated at build.
- If the file is copied verbatim rather than esbuild-bundled, prepend `// @ts-nocheck` — the tsc
  project graph reaches it through the codec's import (this bit `copySqlite`; see
  [../03-progress.md](../03-progress.md)).
- Safari serves extension `.wasm` without the `application/wasm` MIME, so `instantiateStreaming`
  fails and the loader must fall back to `ArrayBuffer` instantiation. sqlite's loader already does
  this; make sure the zstd loader does too.
- The Safari extension CSP is `script-src 'self' 'wasm-unsafe-eval'` — already set.

### 2. The codec

Implement `ZstdPayloadCodec` against the existing `PayloadCodec` interface
(`types/ext/payload-codec.d.ts`). **Use `ext/js/dictionary/deflate-payload-codec.js` as the
template** — it is the same shape, already wired, and already tested:

```js
name: 'zstd'                                     // already in PayloadCodecName
train(payloadSamples: unknown[][]): Promise<Uint8Array>   // -> ZDICT_trainFromBuffer, ~112 KB
encode(payload: unknown[], dictionary: ?Uint8Array): Uint8Array
decode(blob: Uint8Array, dictionary: ?Uint8Array): unknown[]
```

Inject the zstd module through the constructor exactly as `DeflatePayloadCodec` takes `pako`, so
node tests and the browser use the same class (see [../02-decisions.md](../02-decisions.md) #10).
Cache the `CDict`/`DDict` per dictionary-bytes rather than rebuilding per row.

### 3. Wiring (already built — just select it)

None of the plumbing needs changing. It already:

- stores the codec name per dictionary in `dictionaries.codec` and the trained dictionary in
  `dictionaries.codec_dict`, so rows are **self-describing** and old rows keep decoding;
- trains once per dictionary from the first term batch, before the insert transaction, because
  `train()` is async (`_ensureWriteCodecs` in `dictionary-database-sqlite.js`);
- selects the decode codec from a registry by the row's codec name.

To ship it: construct the backend with `new ZstdPayloadCodec(zstd)` as the write codec (and pass
the deflate/identity codecs as `decodeCodecs` so existing imports still read), in
`ext/js/dictionary/dictionary-database-factory.js`.

## Acceptance criteria

1. `npm test` — add `test/zstd-payload-codec.test.js` mirroring `test/deflate-payload-codec.test.js`
   (round-trip every payload shape ± a trained dict, empty glossary, structured content, `null`
   definitionTags, missing termTags; assert compression beats identity; assert the dict size cap).
2. `test/translator-sqlite.test.js` — add `'sqlite-zstd'` to the backend loop so all 49 translator
   fixtures pass end-to-end through zstd, matching the canonical expected results.
3. `npm run test:safari` — the real-Safari runner must stay green with zstd selected (this is what
   catches WASM/OPFS problems node cannot see; it already caught one).
4. **Measure on real data**: import `kty-de-en` and record the actual OPFS size against the ~46 MB
   payload / ~100 MB total target. Write the number back into this file and
   [../01-design.md](../01-design.md) §4 — the size claim is currently unverified in-tree.

## Fallback if the build proves impractical

The shipped `deflate` codec (3.55×) is a legitimate stopping point — it is pure JS, has no WASM
build step, and is already green everywhere. The `codec` column means a later zstd rollout does not
invalidate existing imports: new imports simply get `codec = 'zstd'`, and old `deflate` rows keep
decoding through the registry. So this task can be deferred without blocking the Stage 5 flip.
