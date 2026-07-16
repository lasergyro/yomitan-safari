/*
 * Thin C shim over zstd + the ZDICT dictionary builder for the Yomitan payload codec.
 *
 * Everything here is deliberately 32-bit clean: zstd's own API returns `size_t`/`unsigned long long`
 * values that would force emscripten i64 legalization (BigInt at the JS boundary). Wrapping them
 * keeps the JS side plain numbers and hides CCtx/DCtx lifetime management.
 *
 * Errors are reported as negative return values so JS can branch on `< 0` without a separate
 * ZSTD_isError round-trip.
 */

#include <stddef.h>
#include <stdlib.h>

#include "zstd.h"
#include "zdict.h"

#define YZ_ERR -1

/* Reused across calls; zstd explicitly recommends recycling contexts rather than per-call create. */
static ZSTD_CCtx* g_cctx = NULL;
static ZSTD_DCtx* g_dctx = NULL;

static ZSTD_CCtx* yz_cctx(void) {
    if (g_cctx == NULL) { g_cctx = ZSTD_createCCtx(); }
    return g_cctx;
}

static ZSTD_DCtx* yz_dctx(void) {
    if (g_dctx == NULL) { g_dctx = ZSTD_createDCtx(); }
    return g_dctx;
}

/* --- dictionary training ------------------------------------------------------------------- */

/*
 * Trains a dictionary from `nbSamples` concatenated samples.
 * `samplesSizes` is an array of nbSamples lengths describing how `samplesBuffer` is partitioned.
 * Returns the dictionary size written into dictBuffer, or YZ_ERR.
 */
int yz_train(void* dictBuffer, size_t dictCapacity,
             const void* samplesBuffer, const size_t* samplesSizes, unsigned nbSamples) {
    size_t const size = ZDICT_trainFromBuffer(dictBuffer, dictCapacity, samplesBuffer, samplesSizes, nbSamples);
    if (ZDICT_isError(size)) { return YZ_ERR; }
    return (int)size;
}

/* --- dictionary handles -------------------------------------------------------------------- */

ZSTD_CDict* yz_cdict_create(const void* dictBuffer, size_t dictSize, int level) {
    return ZSTD_createCDict(dictBuffer, dictSize, level);
}

void yz_cdict_free(ZSTD_CDict* cdict) { ZSTD_freeCDict(cdict); }

ZSTD_DDict* yz_ddict_create(const void* dictBuffer, size_t dictSize) {
    return ZSTD_createDDict(dictBuffer, dictSize);
}

void yz_ddict_free(ZSTD_DDict* ddict) { ZSTD_freeDDict(ddict); }

/* --- compress / decompress ----------------------------------------------------------------- */

/* `cdict` may be NULL, in which case `level` is used without a dictionary. */
int yz_compress(void* dst, size_t dstCapacity, const void* src, size_t srcSize,
                const ZSTD_CDict* cdict, int level) {
    size_t written;
    if (cdict == NULL) {
        written = ZSTD_compressCCtx(yz_cctx(), dst, dstCapacity, src, srcSize, level);
    } else {
        written = ZSTD_compress_usingCDict(yz_cctx(), dst, dstCapacity, src, srcSize, cdict);
    }
    if (ZSTD_isError(written)) { return YZ_ERR; }
    return (int)written;
}

/* `ddict` may be NULL for frames compressed without a dictionary. */
int yz_decompress(void* dst, size_t dstCapacity, const void* src, size_t srcSize,
                  const ZSTD_DDict* ddict) {
    size_t written;
    if (ddict == NULL) {
        written = ZSTD_decompressDCtx(yz_dctx(), dst, dstCapacity, src, srcSize);
    } else {
        written = ZSTD_decompress_usingDDict(yz_dctx(), dst, dstCapacity, src, srcSize, ddict);
    }
    if (ZSTD_isError(written)) { return YZ_ERR; }
    return (int)written;
}

/* --- sizing -------------------------------------------------------------------------------- */

int yz_compress_bound(size_t srcSize) {
    return (int)ZSTD_compressBound(srcSize);
}

/*
 * Decompressed size recorded in the frame header. We always compress via the single-shot API, which
 * writes the content size, so this is reliable for our own frames. Returns YZ_ERR when the size is
 * unknown or the frame is malformed, rather than leaking zstd's u64 sentinel values into JS.
 */
int yz_frame_content_size(const void* src, size_t srcSize) {
    unsigned long long const size = ZSTD_getFrameContentSize(src, srcSize);
    if (size == ZSTD_CONTENTSIZE_ERROR || size == ZSTD_CONTENTSIZE_UNKNOWN) { return YZ_ERR; }
    return (int)size;
}
