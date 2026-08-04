/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {EventDispatcher} from '../../core/event-dispatcher.js';
import {EventListenerCollection} from '../../core/event-listener-collection.js';
import {base64ToArrayBuffer} from '../../data/array-buffer-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {AudioSystem} from '../../media/audio-system.js';

/**
 * @augments EventDispatcher<import('audio-controller').Events>
 */
export class AudioController extends EventDispatcher {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./modal-controller.js').ModalController} modalController
     */
    constructor(settingsController, modalController) {
        super();
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {AudioSystem} */
        this._audioSystem = new AudioSystem();
        /** @type {HTMLElement} */
        this._audioSourceContainer = querySelectorNotNull(document, '#audio-source-list');
        /** @type {HTMLButtonElement} */
        this._audioSourceAddButton = querySelectorNotNull(document, '#audio-source-add');
        /** @type {AudioSourceEntry[]} */
        this._audioSourceEntries = [];
        /** @type {HTMLInputElement} */
        this._voiceTestTextInput = querySelectorNotNull(document, '#text-to-speech-voice-test-text');
        /** @type {import('audio-controller').VoiceInfo[]} */
        this._voices = [];
        /** @type {string} */
        this._language = 'ja';
    }

    /** @type {import('./settings-controller.js').SettingsController} */
    get settingsController() {
        return this._settingsController;
    }

    /** @type {import('./modal-controller.js').ModalController} */
    get modalController() {
        return this._modalController;
    }

    /** @type {number} */
    get audioSourceCount() {
        return this._audioSourceEntries.length;
    }

    /** */
    async prepare() {
        this._audioSystem.prepare();

        this._audioSourceContainer.textContent = '';
        /** @type {HTMLButtonElement} */
        const testButton = querySelectorNotNull(document, '#text-to-speech-voice-test');

        /** @type {HTMLButtonElement} */
        const audioSourceMoveButton = querySelectorNotNull(document, '#audio-source-move-button');

        audioSourceMoveButton.addEventListener('click', this._onAudioSourceMoveButtonClick.bind(this), false);

        this._audioSourceAddButton.addEventListener('click', this._onAddAudioSource.bind(this), false);

        this._audioSystem.on('voiceschanged', () => { void this._updateTextToSpeechVoices(); });
        void this._updateTextToSpeechVoices();

        testButton.addEventListener('click', this._onTestTextToSpeech.bind(this), false);

        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));

        const options = await this._settingsController.getOptions();
        const optionsContext = this._settingsController.getOptionsContext();
        this._onOptionsChanged({options, optionsContext});
    }

    /**
     * @param {AudioSourceEntry} entry
     */
    async removeSource(entry) {
        const {index} = entry;
        this._audioSourceEntries.splice(index, 1);
        entry.cleanup();
        for (let i = index, ii = this._audioSourceEntries.length; i < ii; ++i) {
            this._audioSourceEntries[i].index = i;
        }

        await this._settingsController.modifyProfileSettings([{
            action: 'splice',
            path: 'audio.sources',
            start: index,
            deleteCount: 1,
            items: [],
        }]);
    }

    /**
     * @param {number} currentIndex
     * @param {number} targetIndex
     */
    async moveAudioSourceOptions(currentIndex, targetIndex) {
        const options = await this._settingsController.getOptions();
        const optionsContext = this._settingsController.getOptionsContext();
        const {audio} = options;
        if (
            currentIndex < 0 || currentIndex >= audio.sources.length ||
            targetIndex < 0 || targetIndex >= audio.sources.length ||
            currentIndex === targetIndex
        ) {
            return;
        }

        const item = audio.sources.splice(currentIndex, 1)[0];
        audio.sources.splice(targetIndex, 0, item);

        await this._settingsController.modifyProfileSettings([{
            action: 'set',
            path: 'audio.sources',
            value: audio.sources,
        }]);

        this._onOptionsChanged({options, optionsContext});
    }

    /**
     * @returns {import('audio-controller').VoiceInfo[]}
     */
    getVoices() {
        return this._voices;
    }

    /**
     * @param {string} voice
     */
    setTestVoice(voice) {
        /** @type {HTMLInputElement} */ (this._voiceTestTextInput).dataset.voice = voice;
    }

    // Private

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options}) {
        const {
            general: {language},
            audio: {sources},
        } = options;

        this._language = language;
        // The initial voice fetch in `prepare` runs before options are known, so the
        // preferred-language sort is stale until now; recompute it before the entries below read the
        // list. No native round trip — only the ordering depends on the language.
        this._resortVoices();

        for (const entry of this._audioSourceEntries) {
            entry.cleanup();
        }
        this._audioSourceEntries = [];

        for (let i = 0, ii = sources.length; i < ii; ++i) {
            this._createAudioSourceEntry(i, sources[i]);
        }
    }

    /** */
    _onAddAudioSource() {
        void this._addAudioSource();
    }

    /** */
    _onTestTextToSpeech() {
        void this._testTextToSpeech();
    }

    /** */
    async _testTextToSpeech() {
        try {
            const input = /** @type {HTMLInputElement} */ (this._voiceTestTextInput);
            const text = input.value || '';
            const voice = typeof input.dataset.voice === 'string' ? input.dataset.voice : '';
            const audio = await this._createTtsTestAudio(text, voice);
            audio.volume = 1;
            void audio.play();
        } catch (e) {
            // NOP
        }
    }

    /**
     * The test button renders through the native host too, so it plays the *selected* voice rather
     * than the one voice Safari's `speechSynthesis` would fall back to. Blob playback is fine on the
     * settings page: it is an extension page, and `media-src` allows `blob:`.
     * @param {string} text
     * @param {string} voice
     * @returns {Promise<import('display-audio').GenericAudio>}
     */
    async _createTtsTestAudio(text, voice) {
        try {
            const {data, contentType} = await this._settingsController.application.api.getTextToSpeechAudio(text, voice, this._language);
            if (typeof data === 'string' && data.length > 0) {
                const blob = new Blob([base64ToArrayBuffer(data)], {type: typeof contentType === 'string' ? contentType : 'audio/wav'});
                return new Audio(URL.createObjectURL(blob));
            }
        } catch (e) {
            // Fall back to the browser voice below.
        }
        return this._audioSystem.createTextToSpeechAudio(text, voice);
    }

    /**
     * Loads the voice list from the **native host** rather than `speechSynthesis.getVoices()`, which
     * on Safari returns only a single voice (plan/audio-service.md). One host round trip; the native
     * voice set is static, so there is no `voiceschanged` equivalent to listen for.
     */
    async _updateTextToSpeechVoices() {
        /** @type {import('audio-downloader').TtsVoice[]} */
        let nativeVoices;
        try {
            nativeVoices = await this._settingsController.application.api.getTextToSpeechVoices();
        } catch (e) {
            nativeVoices = [];
        }
        this._voices = nativeVoices.map((voice, index) => ({
            voice,
            isPreferredLanguage: this._voiceMatchesLanguage(voice.language),
            index,
        }));
        this._voices.sort(this._textToSpeechVoiceCompare.bind(this));
        this.trigger('voicesUpdated', {});
    }

    /** Recomputes the preferred-language flag and re-sorts, when the language changes. */
    _resortVoices() {
        for (const info of this._voices) {
            info.isPreferredLanguage = this._voiceMatchesLanguage(info.voice.language);
        }
        this._voices.sort(this._textToSpeechVoiceCompare.bind(this));
    }

    /**
     * Sorts the current language's voices first, then higher quality tiers (premium, enhanced), then
     * install order — so the picker opens on the voices a user of this language actually wants.
     * @param {import('audio-controller').VoiceInfo} a
     * @param {import('audio-controller').VoiceInfo} b
     * @returns {number}
     */
    _textToSpeechVoiceCompare(a, b) {
        if (a.isPreferredLanguage !== b.isPreferredLanguage) {
            return a.isPreferredLanguage ? -1 : 1;
        }
        const qualityDelta = this._voiceQualityRank(b.voice.quality) - this._voiceQualityRank(a.voice.quality);
        if (qualityDelta !== 0) { return qualityDelta; }
        return a.index - b.index;
    }

    /**
     * @param {string} quality
     * @returns {number}
     */
    _voiceQualityRank(quality) {
        switch (quality) {
            case 'premium': return 2;
            case 'enhanced': return 1;
            default: return 0;
        }
    }

    /**
     * @param {string} voiceLanguage A BCP-47 tag like `de-DE`.
     * @returns {boolean} Whether it belongs to the currently selected language (`de`).
     */
    _voiceMatchesLanguage(voiceLanguage) {
        const language = this._language.toLowerCase();
        const voice = voiceLanguage.toLowerCase().replace(/_/g, '-');
        return voice === language || voice.startsWith(`${language}-`);
    }

    /**
     * @param {number} index
     * @param {import('settings').AudioSourceOptions} source
     */
    _createAudioSourceEntry(index, source) {
        const node = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('audio-source'));
        const entry = new AudioSourceEntry(this, index, source, node);
        this._audioSourceEntries.push(entry);
        /** @type {HTMLElement} */ (this._audioSourceContainer).appendChild(node);
        entry.prepare();
    }

    /**
     * @returns {import('settings').AudioSourceType}
     */
    _getUnusedAudioSourceType() {
        const typesAvailable = this._getAvailableAudioSourceTypes();
        for (const type of typesAvailable) {
            if (!this._audioSourceEntries.some((entry) => entry.type === type)) {
                return type;
            }
        }
        return typesAvailable[0];
    }

    /**
     * @returns {import('settings').AudioSourceType[]}
     */
    _getAvailableAudioSourceTypes() {
        /** @type {import('settings').AudioSourceType[]} */
        const generalAudioSources = ['language-pod-101', 'lingua-libre', 'wiktionary', 'text-to-speech', 'custom'];
        if (this._language === 'ja') {
            /** @type {import('settings').AudioSourceType[]} */
            const japaneseAudioSources = ['jpod101', 'jisho'];
            return [...japaneseAudioSources, ...generalAudioSources];
        }
        return generalAudioSources;
    }

    /** */
    async _addAudioSource() {
        const type = this._getUnusedAudioSourceType();
        /** @type {import('settings').AudioSourceOptions} */
        const source = {type, url: '', voice: ''};
        const index = this._audioSourceEntries.length;
        this._createAudioSourceEntry(index, source);
        await this._settingsController.modifyProfileSettings([{
            action: 'splice',
            path: 'audio.sources',
            start: index,
            deleteCount: 0,
            items: [source],
        }]);
    }

    /** */
    _onAudioSourceMoveButtonClick() {
        const modal = /** @type {import('./modal.js').Modal} */ (this._modalController.getModal('audio-source-move-location'));
        const index = modal.node.dataset.index ?? '';
        const indexNumber = Number.parseInt(index, 10);
        if (Number.isNaN(indexNumber)) { return; }

        /** @type {HTMLInputElement} */
        const targetStringInput = querySelectorNotNull(document, '#audio-source-move-location');
        const targetString = targetStringInput.value;
        const target = Number.parseInt(targetString, 10) - 1;

        if (!Number.isFinite(target) || !Number.isFinite(indexNumber) || indexNumber === target) { return; }

        void this.moveAudioSourceOptions(indexNumber, target);
    }
}

class AudioSourceEntry {
    /**
     * @param {AudioController} parent
     * @param {number} index
     * @param {import('settings').AudioSourceOptions} source
     * @param {HTMLElement} node
     */
    constructor(parent, index, source, node) {
        /** @type {AudioController} */
        this._parent = parent;
        /** @type {number} */
        this._index = index;
        /** @type {import('settings').AudioSourceType} */
        this._type = source.type;
        /** @type {string} */
        this._url = source.url;
        /** @type {string} */
        this._voice = source.voice;
        /** @type {HTMLElement} */
        this._node = node;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {HTMLSelectElement} */
        this._typeSelect = querySelectorNotNull(this._node, '.audio-source-type-select');
        /** @type {HTMLInputElement} */
        this._urlInput = querySelectorNotNull(this._node, '.audio-source-parameter-container[data-field=url] .audio-source-parameter');
        /** @type {HTMLSelectElement} */
        this._voiceSelect = querySelectorNotNull(this._node, '.audio-source-parameter-container[data-field=voice] .audio-source-parameter');
        /** @type {HTMLButtonElement} */
        this._upButton = querySelectorNotNull(this._node, '#audio-source-move-up');
        /** @type {HTMLButtonElement} */
        this._downButton = querySelectorNotNull(this._node, '#audio-source-move-down');
    }

    /** @type {number} */
    get index() {
        return this._index;
    }

    set index(value) {
        this._index = value;
    }

    /** @type {import('settings').AudioSourceType} */
    get type() {
        return this._type;
    }

    /** */
    prepare() {
        this._updateTypeParameter();

        /** @type {HTMLButtonElement} */
        const menuButton = querySelectorNotNull(this._node, '.audio-source-menu-button');

        this._typeSelect.value = this._type;
        this._urlInput.value = this._url;

        this._eventListeners.addEventListener(this._typeSelect, 'change', this._onTypeSelectChange.bind(this), false);
        this._eventListeners.addEventListener(this._urlInput, 'change', this._onUrlInputChange.bind(this), false);
        this._eventListeners.addEventListener(this._voiceSelect, 'change', this._onVoiceSelectChange.bind(this), false);
        this._eventListeners.addEventListener(menuButton, 'menuOpen', this._onMenuOpen.bind(this), false);
        this._eventListeners.addEventListener(menuButton, 'menuClose', this._onMenuClose.bind(this), false);
        this._eventListeners.addEventListener(this._upButton, 'click', (() => { this._move(-1); }).bind(this), false);
        this._eventListeners.addEventListener(this._downButton, 'click', (() => { this._move(1); }).bind(this), false);
        this._eventListeners.on(this._parent, 'voicesUpdated', this._onVoicesUpdated.bind(this));
        this._onVoicesUpdated();
    }

    /** */
    cleanup() {
        if (this._node.parentNode !== null) {
            this._node.parentNode.removeChild(this._node);
        }
        this._eventListeners.removeAllEventListeners();
    }

    // Private

    /** */
    _onVoicesUpdated() {
        if (this._voiceSelect === null) { return; }
        const voices = this._parent.getVoices();

        const fragment = document.createDocumentFragment();

        let option = document.createElement('option');
        option.value = '';
        option.textContent = 'None';
        fragment.appendChild(option);

        for (const {voice} of voices) {
            option = document.createElement('option');
            option.value = voice.id;
            const quality = voice.quality !== 'default' ? ` — ${voice.quality}` : '';
            option.textContent = `${voice.name} (${voice.language})${quality}`;
            fragment.appendChild(option);
        }

        this._voiceSelect.textContent = '';
        this._voiceSelect.appendChild(fragment);
        this._voiceSelect.value = this._voice;
    }

    /**
     * @param {number} offset
     */
    _move(offset) {
        void this._parent.moveAudioSourceOptions(this._index, this._index + offset);
    }

    /**
     * @param {Event} e
     */
    _onTypeSelectChange(e) {
        const element = /** @type {HTMLSelectElement} */ (e.currentTarget);
        const value = this._normalizeAudioSourceType(element.value);
        if (value === null) { return; }
        void this._setType(value);
    }

    /**
     * @param {Event} e
     */
    _onUrlInputChange(e) {
        const element = /** @type {HTMLInputElement} */ (e.currentTarget);
        void this._setUrl(element.value);
    }

    /**
     * @param {Event} e
     */
    _onVoiceSelectChange(e) {
        const element = /** @type {HTMLSelectElement} */ (e.currentTarget);
        void this._setVoice(element.value);
    }

    /**
     * @param {import('popup-menu').MenuOpenEvent} e
     */
    _onMenuOpen(e) {
        const {menu} = e.detail;

        let hasHelp = false;
        switch (this._type) {
            case 'custom':
            case 'custom-json':
            case 'text-to-speech':
            case 'text-to-speech-reading':
                hasHelp = true;
                break;
        }

        /** @type {?HTMLButtonElement} */
        const helpNode = menu.bodyNode.querySelector('.popup-menu-item[data-menu-action=help]');
        if (helpNode !== null) {
            helpNode.disabled = !hasHelp;
        }
    }

    /**
     * @param {import('popup-menu').MenuCloseEvent} e
     */
    _onMenuClose(e) {
        switch (e.detail.action) {
            case 'help':
                this._showHelp(this._type);
                break;
            case 'moveTo':
                this._showMoveToModal();
                break;
            case 'remove':
                void this._parent.removeSource(this);
                break;
        }
    }

    /**
     * @param {import('settings').AudioSourceType} value
     */
    async _setType(value) {
        this._type = value;
        this._updateTypeParameter();
        await this._parent.settingsController.setProfileSetting(`audio.sources[${this._index}].type`, value);
    }

    /**
     * @param {string} value
     */
    async _setUrl(value) {
        this._url = value;
        await this._parent.settingsController.setProfileSetting(`audio.sources[${this._index}].url`, value);
    }

    /**
     * @param {string} value
     */
    async _setVoice(value) {
        this._voice = value;
        await this._parent.settingsController.setProfileSetting(`audio.sources[${this._index}].voice`, value);
    }

    /** */
    _updateTypeParameter() {
        let field = null;
        switch (this._type) {
            case 'custom':
            case 'custom-json':
                field = 'url';
                break;
            case 'text-to-speech':
            case 'text-to-speech-reading':
                field = 'voice';
                break;
        }
        for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._node.querySelectorAll('.audio-source-parameter-container'))) {
            node.hidden = (field === null || node.dataset.field !== field);
        }
    }

    /**
     * @param {import('settings').AudioSourceType} type
     */
    _showHelp(type) {
        switch (type) {
            case 'custom':
                this._showModal('audio-source-help-custom');
                break;
            case 'custom-json':
                this._showModal('audio-source-help-custom-json');
                break;
            case 'text-to-speech':
            case 'text-to-speech-reading':
                this._parent.setTestVoice(this._voice);
                this._showModal('audio-source-help-text-to-speech');
                break;
        }
    }

    /** */
    _showMoveToModal() {
        const modal = this._parent.modalController.getModal('audio-source-move-location');
        if (modal === null) { return; }
        const count = this._parent.audioSourceCount;
        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(modal.node, '#audio-source-move-location');

        modal.node.dataset.index = `${this._index}`;
        input.value = `${this._index + 1}`;
        input.max = `${count}`;

        modal.setVisible(true);
    }

    /**
     * @param {string} name
     */
    _showModal(name) {
        const modal = this._parent.modalController.getModal(name);
        if (modal === null) { return; }
        modal.setVisible(true);
    }

    /**
     * @param {string} value
     * @returns {?import('settings').AudioSourceType}
     */
    _normalizeAudioSourceType(value) {
        switch (value) {
            case 'jpod101':
            case 'language-pod-101':
            case 'jisho':
            case 'lingua-libre':
            case 'wiktionary':
            case 'text-to-speech':
            case 'text-to-speech-reading':
            case 'custom':
            case 'custom-json':
                return value;
            default:
                return null;
        }
    }
}
