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

// Narrow hand-written surface for the parts of pako the deflate payload codec uses (pako ships no
// types). Raw DEFLATE with an optional preset dictionary; enough for encode/decode round-trips.

export type DeflateFunctionOptions = {
    level?: number;
    dictionary?: Uint8Array;
};

export type InflateFunctionOptions = {
    dictionary?: Uint8Array;
};

export function deflateRaw(data: Uint8Array, options?: DeflateFunctionOptions): Uint8Array;

export function inflateRaw(data: Uint8Array, options?: InflateFunctionOptions): Uint8Array;
