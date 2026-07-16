/*
 * Copyright (C) 2025  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Narrow hand-written types for the vendored zstd WASM module built by dev/zstd/build.sh, mirroring
 * the approach taken for sqlite-wasm and pako (plan/02-decisions.md #13). The surface is the shim in
 * dev/zstd/shim.c, not zstd's own API: every entry point is 32-bit clean so nothing crosses the JS
 * boundary as a BigInt.
 *
 * Functions returning `number` as a *result size* return a negative value on error.
 */

/** An address into the module's linear memory. */
export type ZstdPointer = number;

/** An opaque `ZSTD_CDict`/`ZSTD_DDict` pointer, or 0 for "no dictionary". */
export type ZstdDictHandle = number;

export type ZstdModule = {
    /**
     * The module's linear memory as bytes. NOTE: with ALLOW_MEMORY_GROWTH the backing ArrayBuffer is
     * replaced when memory grows, which detaches every existing view -- so this must be read fresh
     * from the module on each use and never cached across an allocation.
     */
    HEAPU8: Uint8Array;
    /** As `HEAPU8`, as 32-bit words; index with `ptr >> 2`. Same do-not-cache caveat applies. */
    HEAPU32: Uint32Array;
    _malloc: (size: number) => ZstdPointer;
    _free: (ptr: ZstdPointer) => void;
    /** Returns the trained dictionary's size, or negative if training failed. */
    _yz_train: (
        dictBuffer: ZstdPointer,
        dictCapacity: number,
        samplesBuffer: ZstdPointer,
        samplesSizes: ZstdPointer,
        nbSamples: number,
    ) => number;
    _yz_cdict_create: (dictBuffer: ZstdPointer, dictSize: number, level: number) => ZstdDictHandle;
    _yz_cdict_free: (cdict: ZstdDictHandle) => void;
    _yz_ddict_create: (dictBuffer: ZstdPointer, dictSize: number) => ZstdDictHandle;
    _yz_ddict_free: (ddict: ZstdDictHandle) => void;
    /** `cdict` may be 0, in which case `level` applies without a dictionary. */
    _yz_compress: (
        dst: ZstdPointer,
        dstCapacity: number,
        src: ZstdPointer,
        srcSize: number,
        cdict: ZstdDictHandle,
        level: number,
    ) => number;
    /** `ddict` may be 0 for frames written without a dictionary. */
    _yz_decompress: (
        dst: ZstdPointer,
        dstCapacity: number,
        src: ZstdPointer,
        srcSize: number,
        ddict: ZstdDictHandle,
    ) => number;
    _yz_compress_bound: (srcSize: number) => number;
    /** Decompressed size from the frame header; negative when unknown or malformed. */
    _yz_frame_content_size: (src: ZstdPointer, srcSize: number) => number;
};

/** The emscripten MODULARIZE factory (`EXPORT_NAME=zstdInitModule`). */
export type ZstdInitModule = () => Promise<ZstdModule>;
