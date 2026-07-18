# Task: zstd payload codec with a trained dictionary

**Status: BUILT, MEASURED, REJECTED — and REMOVED. `deflate` ships instead**
([../decisions.md](../decisions.md) #26). This file is kept as the record of _why_, so nobody
has to rediscover it.

The custom WASM build worked and passed node + real Safari end-to-end. Measured against the real
`kty-de-en` (`npm run measure:storage`) it still lost: the design's **5.52× / ~46 MB does not
reproduce**; with the plan's own parameters zstd is _worse_ than deflate; and sized properly it saves
~13 MB on a ~150 MB database, for a custom emscripten toolchain, ~24 MB of RAM, and import buffering
that does not exist. **78.1 MB of the database is indexes + row overhead that no codec touches**, so
compression was never going to reach the ~100 MB target anyway. (That 78.1 is 49.5 MB of index and
28.5 MB of table row overhead — this doc originally credited all of it to indexes; see
[sizing.md](sizing.md).)

The code is deleted rather than left dormant — it is in git history at **`58fe1f50`**
(`ext/js/dictionary/zstd-payload-codec.js`, `dev/zstd/`, `types/ext/zstd.d.ts`), and the `codec`
column keeps the decision reversible. The exercise still paid for itself: it found a **75 ms full
table scan on every lookup** ([../progress.md](../progress.md) → "Query plans"), which mattered
far more than any codec.

It was meant to be the final compression step of the storage refactor — the codec plugged into the
`PayloadCodec` seam ([../design.md](../design.md) → Payload codec). Everything below is written as it
was at the time of the evaluation; **none of the zstd code is in the tree any more**.

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
standard toolchain. See [../decisions.md](../decisions.md) #3.

## What was built

### 1. The WASM module — was `dev/zstd/`, `npm run build:zstd`

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

**The script was committed; the output was not.** `dev/vendor/` is gitignored just like `ext/lib/`, and
`npm run build:libs` copies the built module to `ext/lib/zstd.js`. So a fresh clone must run
`npm run build:zstd` once (needs `brew install emscripten`) before the zstd tests, the type-checks
that touch them, or a build. There is no CI to serve, so a locally cached build is enough. See
[../decisions.md](../decisions.md) #21.

### 2. The codec — `ext/js/dictionary/zstd-payload-codec.js`

`ZstdPayloadCodec` implements the existing `PayloadCodec` interface. The module is injected
(node tests pass the `dev/vendor` build; the extension self-loads `ext/lib/zstd.js`), mirroring
sqlite3/pako — [../decisions.md](../decisions.md) #10. `CDict`/`DDict` are compiled once per
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

`npm run measure:storage` — 947,070 term rows, **253.9 MB** of payload, avg **268 B/row**. (The row
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

| Trained dictionary                            |     Ratio |     Payload |
| --------------------------------------------- | --------: | ----------: |
| 110 KB cap, 1k samples — **production today** |     3.05× |     83.3 MB |
| 110 KB cap, 4k samples                        |     3.15× |     80.6 MB |
| 110 KB cap, 100k samples                      |     3.15× |     80.6 MB |
| 512 KB cap, 50k samples                       |     3.20× |     79.2 MB |
| 1 MB cap, 100k samples                        |     3.36× |     75.5 MB |
| **2 MB cap → 1.9 MB dict, 200k samples**      | **4.63×** | **54.9 MB** |
| 4 MB cap → 3.0 MB dict, 400k samples          |     4.34× |     58.5 MB |
| 8 MB cap → 3.7 MB dict, 900k samples          |     4.23× |     60.1 MB |

The peak is a **~2 MB dictionary**; past that it regresses, so this is not a "bigger is always
better" knob — 4 MB and 8 MB are both worse than 2 MB.

Three things fall out of this:

1. **Dictionary capacity is the whole lever; training-sample count alone does nothing.** 4k vs 100k
   samples at a 110 KB cap are byte-for-byte identical (3.15×). Sample count only matters because
   ZDICT needs roughly 100× the dictionary size in samples before it can fill a larger one.
2. **Properly sized, zstd does beat deflate** — 54.9 MB vs 71.5 MB, 23% smaller — but at ~4.6×, not
   5.5×. Returns go negative past ~2 MB of dictionary.
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

### Decode: a bigger dictionary is free; zstd is faster, but it does not matter

The worry worth checking was slower lookups — `decode` runs inside every query, and saving 15 MB is
not worth a visibly slower popup. Neither codec is a problem (see
[Does any of this affect the UI?](#does-any-of-this-affect-the-ui) — the per-lookup difference is
tens of microseconds), but the relative numbers are still informative:

- **zstd decodes ~8× faster than deflate** — 2.7 vs 21.4 µs/row on the full corpus — and lands within
  1 µs/row of storing raw uncompressed JSON (1.7 µs). It also encodes ~13× faster (26 vs 2 MB/s),
  which _is_ user-visible: it is the difference between a 47 s and a 166 s import.
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

## The whole database, not just the payload (`measure:zstd -- --db`)

Payload ratios flatter every codec, because the payload is not the whole file. Importing all 947,070
rows through the real backend (`page_count * page_size`, after `finalizeImport`):

| Codec                                                           |     Total DB | payload | trained dict | rest (indexes, keys, row overhead) |
| --------------------------------------------------------------- | -----------: | ------: | -----------: | ---------------------------------: |
| identity (JSON)                                                 |     345.2 MB |   253.9 |            — |                            91.2 MB |
| **deflate + 32 KB**                                             | **149.7 MB** |    71.5 |            — |                            78.1 MB |
| zstd, **as production trains today** (1 KB batch → 0.3 MB dict) |     161.3 MB |    82.4 |       0.3 MB |                            78.6 MB |
| zstd, 1.9 MB dict (projected¹)                                  |      ~137 MB |    56.8 |       1.9 MB |                           ~78.6 MB |

¹ payload and dict measured, `rest` taken from the run above — not yet a single end-to-end run,
because reaching a 1.9 MB dictionary needs the import buffering that does not exist yet.

This reframes the whole codec argument:

- **`rest` is ~78 MB and does not compress.** Indexes, keys and row overhead are over half the
  database once the payload is squeezed. So the payload win of 71.5 → 56.8 MB (−15) only moves the
  total 149.7 → ~137 MB (**−8%**). (`rest` is **49.5 MB of index + 28.5 MB of table row overhead** —
  see [sizing.md](sizing.md) §1. Note it is not even a stable quantity: 91.2 MB
  under identity vs 78.1 under deflate for the same rows, because it absorbs page-fill differences.
  `dbstat` is the right tool.)
- **Nothing reaches the ~100 MB target**, and no codec can: even a _free, perfect_ codec (payload → 0)
  would land at ~78 MB, and deflate is already within 70 MB of that floor. If ~100 MB matters, the
  next work is the schema, not the codec — and **~26.5 MB of that 78 is degenerate index**, 17.0 MB
  of which is now simply dropped ([../decisions.md](../decisions.md) #28).
- **The real win is already banked**: ~1.2 GB → ~150 MB with deflate. zstd's extra 13 MB is ~1% of
  the original problem.

## Does any of this affect the UI?

**No — and the thing that did was not the codec.** Per-lookup cost after the index fix
([../decisions.md](../decisions.md) #27), on the full 947k-row dictionary:

| Codec    | SQL      | decode/row | lookup total |
| -------- | -------- | ---------- | ------------ |
| identity | ~0.04 ms | 1.7 µs     | ~0.05 ms     |
| deflate  | ~0.04 ms | 21.4 µs    | ~0.06 ms     |
| zstd     | ~0.04 ms | 2.7 µs     | ~0.05 ms     |

A lookup decodes a handful of rows, so the codec contributes tens of microseconds — three orders of
magnitude below a 16 ms frame. **Decode speed is not a reason to choose either codec.** (The earlier
"deflate taxes every query" framing overstated it: 20 µs/row is real but invisible.)

What _did_ threaten the UI was a full table scan on every lookup — 75 ms — caused by the query
planner, not compression. Measuring the real dictionary is what exposed it; see
[../progress.md](../progress.md) → "Query plans".

## RAM

- **zstd costs ~24 MB of WASM heap** in the DB worker, measured after a full import. Of that,
  **16.1 MB is emscripten's default initial heap** — present before any dictionary is loaded, and
  tunable with `-sINITIAL_MEMORY` (the module grows on demand anyway). The trained dictionary and the
  CDict/DDict account for the rest.
- **deflate costs essentially nothing**: pure JS, a 32 KB dictionary, no WASM heap.
- **Caveat for a big dictionary**: training copies the samples into the WASM heap, so a 1.9 MB
  dictionary (~200k rows ≈ 54 MB of samples) makes the heap grow to at least that during import —
  and `WebAssembly.Memory` **cannot shrink**, so it stays that large for the life of the worker
  unless training happens in a module instance that is then discarded. Unmeasured; it matters on iOS,
  where extension memory limits are real.

## Where this leaves the decision

**On the measured evidence, deflate is the better engineering choice.** That reverses what the
payload table alone suggests:

| Option                           | Total DB     | Lookup   | RAM     | Cost                                |
| -------------------------------- | ------------ | -------- | ------- | ----------------------------------- |
| identity                         | 345.2 MB     | ~0.05 ms | —       | none                                |
| **deflate + 32 KB**              | **149.7 MB** | ~0.06 ms | ~0      | none — pure JS                      |
| zstd, as production trains today | 161.3 MB     | ~0.05 ms | ~24 MB  | WASM build (**worse than deflate**) |
| zstd, 1.9 MB dict (projected)    | ~137 MB      | ~0.05 ms | ~24 MB+ | WASM build + import buffering       |

1. **The margin is 8%, not 25%.** Against the whole database, zstd's best case saves ~13 MB on
   ~150 MB — about 1% of the original 1.2 GB problem. The 78.1 MB of index + row overhead, which no
   codec touches, is the larger half now.
2. **Its decode advantage is irrelevant.** ~8× faster, but both are tens of microseconds per
   lookup — invisible.
3. **Its costs are real**: a custom emscripten toolchain to maintain, ~24 MB of WASM heap in the DB
   worker (a live concern on iOS), and import buffering that does not exist yet. **Shipped as-is
   today zstd is simply worse than deflate** (161.3 vs 149.7 MB), because it can only train on 1,000
   rows.

zstd becomes the right answer if the ~100 MB target is reinstated _and_ the index overhead is
attacked too, at which point 13 MB is a meaningful share of what remains. It is built, tested, and
ready behind the codec registry for that day.

The `--train`/`--dict-cap`/`--level` knobs exist so this can be re-derived rather than argued.

Still open, and deliberately not decided here:

1. **Select a codec** in `ext/js/dictionary/dictionary-database-factory.js` — it still constructs the
   backend with the default identity codec. `new DictionaryDatabaseSqlite(new DeflatePayloadCodec(pako))`
   is the recommendation above; either way pass the other codec in `decodeCodecs` so earlier imports
   stay readable.
2. **If zstd is ever chosen**: buffer enough rows to train on (raise `trainSampleSize` _and_ give the
   trainer more than one `bulkAdd` batch), lower `-sINITIAL_MEMORY`, and check the training heap
   spike on iOS.
3. **Attack the 78.1 MB of `rest`** if ~100 MB is a real target — that is where the remaining weight
   is, and no codec reaches it. **Now analysed in full: [sizing.md](sizing.md).**
   26.5 MB of it is degenerate index (17.0 MB now dropped, schema v2), and the real prize is bigger than
   `rest` — 90% of the rows are inflected-form stubs costing 60.5 MB of the 71.5 MB payload.
4. **Reclaim the ~10 B/row zstd frame overhead** (`ZSTD_f_zstd1_magicless`, dictID/content-size flags
   off) — worth ~9 MB, only relevant if zstd is chosen.

Either way the choice is reversible: the `codec` column makes rows self-describing, so new imports
take whichever codec is selected while old rows keep decoding through the registry.
