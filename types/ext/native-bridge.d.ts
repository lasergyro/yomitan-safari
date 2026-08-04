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

import type * as Audio from './audio';
import type * as AudioDownloader from './audio-downloader';
import type * as Dictionary from './dictionary';
import type * as DictionaryDatabase from './dictionary-database';
import type * as DictionaryImporter from './dictionary-importer';
import type * as Language from './language';
import type * as SqliteWasm from './sqlite-wasm';
import type * as Translation from './translation';
import type * as Translator from './translator';

/** One request across the bridge. `params` is always an object so actions can gain fields. */
export type NativeRequest = {
    action: string;
    params: {[key: string]: unknown};
};

export type SerializedError = {
    message: string;
    name?: string;
    stack?: string;
};

/** One reply. Exactly one of the two keys is present. */
export type NativeResponse = {
    result?: unknown;
    error?: SerializedError;
};

/** `Media` with its `ArrayBuffer` content base64-encoded for JSON transport. */
export type EncodedMedia = Omit<DictionaryDatabase.Media, 'content'> & {content: string};

/** A `RegExp` reduced to what `new RegExp(source, flags)` needs. */
export type EncodedTextReplacement = {pattern: string, flags: string, replacement: string};

/**
 * `FindTermsOptions` with its `Map`, `Set` and `RegExp` fields flattened. Everything else is already
 * JSON — see `encodeFindTermsOptions` for why these three in particular are dangerous to forget.
 */
export type EncodedFindTermsOptions = Omit<Translation.FindTermsOptions, 'enabledDictionaryMap' | 'excludeDictionaryDefinitions' | 'textReplacements'> & {
    enabledDictionaryMap: [string, Translation.FindTermDictionary][];
    excludeDictionaryDefinitions: string[] | null;
    textReplacements: (EncodedTextReplacement[] | null)[];
};

export type EncodedFindKanjiOptions = Omit<Translation.FindKanjiOptions, 'enabledDictionaryMap'> & {
    enabledDictionaryMap: [string, Translation.FindKanjiDictionary][];
};

/**
 * The host object the Swift side installs into the JavaScriptCore global before evaluating the
 * bundle. This is the whole platform surface the engine is allowed to assume — anything not here
 * has to be shimmed in JS (see `native-core-main.js`).
 */
export type NativeHost = {
    /** Opens (creating if absent) the dictionary database at the app-container path. */
    openDatabase(path: string): SqliteWasm.SqliteDatabaseHandle;
    /** Absolute path of the dictionary database inside the app container. */
    databasePath(): string;
    /** `os_log` passthrough, so engine logging survives into Console.app. */
    log(level: string, message: string): void;
    /** Monotonic milliseconds; `performance.now` does not exist in bare JavaScriptCore. */
    now(): number;
    /**
     * One synchronous HTTP round trip. Blocking is deliberate: the engine already runs on a queue
     * that `invoke` holds until the call settles, so a blocking fetch fits the model without an
     * async-I/O path (native/Sources/YomitanNative/NativeEngineHost.swift). Request and response
     * bodies are base64 so arbitrary bytes survive the JSON-only bridge. Backs the audio downloader.
     */
    fetch(request: {url: string, method: string, headers: {[key: string]: string}, bodyBase64: string, timeoutMs: number}): {status: number, url: string, headers: {[key: string]: string}, bodyBase64: string, error?: string};
    /** `new URL(url, base).href`, resolved by Foundation rather than a hand-written parser. */
    resolveUrl(url: string, base: string): string;
    /** SHA-256 of base64 bytes, returned base64. Backs `crypto.subtle.digest`. */
    sha256(base64: string): string;
};

/**
 * The action table. Each entry is the params the client sends and the result the engine returns,
 * after transport encoding — so `dictionaries` is a `string[]` here even though the extension-side
 * method takes a `Set`, and media content is base64.
 */
export type EngineApiSurface = {
    prepare: {
        params: Record<string, never>;
        return: {schemaVersion: number, dictionaryCount: number};
    };
    getDictionaryInfo: {
        params: Record<string, never>;
        return: DictionaryImporter.Summary[];
    };
    getDictionaryCounts: {
        params: {dictionaryNames: string[], getTotal: boolean};
        return: DictionaryDatabase.DictionaryCounts;
    };
    dictionaryExists: {
        params: {title: string};
        return: boolean;
    };
    deleteDictionary: {
        params: {dictionaryName: string};
        return: void;
    };
    purge: {
        params: Record<string, never>;
        return: void;
    };
    findTermsBulk: {
        params: {termList: string[], dictionaries: string[], matchType: DictionaryDatabase.MatchType};
        return: DictionaryDatabase.TermEntry[];
    };
    findTermsExactBulk: {
        params: {termList: DictionaryDatabase.TermExactRequest[], dictionaries: string[]};
        return: DictionaryDatabase.TermEntry[];
    };
    findTermsBySequenceBulk: {
        params: {items: DictionaryDatabase.DictionaryAndQueryRequest[]};
        return: DictionaryDatabase.TermEntry[];
    };
    findTermMetaBulk: {
        params: {termList: string[], dictionaries: string[]};
        return: DictionaryDatabase.TermMeta[];
    };
    findKanjiBulk: {
        params: {kanjiList: string[], dictionaries: string[]};
        return: DictionaryDatabase.KanjiEntry[];
    };
    findKanjiMetaBulk: {
        params: {kanjiList: string[], dictionaries: string[]};
        return: DictionaryDatabase.KanjiMeta[];
    };
    findTagMetaBulk: {
        params: {items: DictionaryDatabase.DictionaryAndQueryRequest[]};
        return: (DictionaryDatabase.Tag | undefined)[];
    };
    findTagForTitle: {
        params: {name: string, dictionary: string};
        return: DictionaryDatabase.Tag | null;
    };
    getMedia: {
        params: {items: DictionaryDatabase.MediaRequest[]};
        return: EncodedMedia[];
    };
    termsFind: {
        params: {mode: Translator.FindTermsMode, text: string, options: EncodedFindTermsOptions};
        return: {dictionaryEntries: Dictionary.TermDictionaryEntry[], originalTextLength: number};
    };
    kanjiFind: {
        params: {text: string, options: EncodedFindKanjiOptions};
        return: Dictionary.KanjiDictionaryEntry[];
    };
    getTermFrequencies: {
        params: {termReadingList: Translator.TermReadingList, dictionaries: string[]};
        return: Translator.TermFrequencySimple[];
    };
    clearDatabaseCaches: {
        params: Record<string, never>;
        return: void;
    };
    getTermAudioInfoList: {
        params: {source: Audio.AudioSourceInfo, term: string, reading: string, languageSummary: Language.LanguageSummary};
        return: AudioDownloader.Info[];
    };
    downloadTermAudio: {
        params: {sources: Audio.AudioSourceInfo[], preferredAudioIndex: number | null, term: string, reading: string, idleTimeout: number | null, languageSummary: Language.LanguageSummary, enableDefaultAudioSources: boolean};
        return: AudioDownloader.AudioBinaryBase64;
    };
    getAudioUrlBytes: {
        params: {url: string};
        return: AudioDownloader.AudioBinaryBase64;
    };
};

export type EngineApiNames = keyof EngineApiSurface;

export type EngineApiParams<TName extends EngineApiNames> = EngineApiSurface[TName]['params'];

export type EngineApiReturn<TName extends EngineApiNames> = EngineApiSurface[TName]['return'];

export type EngineApiHandler<TName extends EngineApiNames = EngineApiNames> = (
    params: EngineApiParams<TName>,
) => Promise<EngineApiReturn<TName>> | EngineApiReturn<TName>;

export type EngineApiHandlerMap = {[TName in EngineApiNames]: EngineApiHandler<TName>};
