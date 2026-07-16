# Task: zstd payload codec with a trained dictionary

**Status: BUILT AND TESTED, NOT SELECTED. The design's headline number does not reproduce.** The
custom WASM build exists, the codec ships, and it passes node + real-Safari end-to-end. It has now
been measured against the real `kty-de-en` dictionary (`npm run measure:zstd`), and that measurement
changes the picture — see [Measured on real data](#measured-on-real-data-kty-de-en).

This is the final compression step of the storage refactor ([../01-design.md](../01-design.md) §4,
§6, §8.2). The backend, the codec seam, and an interim `deflate` codec already shipped; this task
added zstd + a per-dictionary trained dictionary.

## Why (the original claim)

Measured on `kty-de-en` (983,520 term rows, payload ≈ 253 MB of compact JSON), compressing each row
independently so rows stay randomly decodable:

| Method                                       |     Ratio | Payload result |
| -------------------------------------------- | --------: | -------------- |
| per-row deflate, no dictionary               |     2.24× | 113 MB         |
| **per-row deflate + 32 KB preset dict**      | **3.55×** | ~71 MB         |
| per-row zstd −19, no dictionary              |     2.09× | —              |
| per-row zstd −19 + **raw** 112 KB dict       |     2.82× | —              |
| **per-row zstd −19 + ZDICT-trained dict**    | **5.52×** | **~46 MB**     |
| whole-corpus gzip (not random-access; floor) |    ~12.8× | —              |

Two conclusions drove this task: a **shared dictionary is mandatory** (per-row compression of small
payloads is otherwise net-negative), and **training matters** — a raw/untrained dictionary only
reaches 2.82× where a ZDICT-trained one reaches 5.52×.

> The dictionary-is-mandatory conclusion holds. **The 5.52× / ~46 MB does not** — see below. Treat
> this table as the original hypothesis, not as results.

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
- **`-sSINGLE_FILE=1`**: the wasm is embedded inside the .js. One artifact, no sibling-`.wasm` path
  resolution, and it sidesteps the Safari `.wasm` MIME problem entirely (no `instantiateStreaming`
  fallback needed). ArrayBuffer instantiation is allowed by the extension CSP's
  `'wasm-unsafe-eval'`. Cost is ~8%: 502 KB, vs 464 KB (10 KB glue + 454 KB wasm) split.

**The script is committed; the output is not.** `dev/vendor/` is gitignored just like `ext/lib/`, and
`npm run build:libs` copies the built module to `ext/lib/zstd.js`. So a fresh clone must run
`npm run build:zstd` once (needs `brew install emscripten`) before the zstd tests, the type-checks
that touch them, or a build. There is no CI to serve, so a locally cached build is enough. See
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

## Measured on real data (`kty-de-en`)

`npm run measure:zstd` — 947,070 term rows, **253.9 MB** of payload, avg **268 B/row**. (The row
count differs from the design's 983,520 because this is a later release of the dictionary; the
payload size matches almost exactly.)

**Confidence check: deflate reproduces the design's 3.55× to the decimal**, on the same payload size,
which says the methodology matches. That makes the zstd rows below meaningful rather than a setup
difference.

| Method                                              |     Ratio |     Payload | Encode   | Decode          |
| --------------------------------------------------- | --------: | ----------: | -------- | --------------- |
| identity (JSON)                                     |     1.00× |    253.9 MB | 263 MB/s | 1.7 µs/row      |
| **deflate + 32 KB preset** _(design: 3.55×)_        | **3.55×** | **71.5 MB** | 2 MB/s   | **21.4 µs/row** |
| zstd −3 + trained 110 KB dict                       |     2.98× |     85.1 MB | 104 MB/s | —               |
| zstd −12 + trained 110 KB dict                      |     3.10× |     82.0 MB | 31 MB/s  | —               |
| zstd −15 + trained 110 KB dict                      |     3.14× |     80.9 MB | 11 MB/s  | —               |
| zstd −19 + trained 110 KB dict **← plan's params**  |     3.15× |     80.6 MB | 5 MB/s   | —               |
| **zstd −15 + trained 1.9 MB dict** _(200k samples)_ | **4.47×** | **56.8 MB** | 26 MB/s  | **2.7 µs/row**  |
| zstd −19 + trained 1.9 MB dict _(200k samples)_     |     4.63× |     54.9 MB | ~5 MB/s  | —               |

**The design's 5.52× / ~46 MB does not reproduce. With the plan's own parameters zstd _loses_ to
deflate** (3.15× vs 3.55×). The parameters are the reason, not zstd: a **110 KB dictionary is far too
small for a 254 MB corpus**. Sweeping the dictionary capacity (all at −19, full corpus):

| Trained dictionary                       |     Ratio |     Payload |
| ---------------------------------------- | --------: | ----------: |
| 110 KB cap, 4k training samples          |     3.15× |     80.6 MB |
| 110 KB cap, 100k training samples        |     3.15× |     80.6 MB |
| 1 MB cap, 100k samples                   |     3.36× |     75.5 MB |
| **4 MB cap → 3.0 MB dict, 400k samples** | **4.34×** | **58.5 MB** |
| 8 MB cap → 3.7 MB dict, 900k samples     |     4.23× |     60.1 MB |

Three things fall out of this:

1. **Dictionary capacity is the whole lever; training-sample count alone does nothing.** 4k vs 100k
   samples at a 110 KB cap are byte-for-byte identical (3.15×). Sample count only matters because
   ZDICT needs roughly 100× the dictionary size in samples before it can fill a larger one.
2. **Properly sized, zstd does beat deflate** — 58.5 MB vs 71.5 MB, 18% smaller — but at ~4.3×, not
   5.5×. Returns go negative past ~3 MB of dictionary.
3. **The gap at 110 KB is per-row framing.** zstd costs 85.1 B/row against deflate's 75.5 B/row, and
   ~10 B/row is exactly a zstd frame header (magic + FHD + dictID + content size + block header),
   which raw DEFLATE does not have. On 268 B rows that overhead is ~4% of the payload. It could be
   reclaimed with `ZSTD_f_zstd1_magicless` and disabling the dictID/content-size flags.

**Level: the ratio plateaus at −15** (−15 → 3.14×, −19 → 3.15×) while −19 costs ~2× the encode time.
At 268 B/row a longer match search has nothing extra to find, since the redundancy resolves against
the shared dictionary rather than within the row. The codec defaults to **level 15**.

### What it costs to train a bigger dictionary

`DictionaryImporter` calls `bulkAdd` in batches of `maxTransactionLength = 1000` and
`_ensureWriteCodecs` trains from the first batch, so **today the trainer sees 1,000 rows** (~268 KB
of samples) and the backend's old `_trainSampleSize = 4000` was unreachable. This is our own code in
a fork, so it is a tunable, not a wall — but ZDICT needs roughly **100× the dictionary size in
samples**, so a ~2 MB dictionary means buffering ~200k rows (~54 MB) before the first insert. That
buffering, not the dictionary, is the real cost. `trainSampleSize` is now a constructor option on
`DictionaryDatabaseSqlite`, and `ZstdPayloadCodec` takes `level`/`dictionaryCapacity`, so the
tradeoff is tunable rather than baked in.

### Decode: a bigger dictionary is free, and zstd is much faster than deflate

The thing that would sink this trade is slower lookups — `decode` runs inside every query, and saving
15 MB is not worth a visibly slower popup. It turns out to be the reverse of the worry:

- **zstd decodes ~8× faster than deflate** — 2.7 vs 21.4 µs/row on the full corpus — and lands within
  1 µs/row of storing raw uncompressed JSON (1.7 µs). It also encodes ~13× faster (26 vs 2 MB/s).
  On the axis that matters for queries, **deflate is the expensive option**, not zstd.
- **Dictionary size costs nothing on decode.** On a 60k-row subset (read the latencies, not the
  ratios): 110 KB → 8.3 µs/row, 512 KB → 7.7, 2 MB → 7.7, 4 MB → 8.3 — flat within noise. The `DDict`
  is parsed once at `prepare()` and cached, so per-row cost does not scale with it. The only prices
  of a big dictionary are the bytes themselves (one copy per dictionary in `codec_dict` — ~1.9 MB
  against a ~57 MB payload) and the import-time buffering above.
- Training the 1.9 MB dictionary took **4.9 s**, once per imported dictionary.

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

## Where this leaves the decision

Perspective first: the refactor's goal is ~1.2 GB → ~100 MB, and **every option below already
achieves the bulk of that**. The remaining argument is over ~17 MB of payload, so complexity and
query speed matter more than the last megabyte.

| Option                                        | Payload     | Decode         | Cost                                            |
| --------------------------------------------- | ----------- | -------------- | ----------------------------------------------- |
| identity (no compression)                     | 253.9 MB    | 1.7 µs/row     | none                                            |
| deflate + 32 KB (ships today, unselected)     | 71.5 MB     | 21.4 µs/row    | none — pure JS, no build step                   |
| zstd −15, 110 KB dict (plan's params)         | 80.9 MB     | ~8 µs/row      | WASM build                                      |
| **zstd −15, 1.9 MB dict, 200k train samples** | **56.8 MB** | **2.7 µs/row** | WASM build + buffering ~200k rows during import |

**zstd is better on every axis that matters** — 15 MB smaller than deflate _and_ ~8× faster to decode,
which is the query path — provided the dictionary is sized properly. Its costs are the WASM build
(done) and buffering a prefix of the import to train on. deflate's apparent simplicity is not free:
it is the slowest option to read.

The `--train`/`--dict-cap`/`--level` knobs exist so this can be re-derived rather than argued.

Still open, and deliberately not decided here:

1. **Select a codec** in `ext/js/dictionary/dictionary-database-factory.js` — it still constructs the
   backend with the default identity codec. Shipping zstd means
   `new DictionaryDatabaseSqlite(new ZstdPayloadCodec(zstd, {dictionaryCapacity}), [new DeflatePayloadCodec(pako)], {trainSampleSize})`,
   passing deflate as a decode codec so existing deflate imports stay readable.
2. **Buffer enough rows to train on** if zstd is chosen: raise `trainSampleSize` and give the trainer
   more than one `bulkAdd` batch. Without this, zstd trains on 1,000 rows and lands at 3.05× —
   _worse_ than deflate.
3. **Measure the real database size** (`npm run measure:zstd -- --db`) — payload ratios ignore the
   indexes, and the ~100 MB target is about the whole file.
4. **Reclaim the ~10 B/row frame overhead** (`ZSTD_f_zstd1_magicless`, dictID/content-size flags off)
   if the last few MB matter — worth ~9 MB on this corpus.

Either way the choice is reversible: the `codec` column makes rows self-describing, so new imports
take whichever codec is selected while old rows keep decoding through the registry.
