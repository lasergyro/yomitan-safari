/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

import {Application} from '../application.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';
import {log} from '../core/log.js';
import {AudioSystem} from '../media/audio-system.js';

/**
 * Off-page audio playback for the Safari inline pop-up.
 *
 * The inline pop-up (`app/popup-inline.js`) renders in the **host page's** content-script context, so
 * a `new Audio(blob:)` there would run under the host page's CSP `media-src` and could be blocked. This
 * controller runs instead inside a hidden **extension-origin** iframe the inline pop-up injects, so
 * playback runs under the extension's own `media-src * blob:` and has full `chrome.runtime`/API access.
 * The pop-up posts a `play` request (term + the resolved, ordered audio sources) over `postMessage`;
 * this walks the sources exactly as `display/display-audio.js` does — first source that yields playable
 * audio wins — and plays it, or plays the configured fallback sound.
 *
 * The iframe carries `allow="autoplay"` (set by the injector) so WebKit lets it play without a user
 * gesture *inside* this cross-origin frame — the click happened on the pop-up's button in the parent.
 */
class InlineAudioPlayer {
    /**
     * @param {import('../comm/api.js').API} api
     */
    constructor(api) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {AudioSystem} */
        this._audioSystem = new AudioSystem();
        /** @type {Set<string>} */
        this._objectUrls = new Set();
        /** @type {?import('display-audio').GenericAudio} */
        this._playing = null;
        /** @type {?import('language').LanguageSummary[]} */
        this._languageSummaries = null;
        // Monotonic token so a newer play request supersedes one still resolving.
        /** @type {number} */
        this._token = 0;
    }

    /** */
    prepare() {
        this._audioSystem.prepare();
        window.addEventListener('message', this._onMessage.bind(this), false);
        // Tell the injector the frame is live; it holds the latest request until this arrives, because
        // a message posted before the module ran would be dropped.
        postToParent({action: 'inlineAudioPlayerReady'});
    }

    // Private

    /**
     * @param {MessageEvent<unknown>} event
     */
    _onMessage(event) {
        const data = event.data;
        if (data === null || typeof data !== 'object') { return; }
        const message = /** @type {import('inline-audio-player').PlayerInboundMessage} */ (data);
        switch (message.action) {
            case 'play':
                void this._onPlay(message.params, event);
                break;
            case 'stop':
                this._stop();
                break;
        }
    }

    /**
     * @param {import('inline-audio-player').PlayParams} params
     * @param {MessageEvent} event
     */
    async _onPlay(params, event) {
        const {id, term, reading, sources, language, volume, fallbackSoundType, muted = false, probe = false} = params;
        this._stop();
        const token = ++this._token;
        let played = false;
        /** @type {?import('inline-audio-player').PlaybackEvidence} */
        let evidence = null;
        try {
            const audio = await this._resolve(term, reading, sources, language);
            if (token !== this._token) { return; }
            played = (audio !== null);
            const element = audio !== null ? audio : this._audioSystem.getFallbackAudio(fallbackSoundType);
            element.currentTime = 0;
            element.volume = this._normalizeVolume(volume);
            // The probe mutes so a gesture-free run can still start playback (audible autoplay needs a
            // gesture; muted does not), isolating the Permissions-Policy `autoplay` effect it measures.
            if (muted && element instanceof HTMLAudioElement) { element.muted = true; }
            this._playing = element;
            let playPromiseResolved = false;
            /** @type {?unknown} */
            let playError = null;
            const playPromise = element.play();
            if (typeof playPromise !== 'undefined') {
                try {
                    await playPromise;
                    playPromiseResolved = true;
                } catch (e) {
                    playError = e;
                }
            } else {
                playPromiseResolved = true;
            }
            if (probe) { evidence = await this._collectPlaybackEvidence(element, played, playPromiseResolved, playError); }
        } catch (e) {
            log.log(e);
        } finally {
            // `event.source` is the parent window — the same window the inline pop-up's content script
            // lives in — so this reply reaches it; scope it to that window's origin, not `*`.
            const source = /** @type {?Window} */ (event.source);
            if (source !== null) {
                source.postMessage({action: 'inlineAudioPlayerPlayed', params: {id, played, evidence}}, event.origin);
            }
        }
    }

    /**
     * Samples the element over a short window so the reply can carry objective evidence that playback
     * actually progressed — for the loopback audio probe, which cannot hear sound.
     * @param {import('display-audio').GenericAudio} element
     * @param {boolean} resolved
     * @param {boolean} playPromiseResolved
     * @param {?unknown} playError
     * @returns {Promise<import('inline-audio-player').PlaybackEvidence>}
     */
    async _collectPlaybackEvidence(element, resolved, playPromiseResolved, playError) {
        const isMedia = element instanceof HTMLAudioElement;
        const startTime = isMedia ? element.currentTime : 0;
        await new Promise((resolve) => { setTimeout(resolve, 350); });
        const currentTime = isMedia ? element.currentTime : 0;
        return {
            resolved,
            kind: resolved ? (isMedia ? 'audio' : 'tts') : 'fallback',
            playPromiseResolved,
            playError: this._playErrorLabel(playError),
            paused: isMedia ? element.paused : false,
            muted: isMedia ? element.muted : false,
            currentTime,
            advanced: currentTime > startTime + 0.01,
            duration: isMedia && Number.isFinite(element.duration) ? element.duration : null,
            readyState: isMedia ? element.readyState : null,
            mediaError: isMedia && element.error !== null ? element.error.code : null,
        };
    }

    /**
     * @param {?unknown} playError
     * @returns {string | null}
     */
    _playErrorLabel(playError) {
        if (playError instanceof Error) { return playError.name; }
        if (typeof playError === 'string') { return playError; }
        return (playError === null || typeof playError === 'undefined') ? null : 'error';
    }

    /**
     * Walks the sources in order and returns the first playable audio, mirroring
     * `DisplayAudio._createTermAudio` without the cache/menu machinery the pop-up does not have.
     * @param {string} term
     * @param {string} reading
     * @param {import('inline-audio-player').SourceData[]} sources
     * @param {string} language
     * @returns {Promise<?import('display-audio').GenericAudio>}
     */
    async _resolve(term, reading, sources, language) {
        const languageSummary = await this._getLanguageSummary(language);
        for (const source of sources) {
            let infoList;
            try {
                infoList = await this._api.getTermAudioInfoList(source, term, reading, languageSummary);
            } catch (e) {
                continue;
            }
            for (const info of infoList) {
                try {
                    const audio = await this._createAudioFromInfo(info, source.type, language);
                    if (audio !== null) { return audio; }
                } catch (e) {
                    // Try the next info/source (e.g. jpod101 invalid-audio duration).
                }
            }
        }
        return null;
    }

    /**
     * @param {import('audio-downloader').Info} info
     * @param {import('settings').AudioSourceType} sourceType
     * @param {string} language
     * @returns {Promise<?import('display-audio').GenericAudio>}
     */
    async _createAudioFromInfo(info, sourceType, language) {
        switch (info.type) {
            case 'url':
                return await this._audioSystem.createAudio(await this._getPlayableAudioUrl(info.url), sourceType);
            case 'tts':
                return await this._createTtsAudio(info.text, info.voice, sourceType, language);
            default:
                return null;
        }
    }

    /**
     * Native render (`AVSpeechSynthesizer`) played from a blob, falling back to browser
     * `speechSynthesis` — same path and reasoning as `DisplayAudio._createTtsAudio`.
     * @param {string} text
     * @param {string} voice
     * @param {import('settings').AudioSourceType} sourceType
     * @param {string} language
     * @returns {Promise<import('display-audio').GenericAudio>}
     */
    async _createTtsAudio(text, voice, sourceType, language) {
        try {
            const {data, contentType} = await this._api.getTextToSpeechAudio(text, voice, language);
            if (typeof data === 'string' && data.length > 0) {
                const blob = new Blob([base64ToArrayBuffer(data)], {type: typeof contentType === 'string' ? contentType : 'audio/wav'});
                return await this._audioSystem.createAudio(this._trackObjectUrl(URL.createObjectURL(blob)), sourceType);
            }
        } catch (e) {
            // Fall back to the browser's speechSynthesis (below); on the 10.14 floor there is no
            // native render, and a single-voice fallback still beats silence.
        }
        return this._audioSystem.createTextToSpeechAudio(text, voice);
    }

    /**
     * Fetches remote bytes through the host and plays them from a same-origin `blob:` URL. A URL that is
     * already local (`data:`/`blob:`) is played as-is. Same as `DisplayAudio._getPlayableAudioUrl`.
     * @param {string} url
     * @returns {Promise<string>}
     */
    async _getPlayableAudioUrl(url) {
        if (/^(?:data|blob):/i.test(url)) { return url; }
        const {data, contentType} = await this._api.getAudioUrlBytes(url);
        const blob = new Blob([base64ToArrayBuffer(data)], {type: typeof contentType === 'string' ? contentType : ''});
        return this._trackObjectUrl(URL.createObjectURL(blob));
    }

    /**
     * Mirrors `Display.getLanguageSummary`, which likewise treats the lookup as present.
     * @param {string} language
     * @returns {Promise<import('language').LanguageSummary>}
     */
    async _getLanguageSummary(language) {
        if (this._languageSummaries === null) {
            this._languageSummaries = await this._api.getLanguageSummaries();
        }
        return /** @type {import('language').LanguageSummary} */ (this._languageSummaries.find(({iso}) => iso === language));
    }

    /**
     * @param {number} volume
     * @returns {number}
     */
    _normalizeVolume(volume) {
        return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 1;
    }

    /**
     * @param {string} url
     * @returns {string}
     */
    _trackObjectUrl(url) {
        this._objectUrls.add(url);
        return url;
    }

    /** */
    _stop() {
        this._token++;
        if (this._playing !== null) {
            try { this._playing.pause(); } catch (e) { /* NOP */ }
            this._playing = null;
        }
        for (const url of this._objectUrls) { URL.revokeObjectURL(url); }
        this._objectUrls.clear();
    }
}

/**
 * Posts a status message up to whatever injected this frame (the inline pop-up, or the audio probe).
 * `'*'` because the parent is an arbitrary host page; the payload carries no secrets.
 * @param {import('inline-audio-player').PlayerOutboundMessage} message
 * @returns {void}
 */
function postToParent(message) {
    if (window.parent !== null && window.parent !== window) {
        window.parent.postMessage(message, '*');
    }
}

// Announce the frame booted before the (heavier) engine bootstrap, so an injector can tell "the frame
// loaded but stalled" from "the frame never loaded", and surface a bootstrap failure instead of hanging.
postToParent({action: 'inlineAudioPlayerBooting'});
try {
    await Application.main(true, async (application) => {
        const player = new InlineAudioPlayer(application.api);
        player.prepare();
        document.documentElement.dataset.loaded = 'true';
    });
} catch (e) {
    postToParent({action: 'inlineAudioPlayerError', message: e instanceof Error ? (e.message || e.name) : String(e)});
}
