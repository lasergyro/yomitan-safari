# Task: zstd payload codec with a trained dictionary

**Status: BUILT AND TESTED, NOT SELECTED.** The custom WASM build exists, the codec ships, and it
passes node + real-Safari end-to-end. What remains is the _decision_ to ship it, which needs a
measurement on real data — see [What is left](#what-is-left).

This is the final compression step of the storage refactor ([../01-design.md](../01-design.md) §4,
§6, §8.2). The backend, the codec seam, and an interim `deflate` codec already shipped; this task
added zstd + a per-dictionary trained dictionary.

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

Two conclusions drove this task: a **shared dictionary is mandatory** (per-row compression of small
payloads is otherwise net-negative), and **training matters** — a raw/untrained dictionary only
reaches 2.82× where a ZDICT-trained one reaches 5.52×.

> **These numbers predate the implementation and have not been reproduced in-tree** — `kty-de-en` is
> not in the repo. Everything below that is measured was measured on a _synthetic_ corpus, and is
> labelled as such. Reproducing the table above on real data is the one remaining gate.

## Why not sqlite-zstd

`sqlite-zstd` is a Rust **loadable extension**. SQLite-WASM cannot load extensions dynamically (they
must be statically compiled in, which is bleeding-edge for Rust), and there is no WASM build. We do
app-level compression of the single heavy column instead, which reaches the same result with a
standard toolchain. See [../02-decisions.md](../02-decisions.md) #3.

## What was built

### 1. The WASM module — `dev/zstd/`, `npm run build:zstd`

The custom build was necessary as predicted: **no published zstd WASM package exposes
`ZDICT_trainFromBuffer`**. Verified before building — `@bokuweb/zstd-wasm` ships
`compress_using_dict`/`decompress_using_dict` (dictionary _use_) but its wasm contains no `ZDICT_*`
symbols at all; `zstd-codec` is the same story. Dictionary use is common; dictionary _training_ is
not, and training is where 2.82× becomes 5.52×.

- `dev/zstd/build.sh` downloads the **official zstd release tarball** (1.5.7), verifies its sha256
  (`eb33e51f…6fa3`) and refuses to build on a mismatch, then compiles it with emscripten.
- `dev/zstd/shim.c` is a thin C shim (`yz_*`). It exists so every entry point is **32-bit clean**:
  zstd returns `size_t`/`unsigned long long`, which would otherwise cross the JS boundary as
  BigInt via emscripten's i64 legalization. It also keeps the CCtx/DCtx reused rather than
  per-call, and turns zstd's error sentinels into plain negative returns.
- Build flags of note: `ZSTD_DISABLE_ASM=1` and excluding `huf_decompress_amd64.S` (x86-only asm),
  `ZSTD_MULTITHREAD=0`, `DYNAMIC_BMI2=0` (meaningless for wasm).
- **`-sSINGLE_FILE=1`**: the wasm is embedded as base64 in the .js. Costs ~33% size but means no
  binary blob in git, no sibling-`.wasm` path resolution, and it sidesteps the Safari `.wasm` MIME
  problem entirely (no `instantiateStreaming` fallback needed). ArrayBuffer instantiation is
  allowed by the extension CSP's `'wasm-unsafe-eval'`.

The output (`dev/vendor/zstd/zstd.js`, 492 KB) is **committed**, unlike the other vendored libs:
rebuilding needs emscripten + network, which the normal build and CI must not require.
`npm run build:libs` merely copies it to `ext/lib/zstd.js`. See
[../02-decisions.md](../02-decisions.md) #21.

### 2. The codec — `ext/js/dictionary/zstd-payload-codec.js`

`ZstdPayloadCodec` implements the existing `PayloadCodec` interface. The module is injected
(node tests pass the `dev/vendor` build; the extension self-loads `ext/lib/zstd.js`), mirroring
sqlite3/pako — [../02-decisions.md](../02-decisions.md) #10. `CDict`/`DDict` are compiled once per
distinct dictionary and cached in a `WeakMap`, never per row.

One interface change was needed: **`PayloadCodec.prepare?()`**, awaited by
`DictionaryDatabaseSqlite.prepare()` for every registered codec. `encode`/`decode` are synchronous
by contract (they sit inside sqlite's synchronous query/transaction paths) but loading a WASM module
is not — and a _read_ of already-imported rows never calls `train()`, so there is no other async
moment to initialize in.

### 3. Wiring — already existed, unchanged

Rows are self-describing (`dictionaries.codec` + `codec_dict`), training happens once per dictionary
before the insert transaction, and the decode codec is picked from a registry by name. None of it
needed changing to add zstd.

## Measured (synthetic corpus — indicative only)

20,000 unique generated rows averaging ~330 B, entropy tuned so neither codec can simply memorize the
corpus. **Not real dictionary data**: on this corpus `deflate + 32 KB` scores 6.29×, versus 3.55× on
real `kty-de-en` — so the corpus is still far more compressible than reality and these ratios must
not be quoted as results. The _shape_ of the findings is what matters:

| Method                      | Ratio | Encode   |
| --------------------------- | ----: | -------- |
| zstd −19, no dictionary     | 1.80× | —        |
| zstd −19 + raw 112 KB dict  | 5.31× | —        |
| zstd −19 + **trained** dict | 5.77× | 3 MB/s   |
| zstd −15 + trained dict     | 5.77× | 10 MB/s  |
| zstd −12 + trained dict     | 5.57× | 41 MB/s  |
| zstd −3 + trained dict      | 4.96× | 213 MB/s |

Both premises hold: a dictionary is worth ~3×, and **training beats a raw dictionary** (5.77 vs
5.31), reproducing the direction of the real-data table.

**The level sweep contradicts the plan's `−19`.** The ratio plateaus at 15 — levels 15, 19 and 22 are
identical while 19 is ~3× slower to encode (≈75 s vs ≈26 s for a 253 MB payload). That plateau should
be structural rather than an artifact of the corpus: at ~330 B/row a longer match search has nothing
extra to find, because essentially all redundancy resolves against the shared dictionary rather than
within the row, and real rows are the same order of size (253 MB / 983 k ≈ 257 B). **The codec
therefore defaults to level 15**, configurable via the constructor. Confirm on real data.

## Tests

- `test/zstd-payload-codec.test.js` (12) — round-trips every payload shape ± trained dict, the
  unprepared-use error, `prepare` idempotence, dictionary capacity, the empty-dictionary fallback,
  compression vs identity, and rejecting a non-zstd blob.
- `test/dictionary-database-sqlite-codec.test.js` — a 2,000-row zstd import asserting the trained
  dictionary is **persisted to `codec_dict` and read back through it** after the codec cache is
  dropped (the real cold-start path), plus a full round-trip of every row.
- `test/translator-sqlite.test.js` — all 49 translator fixtures now run through `sqlite-zstd` as well
  (147 tests = 49 × 3 backends), matching the canonical expected results. Note the test dictionary is
  far too small for ZDICT, so these runs exercise the **empty-dictionary fallback** — itself worth
  covering, since every small imported dictionary hits it in production.
- `npm run test:safari` — 17/17 in real Safari, including that the zstd module instantiates under
  WebKit + CSP, ZDICT trains there, and a trained dictionary survives close/reopen.

**The Safari runner caught a real bug again**, exactly the kind node cannot see: `decode` passed
`TextDecoder` a `subarray` **view** into the WASM heap, which WebKit rejects with a `TypeError`
while node accepts it. Fixed by copying out with `slice` first (as `train`/`encode` already did).

## What is left

1. **Measure on real data** — import `kty-de-en` and record the actual OPFS size against the ~46 MB
   payload / ~100 MB total target, at level 15 and 19. This is the last unverified claim in the whole
   refactor, and it also settles deflate-vs-zstd: the synthetic corpus cannot, because it flatters
   deflate (6.29× vs its real 3.55×).
2. **Select the codec** in `ext/js/dictionary/dictionary-database-factory.js`. It still constructs
   the backend with the default identity codec. Shipping zstd means
   `new DictionaryDatabaseSqlite(new ZstdPayloadCodec(), [new DeflatePayloadCodec(pako)])` — passing
   deflate as a decode codec so any existing deflate imports stay readable. Deliberately not done
   here: it is a Stage 5 shipping decision that depends on (1).
3. **Confirm the level** once (1) exists.

## Fallback if zstd is not shipped

The `deflate` codec (3.55×, pure JS, no build step) remains a legitimate stopping point. The `codec`
column means the choice is not permanent in either direction: new imports get whichever codec is
selected, and old rows keep decoding through the registry.
