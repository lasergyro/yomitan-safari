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

import type {SerializedError} from './core';
import type {DictionarySet, MatchType, MediaRequest, ObjectStoreName, TermExactRequest, DictionaryAndQueryRequest} from './dictionary-database';

// The argument shape of each proxied call, by action. Kept explicit (rather than an index
// signature) so the owner's dispatch stays type-checked end to end instead of unpacking `any`.
export type OwnerParams = {
    prepare: Record<string, never>;
    isPrepared: Record<string, never>;
    purge: Record<string, never>;
    finalizeImport: Record<string, never>;
    getDictionaryInfo: Record<string, never>;
    dictionaryExists: {title: string};
    getDictionaryCounts: {dictionaryNames: string[], getTotal: boolean};
    deleteDictionary: {dictionaryName: string, progressRate: number};
    bulkAdd: {objectStoreName: ObjectStoreName, items: unknown[], start: number, count: number};
    bulkUpdate: {objectStoreName: ObjectStoreName, items: unknown[], start: number, count: number};
    findTermsBulk: {termList: string[], dictionaries: DictionarySet, matchType: MatchType};
    findTermsExactBulk: {termList: TermExactRequest[], dictionaries: DictionarySet};
    findTermsBySequenceBulk: {items: DictionaryAndQueryRequest[]};
    findTermMetaBulk: {termList: string[], dictionaries: DictionarySet};
    findKanjiBulk: {kanjiList: string[], dictionaries: DictionarySet};
    findKanjiMetaBulk: {kanjiList: string[], dictionaries: DictionarySet};
    findTagMetaBulk: {items: DictionaryAndQueryRequest[]};
    findTagForTitle: {name: string, dictionary: string};
    getMedia: {items: MediaRequest[]};
};

// Wire types for the proxy<->owner split of DictionaryDatabaseSqlite (plan/backend-worker.md).
// A page context cannot hold the OPFS connection (sync access handles are Worker-only), so it
// forwards each call to the SharedWorker that owns the database.

export type WorkerRequest = {
    /** Correlates this call with its reply. */
    id: number;
    /** The `DictionaryDatabaseSqlite` method to run on the owner. */
    action: keyof OwnerParams;
    /** The method's arguments, by name; narrowed per action by the owner's dispatch. */
    params: unknown;
};

export type WorkerResponse = {
    id: number;
    /** The method's return value; present on success, once. */
    result?: unknown;
    /** Present instead of `result` when the call threw. */
    error?: SerializedError;
    /** Arguments for the caller's `onProgress`; may arrive many times before the result. */
    progress?: unknown[];
};
