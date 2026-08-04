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

import {NativeEngineClient} from './native-engine-client.js';

/**
 * The audio downloader, as `Backend` sees it once audio resolution and download live in the app.
 *
 * Same method names and shapes as `AudioDownloader`, so `Backend` is unchanged by the move — the
 * same swap `DictionaryDatabaseNative` and `TranslatorNative` made for their layers
 * (plan/native-rewrite.md, stage N4). The work — the source scrapers, the fetches, the codec-free
 * audio bytes — now happens in the engine, over a native fetch, which is what lets a future
 * non-browser client get audio without an extension around it. The bytes come back base64 in one
 * round trip; audio is small enough that this needs none of the chunking a database install does.
 *
 * Only the two methods the backend calls are here. The `getRequiredAudioSource*` helpers stay in
 * `audio-downloader.js` because they are pure functions the settings UI imports directly, with no
 * reason to cross the bridge.
 */
export class AudioDownloaderNative {
    /**
     * @param {?NativeEngineClient} [client] Injected by tests; the extension uses the default.
     */
    constructor(client = null) {
        /** @type {NativeEngineClient} */
        this._client = client ?? new NativeEngineClient();
    }

    /**
     * @param {import('audio').AudioSourceInfo} source
     * @param {string} term
     * @param {string} reading
     * @param {import('language').LanguageSummary} languageSummary
     * @returns {Promise<import('audio-downloader').Info[]>}
     */
    getTermAudioInfoList(source, term, reading, languageSummary) {
        return this._client.invoke('getTermAudioInfoList', {source, term, reading, languageSummary});
    }

    /**
     * Downloads a resolved audio URL's bytes through the host, base64-encoded. Backs playback in the
     * display, which cannot load the remote URL directly from the in-page overlay (Safari blocks the
     * cross-origin media load in an extension iframe embedded in the page).
     * @param {string} url
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    getAudioUrlBytes(url) {
        return this._client.invoke('getAudioUrlBytes', {url});
    }

    /**
     * @param {import('audio').AudioSourceInfo[]} sources
     * @param {?number} preferredAudioIndex
     * @param {string} term
     * @param {string} reading
     * @param {?number} idleTimeout
     * @param {import('language').LanguageSummary} languageSummary
     * @param {boolean} enableDefaultAudioSources
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    downloadTermAudio(sources, preferredAudioIndex, term, reading, idleTimeout, languageSummary, enableDefaultAudioSources) {
        return this._client.invoke('downloadTermAudio', {sources, preferredAudioIndex, term, reading, idleTimeout, languageSummary, enableDefaultAudioSources});
    }

    /**
     * The installed system voices, for the settings TTS picker.
     *
     * A **host** action (`AVSpeechSynthesizer` is native, not the JS engine), so it goes through
     * `invokeHost` rather than `invoke`. Native TTS sees every installed voice where Safari's
     * `speechSynthesis` exposes only one, which is the whole reason TTS is rendered natively
     * (plan/audio-service.md).
     * @returns {Promise<import('audio-downloader').TtsVoice[]>}
     */
    async getTextToSpeechVoices() {
        const response = await this._client.invokeHost('ttsVoices');
        return Array.isArray(response.voices) ? /** @type {import('audio-downloader').TtsVoice[]} */ (response.voices) : [];
    }

    /**
     * Offline-renders one utterance to WAV bytes (base64), for the display to play from a blob. Host
     * action, on the same reasoning as `getTextToSpeechVoices`.
     * @param {string} text
     * @param {string} voice The voice identifier, or an empty string for the language default.
     * @param {string} language ISO code, so the host can pick a language default when `voice` is unset.
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    async getTextToSpeechAudio(text, voice, language) {
        const response = await this._client.invokeHost('ttsSynthesize', {text, voice, language});
        return {
            data: typeof response.data === 'string' ? response.data : '',
            contentType: typeof response.contentType === 'string' ? response.contentType : 'audio/wav',
        };
    }
}
