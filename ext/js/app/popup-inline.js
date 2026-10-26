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

import {EventDispatcher} from '../core/event-dispatcher.js';
import {fetchText} from '../core/fetch-utilities.js';
import {log} from '../core/log.js';
import {generateId} from '../core/utilities.js';
import {AnkiNoteBuilder} from '../data/anki-note-builder.js';
import {getDynamicTemplates} from '../data/anki-template-util.js';
import {INVALID_NOTE_ID} from '../data/anki-util.js';
import {DisplayContentManager} from '../display/display-content-manager.js';
import {DisplayGenerator} from '../display/display-generator.js';
import {getRequiredAudioSourceList} from '../media/audio-downloader.js';
import {TemplateRendererProxy} from '../templates/template-renderer-proxy.js';

/**
 * A Safari-only `Popup` implementation that renders the dictionary inline in the host
 * page rather than in an extension-origin iframe.
 *
 * IMPORTANT CONTEXT: unlike the standard popup, this and its `DisplayGenerator` run in
 * the HOST PAGE'S content-script context, not an extension page. Consequences to keep
 * in mind when editing or when reusing shared utilities here:
 * - `document`/`window`/`fetch` belong to the page, not the extension.
 * - Fetching an extension asset (via `chrome.runtime.getURL`) is CROSS-ORIGIN, so it
 *   must use `mode: 'cors'` (the shared `fetchText`/`fetchAsset` helpers do). A
 *   `mode: 'no-cors'` fetch returns an opaque response (status 0) and fails here.
 * - This class is duck-typed as a `Popup` (see popup-factory.js) and is invisible to the
 *   type checker, so shared code that assumes an extension-origin page can break here
 *   silently. See docs/browser-bugs.md (Safari Web Extension port).
 * @augments EventDispatcher<import('popup').Events>
 */
export class PopupInline extends EventDispatcher {
    /**
     * @param {import('../application.js').Application} application The main application instance.
     * @param {string} id The identifier of the popup.
     * @param {number} depth The depth of the popup.
     * @param {number} frameId The frameId of the host frame.
     * @param {boolean} childrenSupported Whether or not the popup is able to show child popups.
     */
    constructor(application, id, depth, frameId, childrenSupported) {
        super();
        /** @type {import('../application.js').Application} */
        this._application = application;
        /** @type {string} */
        this._id = id;
        /** @type {number} */
        this._depth = depth;
        /** @type {number} */
        this._frameId = frameId;
        /** @type {boolean} */
        this._childrenSupported = childrenSupported;
        /** @type {?PopupInline} */
        this._parent = null;
        /** @type {?PopupInline} */
        this._child = null;
        /** @type {?import('settings').OptionsContext} */
        this._optionsContext = null;
        /** @type {HTMLDivElement} */
        this._container = document.createElement('div');
        this._container.className = 'yomitan-inline-popup';
        this._container.hidden = true;
        this._container.style.position = 'fixed';
        this._container.style.zIndex = '2147483647';
        this._container.style.left = '0';
        this._container.style.top = '0';
        this._container.style.width = '360px';
        this._container.style.minWidth = '240px';
        this._container.style.maxWidth = '90vw';
        this._container.style.minHeight = '180px';
        this._container.style.maxHeight = '90vh';
        this._container.style.resize = 'both';
        this._container.style.overflow = 'hidden';
        this._container.style.boxSizing = 'border-box';
        this._container.style.border = '1px solid rgba(0, 0, 0, 0.18)';
        this._container.style.borderRadius = '10px';
        this._container.style.background = '#ffffff';
        this._container.style.color = '#111827';
        this._container.style.boxShadow = '0 16px 40px rgba(0, 0, 0, 0.25)';
        this._container.style.padding = '0';
        this._container.style.font = '14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        this._container.style.wordBreak = 'break-word';
        this._container.style.display = 'none';
        this._container.style.flexDirection = 'column';
        this._container.style.opacity = '0';
        this._container.style.transition = 'opacity 180ms ease';
        this._container.style.whiteSpace = 'normal';
        this._container.style.textAlign = 'left';
        this._container.style.userSelect = 'text';
        this._container.addEventListener('mouseenter', this._onMouseEnter.bind(this), false);
        this._container.addEventListener('mouseleave', this._onMouseLeave.bind(this), false);
        this._container.addEventListener('mousedown', (e) => {
            this.stopHideDelayed();
            this._isPointerOver = true;
            e.stopPropagation();
        }, false);
        this._container.addEventListener('click', (e) => {
            this.stopHideDelayed();
            this._isPointerOver = true;
            e.stopPropagation();
        }, false);
        /** @type {boolean} */
        this._visible = false;
        /** @type {boolean} */
        this._isPointerOver = false;
        /** @type {?import('core').Timeout} */
        this._hidePopupTimer = null;
        /** @type {?import('core').Timeout} */
        this._fadeTimer = null;
        /** @type {import('popup').ValidRect} */
        this._frameRect = {left: 0, top: 0, right: 0, bottom: 0, valid: false};
        /** @type {number} */
        this._initialWidth = 300;
        /** @type {number} */
        this._initialHeight = 400;
        /** @type {number} */
        this._horizontalOffset = 0;
        /** @type {number} */
        this._verticalOffset = 10;
        /** @type {number} */
        this._horizontalOffset2 = 10;
        /** @type {number} */
        this._verticalOffset2 = 0;
        /** @type {boolean} */
        this._hidePopupOnCursorExit = false;
        /** @type {number} */
        this._hidePopupOnCursorExitDelay = 0;
        /** @type {Map<import('core').TokenString, boolean>} */
        this._visibleOverrides = new Map();
        /** @type {ShadowRoot} */
        this._shadow = this._container.attachShadow({mode: 'open'});
        /** @type {?Element} */
        this._contentRoot = null;
        /** @type {?DisplayGenerator} */
        this._displayGenerator = null;
        /** @type {?DisplayContentManager} */
        this._displayContentManager = null;
        /** @type {?import('dictionary-importer').Summary[]} */
        this._dictionaryInfo = null;
        /** @type {?Promise<void>} */
        this._setupPromise = null;
        /** @type {?import('settings').ProfileOptions} */
        this._options = null;
        /** @type {boolean} */
        this._displayModeIsFullWidth = false;
        /** @type {string} */
        this._customCss = '';
        /** @type {?HTMLStyleElement} */
        this._customCssStyleNode = null;
        /** @type {?string} */
        this._ankiFieldTemplates = null;
        /** @type {TemplateRendererProxy} */
        this._templateRenderer = new TemplateRendererProxy();
        /** @type {AnkiNoteBuilder} */
        this._ankiNoteBuilder = new AnkiNoteBuilder(this._application.api, this._templateRenderer);
        /** @type {?import('core').TokenObject} */
        this._renderToken = null;
        /** @type {?{left: number, top: number}} */
        this._savedPosition = null;
        /** @type {?{width: number, height: number}} */
        this._savedSize = null;
        /** @type {boolean} */
        this._positionLoaded = false;
        /** @type {?{offsetX: number, offsetY: number}} */
        this._dragState = null;
        /** @type {?{left: number, top: number}} */
        this._lastPosition = null;
        /** @type {(event: MouseEvent) => void} */
        this._onDragMoveBound = this._onDragMove.bind(this);
        /** @type {() => void} */
        this._onDragEndBound = this._onDragEnd.bind(this);
        /** @type {ResizeObserver} */
        this._resizeObserver = new ResizeObserver(() => {
            if (!this._visible || this._displayModeIsFullWidth) { return; }
            const rect = this._container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const roundedW = Math.round(rect.width);
                const roundedH = Math.round(rect.height);
                if (
                    this._savedSize === null ||
                    Math.abs(this._savedSize.width - roundedW) > 2 ||
                    Math.abs(this._savedSize.height - roundedH) > 2
                ) {
                    this._savedSize = {width: roundedW, height: roundedH};
                    this._frameRect = {
                        left: rect.left,
                        top: rect.top,
                        right: rect.right,
                        bottom: rect.bottom,
                        valid: true,
                    };
                    void this._saveSize();
                }
            }
        });
        this._resizeObserver.observe(this._container);

        // Audio plays off-page: the inline pop-up runs in the host page, so it drives a hidden
        // extension-origin iframe (inline-audio-player.html) that plays under the extension's own CSP.
        // See app/inline-audio-player-main.js and plan/audio-service.md.
        /** @type {?HTMLIFrameElement} */
        this._audioPlayerFrame = null;
        /** @type {boolean} */
        this._audioPlayerReady = false;
        /** The extension origin, the exact `targetOrigin` for posting to the player frame. */
        this._audioPlayerTargetOrigin = chrome.runtime.getURL('/').replace(/\/$/, '');
        /** @type {?import('inline-audio-player').PlayParams} */
        this._pendingAudioPlay = null;
        /** @type {number} */
        this._audioRequestId = 0;
        /** @type {boolean} */
        this._audioEnabled = false;
        /** @type {number} */
        this._audioVolume = 100;
        /** @type {import('settings').FallbackSoundType} */
        this._audioFallbackSoundType = 'click';
        /** @type {import('inline-audio-player').SourceData[]} */
        this._audioSources = [];
        /** @type {(event: MessageEvent) => void} */
        this._onWindowMessageBound = this._onWindowMessage.bind(this);
    }

    /** @returns {string} */
    get id() { return this._id; }

    /** @returns {?PopupInline} */
    get parent() { return this._parent; }

    /** @param {?PopupInline} value */
    set parent(value) { this._parent = value; }

    /** @returns {?PopupInline} */
    get child() { return this._child; }

    /** @param {?PopupInline} value */
    set child(value) { this._child = value; }

    /** @returns {number} */
    get depth() { return this._depth; }

    /** @returns {Window} */
    get frameContentWindow() { return window; }

    /** @returns {HTMLDivElement} */
    get container() { return this._container; }

    /** @returns {number} */
    get frameId() { return this._frameId; }

    /** @returns {void} */
    prepare() {
        if (this._container.parentNode === null) {
            document.documentElement.appendChild(this._container);
        }
        window.addEventListener('message', this._onWindowMessageBound, false);
    }

    /**
     * @param {import('settings').OptionsContext} optionsContext The options context object.
     * @returns {Promise<void>}
     */
    async setOptionsContext(optionsContext) {
        const optionsContext2 = this._normalizeOptionsContext(optionsContext);
        this._optionsContext = optionsContext2;
        const options = await this._application.api.optionsGet(optionsContext2);
        this._options = options;
        const {general, scanning} = options;
        const isBridge = (window.location.hostname === '127.0.0.1' || window.location.protocol === 'yomitan-bridge:');
        this._displayModeIsFullWidth = isBridge ? false : (general.popupDisplayMode === 'full-width');
        this._initialWidth = general.popupWidth;
        this._initialHeight = general.popupHeight;
        this._horizontalOffset = general.popupHorizontalOffset;
        this._verticalOffset = general.popupVerticalOffset;
        this._horizontalOffset2 = general.popupHorizontalOffset2;
        this._hidePopupOnCursorExit = isBridge ? false : scanning.hidePopupOnCursorExit;
        this._hidePopupOnCursorExitDelay = scanning.hidePopupOnCursorExitDelay;
        // The standard popup receives the user's custom CSS through the Display inside its
        // iframe; the inline popup has no such Display, so read and apply it here directly.
        this._customCss = typeof general.customPopupCss === 'string' ? general.customPopupCss : '';
        this._applyCustomCss();
        this._updateAudioConfig(options);
        this._updateContainerSize();
    }

    /**
     * Reads the audio options into the fields the play buttons and the off-page player use, building
     * the ordered source list exactly as `DisplayAudio._onOptionsUpdated` does (options first, then any
     * language defaults when `enableDefaultAudioSources`). A `data-audio-enabled` attribute on the host
     * gates the play button's visibility in the shadow stylesheet.
     * @param {import('settings').ProfileOptions} options
     * @returns {void}
     */
    _updateAudioConfig(options) {
        const {general: {language}, audio: {enabled, volume, fallbackSoundType, sources, enableDefaultAudioSources}} = options;
        this._audioEnabled = enabled;
        this._audioVolume = volume;
        this._audioFallbackSoundType = fallbackSoundType;

        /** @type {import('inline-audio-player').SourceData[]} */
        const sourceData = [];
        /** @type {Set<import('settings').AudioSourceType>} */
        const requiredAudioSources = enableDefaultAudioSources ? getRequiredAudioSourceList(language) : new Set();
        for (const {type, url, voice} of sources) {
            sourceData.push({type, url, voice});
            requiredAudioSources.delete(type);
        }
        for (const type of requiredAudioSources) {
            sourceData.push({type, url: '', voice: ''});
        }
        this._audioSources = sourceData;

        if (enabled) {
            this._container.dataset.audioEnabled = 'true';
        } else {
            delete this._container.dataset.audioEnabled;
        }
    }

    /**
     * @param {boolean} _changeFocus Whether or not the parent popup or host frame should be focused.
     * @returns {void}
     */
    hide(_changeFocus) {
        this.stopHideDelayed();
        this._visible = false;
        this._container.hidden = true;
        this._container.style.display = 'none';
        this._container.style.opacity = '0';
        this._frameRect = {left: 0, top: 0, right: 0, bottom: 0, valid: false};
        if (this._child !== null) {
            this._child.hide(false);
        }
        if (typeof window !== 'undefined' && typeof window.__bridgeReportRects === 'function') {
            window.__bridgeReportRects();
        }
    }

    /**
     * @param {number} delay The delay in milliseconds before hiding.
     * @returns {void}
     */
    hideDelayed(delay) {
        if (this.isPointerOverSelfOrChildren() || this._dragState !== null) { return; }
        if (delay > 0) {
            this.stopHideDelayed();
            this._hidePopupTimer = setTimeout(() => {
                this._hidePopupTimer = null;
                if (!this.isPointerOverSelfOrChildren() && this._dragState === null) {
                    this._startFadeOut();
                }
            }, delay);
        } else {
            this._startFadeOut();
        }
    }

    /** @returns {void} */
    stopHideDelayed() {
        if (this._hidePopupTimer !== null) {
            clearTimeout(this._hidePopupTimer);
            this._hidePopupTimer = null;
        }
        if (this._fadeTimer !== null) {
            clearTimeout(this._fadeTimer);
            this._fadeTimer = null;
        }
        if (this._visible) {
            this._container.style.opacity = '1';
        }
    }

    /** @returns {Promise<boolean>} `true` if the popup is visible, `false` otherwise. */
    async isVisible() {
        return this.isVisibleSync();
    }

    /**
     * @param {boolean} value Whether or not the popup should be visible.
     * @param {number} _priority The priority of the override.
     * @returns {Promise<?import('core').TokenString>} A token which can be passed to `clearVisibleOverride`.
     */
    async setVisibleOverride(value, _priority) {
        const token = generateId(16);
        this._visibleOverrides.set(token, value);
        if (!value) {
            this.hide(false);
        } else if (this._container.textContent !== '') {
            this._visible = true;
            this._container.hidden = false;
            this._container.style.display = 'flex';
            this._container.style.opacity = '1';
        }
        return token;
    }

    /**
     * @param {import('core').TokenString} token The token returned from `setVisibleOverride`.
     * @returns {Promise<boolean>} `true` if the override existed and was removed, `false` otherwise.
     */
    async clearVisibleOverride(token) {
        return this._visibleOverrides.delete(token);
    }

    /**
     * @param {number} x The x coordinate.
     * @param {number} y The y coordinate.
     * @returns {Promise<boolean>} `true` if the point is contained within the popup's rect, `false` otherwise.
     */
    async containsPoint(x, y) {
        const {left, top, right, bottom, valid} = this._frameRect;
        return valid && x >= left && x < right && y >= top && y < bottom;
    }

    /**
     * @param {import('popup').ContentDetails} details
     * @param {?import('display').ContentDetails} displayDetails
     * @returns {Promise<void>}
     */
    async showContent(details, displayDetails) {
        // Only (re)apply options when the caller actually provides a context. The scroll/
        // resize reposition path (frontend `_updatePopupPosition`) calls showContent with a
        // null optionsContext purely to re-place the popup. Re-deriving {current:true} there
        // used to re-run setOptionsContext on every scroll, which reset the container to the
        // configured popupWidth/popupHeight; combined with the visible-popup guard below
        // skipping `_position`, a full-width bar collapsed to popupWidth. Match the standard
        // popup (popup.js) and skip on null.
        const {optionsContext} = details;
        if (optionsContext !== null) {
            const normalizedOptionsContext = this._normalizeOptionsContext(optionsContext);
            if (this._optionsContext === null || JSON.stringify(this._optionsContext) !== JSON.stringify(normalizedOptionsContext)) {
                await this.setOptionsContext(normalizedOptionsContext);
            }
        }

        this.stopHideDelayed();
        this.prepare();
        /** @type {import('core').TokenObject} */
        const renderToken = {};
        this._renderToken = renderToken;
        await this._render(displayDetails, renderToken);
        if (this._renderToken !== renderToken) { return; }
        await this._ensurePositionLoaded();
        if (this._renderToken !== renderToken) { return; }
        // A full-width bar is anchored to the visible (visual) viewport, so it must be
        // re-placed on every reposition call - including the scroll/resize/zoom path that
        // runs while the popup is already visible. Otherwise pinch-zoom leaves the bar
        // pinned to the layout viewport and it drifts out of the visible area.
        if (!this._visible || !this._frameRect.valid || this._displayModeIsFullWidth) {
            this._position(details.sourceRects);
        }
        const query = displayDetails?.params?.query;
        if (typeof query === 'string' && query !== this._lastRenderedQuery) {
            this._lastRenderedQuery = query;
            const scroll = this._shadow.querySelector('.content-scroll');
            if (scroll) {
                scroll.scrollTop = 0;
                scroll.scrollLeft = 0;
            }
        }
        this._visible = true;
        this._container.hidden = false;
        this._container.style.display = 'flex';
        this._container.style.opacity = '1';
    }

    /**
     * @param {string} css The CSS rules.
     * @returns {Promise<void>}
     */
    async setCustomCss(css) {
        this._customCss = typeof css === 'string' ? css : '';
        this._applyCustomCss();
    }

    /**
     * Pushes the current custom CSS into the dedicated `<style>` node in the shadow root.
     * The node is created during renderer setup, so this is a no-op until then; the value
     * is retained in `_customCss` and applied when the node is created.
     * @returns {void}
     */
    _applyCustomCss() {
        if (this._customCssStyleNode !== null) {
            this._customCssStyleNode.textContent = this._customCss;
        }
    }

    /** @returns {Promise<void>} */
    async clearAutoPlayTimer() {}

    /**
     * @param {number} scale The scaling factor.
     * @returns {Promise<void>}
     */
    async setContentScale(scale) {
        this._container.style.fontSize = `${14 * scale}px`;
    }

    /** @returns {boolean} */
    isVisibleSync() { return this._visible; }

    /** @returns {Promise<void>} */
    async updateTheme() {}

    /**
     * @param {string} _css The CSS rules.
     * @param {boolean} _useWebExtensionApi Whether or not web extension APIs should be used to inject the rules.
     * @returns {Promise<void>}
     */
    async setCustomOuterCss(_css, _useWebExtensionApi) {}

    /** @returns {import('popup').ValidRect} The rect. */
    getFrameRect() { return this._frameRect; }

    /** @returns {Promise<import('popup').ValidSize>} The size and whether or not it is valid. */
    async getFrameSize() {
        const rect = this._container.getBoundingClientRect();
        return {width: rect.width, height: rect.height, valid: this._visible};
    }

    /**
     * @param {number} width The desired width of the popup.
     * @param {number} height The desired height of the popup.
     * @returns {Promise<boolean>} `true` if the size assignment was successful, `false` otherwise.
     */
    async setFrameSize(width, height) {
        this._initialWidth = width;
        this._initialHeight = height;
        this._container.style.width = `${width}px`;
        this._container.style.maxWidth = `${width}px`;
        this._container.style.maxHeight = `${height}px`;
        return true;
    }

    /** @returns {boolean} */
    isPointerOver() { return this._isPointerOver; }

    /** @returns {boolean} */
    isPointerOverSelfOrChildren() {
        if (this._isPointerOver) { return true; }
        for (let popup = this._child; popup !== null; popup = popup.child) {
            if (popup.isPointerOver()) { return true; }
        }
        return false;
    }

    /** @returns {void} */
    _onMouseEnter() {
        this.stopHideDelayed();
        this._isPointerOver = true;
        this.trigger('mouseOver', {});
    }

    /** @returns {void} */
    _onMouseLeave() {
        this._isPointerOver = false;
        this.trigger('mouseOut', {});
        if (this._hidePopupOnCursorExit) {
            this.hideDelayed(this._hidePopupOnCursorExitDelay);
        }
    }

    /**
     * @param {MouseEvent} e The mousedown event.
     * @returns {void}
     */
    _onDragStart(e) {
        if (e.button !== 0) { return; }
        // A full-width bar is pinned to a viewport edge and is not draggable.
        if (this._displayModeIsFullWidth) { return; }
        const target = /** @type {Element?} */ (e.composedPath()[0] ?? null);
        if (target !== null && target.closest('a, button, input, select, textarea, summary')) { return; }

        this.stopHideDelayed();
        const rect = this._container.getBoundingClientRect();
        this._dragState = {
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
        };
        window.addEventListener('mousemove', this._onDragMoveBound, true);
        window.addEventListener('mouseup', this._onDragEndBound, true);
        e.preventDefault();
        e.stopPropagation();
    }

    /**
     * @param {MouseEvent} e The mousemove event.
     * @returns {void}
     */
    _onDragMove(e) {
        if (this._dragState === null) { return; }
        const {offsetX, offsetY} = this._dragState;
        const left = e.clientX - offsetX;
        const top = e.clientY - offsetY;
        const position = this._clampPosition(left, top);
        this._applyPosition(position.left, position.top);
        const rect = this._container.getBoundingClientRect();
        this._frameRect = {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            valid: true,
        };
    }

    /** @returns {void} */
    _onDragEnd() {
        if (this._dragState === null) { return; }
        this._dragState = null;
        window.removeEventListener('mousemove', this._onDragMoveBound, true);
        window.removeEventListener('mouseup', this._onDragEndBound, true);
        if (this._lastPosition !== null) {
            this._savedPosition = {left: this._lastPosition.left, top: this._lastPosition.top};
            void this._savePosition();
        }
        const rect = this._container.getBoundingClientRect();
        this._frameRect = {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            valid: true,
        };
        if (typeof window !== 'undefined' && typeof window.__bridgeReportRects === 'function') {
            window.__bridgeReportRects();
        }
    }

    /** @returns {void} */
    _startFadeOut() {
        if (!this._visible || this._dragState !== null) { return; }
        this._container.style.opacity = '0';
        if (this._fadeTimer !== null) {
            clearTimeout(this._fadeTimer);
        }
        this._fadeTimer = setTimeout(() => {
            this._fadeTimer = null;
            if (!this.isPointerOverSelfOrChildren() && this._dragState === null) {
                this.hide(false);
            }
        }, 180);
    }

    /**
     * @param {import('popup').Rect[]} sourceRects
     * @returns {void}
     */
    _position(sourceRects) {
        sourceRects = this._toFixedRects(sourceRects);
        if (this._displayModeIsFullWidth) {
            this._positionFullWidth(sourceRects);
            return;
        }

        const width = this._savedSize?.width ?? 360;
        const height = this._savedSize?.height ?? 420;
        const clampedW = Math.min(Math.max(width, 240), Math.max(240, window.innerWidth - 16));
        const clampedH = Math.min(Math.max(height, 180), Math.max(180, window.innerHeight - 16));

        this._container.style.width = `${clampedW}px`;
        this._container.style.height = `${clampedH}px`;
        this._container.style.display = 'flex';
        this._container.hidden = false;

        let left;
        let top;
        const bounds = this._getGameBounds();
        if (this._savedPosition !== null) {
            if (
                this._savedPosition.left < bounds.x ||
                this._savedPosition.left > bounds.x + bounds.w - 80 ||
                this._savedPosition.top < bounds.y ||
                this._savedPosition.top > bounds.y + bounds.h - 60
            ) {
                this._savedPosition = null;
            }
        }
        if (this._lastPosition !== null) {
            if (
                this._lastPosition.left < bounds.x ||
                this._lastPosition.left > bounds.x + bounds.w - 80 ||
                this._lastPosition.top < bounds.y ||
                this._lastPosition.top > bounds.y + bounds.h - 60
            ) {
                this._lastPosition = null;
            }
        }

        if (this._savedPosition !== null) {
            ({left, top} = this._clampPosition(this._savedPosition.left, this._savedPosition.top));
        } else if (this._lastPosition !== null) {
            ({left, top} = this._clampPosition(this._lastPosition.left, this._lastPosition.top));
        } else {
            ({left, top} = this._getDefaultFixedPosition(clampedW, clampedH));
            this._savedPosition = {left, top};
            void this._savePosition();
        }
        this._applyPosition(left, top);

        const finalRect = this._container.getBoundingClientRect();
        this._frameRect = {
            left: finalRect.left,
            top: finalRect.top,
            right: finalRect.right,
            bottom: finalRect.bottom,
            valid: true,
        };
    }

    /**
     * Positions the popup as a full-width bar pinned to the top or bottom edge of the
     * viewport, mirroring the standard popup's `full-width` display mode. The saved drag
     * position and horizontal clamping are intentionally ignored in this mode.
     * @param {import('popup').Rect[]} sourceRects
     * @returns {void}
     */
    _positionFullWidth(sourceRects) {
        // Measure against the visual viewport, not the layout viewport: under Safari
        // pinch-zoom the two diverge, and a `position: fixed` bar is laid out relative to
        // the layout viewport. Sizing/offsetting by the visual viewport keeps the bar
        // filling the visible width and pinned to the visible edge as the user zooms/pans.
        const viewport = this._getViewport();
        const width = viewport.width;
        // The container is sized in CSS (layout) pixels, which Safari magnifies by the
        // pinch-zoom scale on screen. Divide the configured height by the scale so the bar
        // keeps a constant *on-screen* height instead of growing as the user zooms in.
        // (`width` needs no such adjustment: it already tracks the shrinking visible width
        // and renders edge-to-edge at every zoom level.)
        const {scale} = viewport;
        const height = Math.min(this._initialHeight / scale, Math.max(120 / scale, viewport.height - 16 / scale));
        this._container.style.width = `${width}px`;
        this._container.style.maxWidth = `${width}px`;
        // Occupy a fixed vertical range: the bar always spans this height and scrolls its
        // content internally, rather than growing with the number of results.
        this._container.style.height = `${height}px`;
        this._container.style.maxHeight = `${height}px`;
        this._container.style.display = 'block';
        this._container.hidden = false;

        const popupHeight = this._container.getBoundingClientRect().height || height;
        // Pin to the edge that keeps the bar clear of the selection: bottom when the
        // selection sits in the upper part of the viewport (room below), top otherwise.
        const sourceRect = this._getBoundingSourceRect(sourceRects);
        const hasArea = sourceRects.length > 0 && sourceRect.right > sourceRect.left && sourceRect.bottom > sourceRect.top;
        const viewportBottom = viewport.top + viewport.height;
        const spaceBelow = viewportBottom - sourceRect.bottom;
        const spaceAbove = sourceRect.top - viewport.top;
        const below = !hasArea || spaceBelow >= popupHeight || spaceBelow >= spaceAbove;
        const top = below ? Math.max(viewport.top, viewportBottom - popupHeight) : viewport.top;
        this._applyPosition(Math.round(viewport.left), Math.round(top));

        const finalRect = this._container.getBoundingClientRect();
        this._frameRect = {
            left: finalRect.left,
            top: finalRect.top,
            right: finalRect.right,
            bottom: finalRect.bottom,
            valid: true,
        };
    }

    /**
     * @param {?import('display').ContentDetails} displayDetails The display content details.
     * @param {import('core').TokenObject} renderToken A token used to detect stale renders.
     * @returns {Promise<void>}
     */
    async _render(displayDetails, renderToken) {
        const contentRoot = await this._ensureRenderer();
        if (this._renderToken !== renderToken) { return; }
        const fragment = document.createDocumentFragment();
        if (displayDetails === null) {
            if (contentRoot.childElementCount === 0) {
                contentRoot.replaceChildren(this._createMessage('No popup content available.'));
            }
            return;
        }

        const {content} = displayDetails;
        const dictionaryEntries = Array.isArray(content?.dictionaryEntries) ? content.dictionaryEntries : [];
        const displayGenerator = this._displayGenerator;
        const displayContentManager = this._displayContentManager;
        if (displayGenerator === null || displayContentManager === null) {
            throw new Error('Renderer not initialized');
        }

        if (dictionaryEntries.length === 0) {
            fragment.appendChild(this._createMessage('No results found.'));
            if (this._renderToken !== renderToken) { return; }
            contentRoot.replaceChildren(fragment);
            return;
        }

        displayContentManager.unloadAll();
        const dictionaryInfo = await this._getDictionaryInfo();
        if (this._renderToken !== renderToken) { return; }
        // Warm the off-page audio player while the user reads, so the first click has less to wait on.
        if (this._audioEnabled) { this._ensureAudioPlayerFrame(); }
        /** @type {[import('dictionary').DictionaryEntry, HTMLElement][]} */
        const rendered = [];
        for (const entry of dictionaryEntries.slice(0, 8)) {
            const node = (
                entry.type === 'kanji' ?
                displayGenerator.createKanjiEntry(entry, dictionaryInfo) :
                displayGenerator.createTermEntry(entry, dictionaryInfo)
            );
            if (entry.type === 'term') { this._wireAudioButtons(entry, node); }
            fragment.appendChild(node);
            rendered.push([entry, node]);
        }
        if (this._renderToken !== renderToken) { return; }
        contentRoot.replaceChildren(fragment);
        // Anki buttons arrive after the entries, as in the full display: each needs an AnkiConnect
        // round trip, and with Anki closed those are slow to fail — the definitions must not wait on them.
        void this._addAnkiActionsAfterRender(rendered, displayDetails, renderToken);
        await displayContentManager.executeMediaRequests();
    }

    /**
     * @param {[import('dictionary').DictionaryEntry, HTMLElement][]} rendered The entries and their nodes, in display order.
     * @param {?import('display').ContentDetails} displayDetails The display content details.
     * @param {import('core').TokenObject} renderToken The render these nodes belong to; a newer render abandons the rest.
     * @returns {Promise<void>}
     */
    async _addAnkiActionsAfterRender(rendered, displayDetails, renderToken) {
        for (const [entry, node] of rendered) {
            if (this._renderToken !== renderToken) { return; }
            try {
                await this._addAnkiActions(entry, node, displayDetails);
            } catch (e) {
                log.error(e);
            }
        }
    }

    /**
     * Wires each headword's (now visible) play-audio button, and the entry header's, to the off-page player. Nodes are replaced
     * wholesale on the next render, so these listeners fall away with them — no explicit removal needed.
     * @param {import('dictionary').TermDictionaryEntry} entry
     * @param {HTMLElement} node
     * @returns {void}
     */
    _wireAudioButtons(entry, node) {
        if (!this._audioEnabled) { return; }
        const {headwords} = entry;
        for (const headwordNode of node.querySelectorAll('.headword')) {
            if (!(headwordNode instanceof HTMLElement)) { continue; }
            const indexString = headwordNode.dataset.index;
            if (typeof indexString !== 'string') { continue; }
            const index = Number.parseInt(indexString, 10);
            if (!Number.isFinite(index) || index < 0 || index >= headwords.length) { continue; }
            const button = headwordNode.querySelector('.action-button[data-action="play-audio"]');
            if (button === null) { continue; }
            const {term, reading} = headwords[index];
            this._addAudioButtonListener(button, term, reading);
        }
        // The entry header carries its own play button; as in the full display, it plays the first headword.
        const entryButton = node.querySelector('.entry-header .action-button[data-action="play-audio"]');
        if (entryButton !== null && headwords.length > 0) {
            const {term, reading} = headwords[0];
            this._addAudioButtonListener(entryButton, term, reading);
        }
    }

    /**
     * @param {Element} button
     * @param {string} term
     * @param {string} reading
     * @returns {void}
     */
    _addAudioButtonListener(button, term, reading) {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._playHeadwordAudio(term, reading);
        }, false);
    }

    /**
     * @param {string} term
     * @param {string} reading
     * @returns {void}
     */
    _playHeadwordAudio(term, reading) {
        if (!this._audioEnabled || this._options === null) { return; }
        this._ensureAudioPlayerFrame();
        /** @type {import('inline-audio-player').PlayParams} */
        const params = {
            id: ++this._audioRequestId,
            term,
            reading,
            sources: this._audioSources,
            language: this._options.general.language,
            volume: this._audioVolume,
            fallbackSoundType: this._audioFallbackSoundType,
        };
        // The frame is created lazily and its module boots asynchronously; hold the newest request
        // until it announces itself, then flush that one (a later click supersedes an earlier pending).
        if (this._audioPlayerReady) {
            this._postAudioPlay(params);
        } else {
            this._pendingAudioPlay = params;
        }
    }

    /** @returns {void} */
    _ensureAudioPlayerFrame() {
        if (this._audioPlayerFrame !== null) { return; }
        const frame = document.createElement('iframe');
        frame.className = 'yomitan-inline-audio-player';
        // Cross-origin (extension-origin) child: WebKit gates its audio behind the `autoplay`
        // Permissions-Policy feature, which defaults to `self`, so delegate it — otherwise a play
        // triggered from the pop-up button in this parent frame is blocked in the child.
        frame.allow = 'autoplay';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.position = 'absolute';
        frame.style.top = '0';
        frame.style.left = '0';
        frame.style.width = '0';
        frame.style.height = '0';
        frame.style.border = '0';
        frame.style.pointerEvents = 'none';
        frame.src = chrome.runtime.getURL('/inline-audio-player.html');
        document.documentElement.appendChild(frame);
        this._audioPlayerFrame = frame;
    }

    /**
     * @param {MessageEvent<unknown>} event
     * @returns {void}
     */
    _onWindowMessage(event) {
        // Match on the extension origin only — no host page can forge it, and only our player frame
        // posts from it. Deliberately NOT `event.source === frame.contentWindow`: in Safari's isolated
        // content-script world that identity check does not hold (the `WindowProxy` from a `message`
        // event is not `===` the one read off the iframe), which silently swallowed the ready signal.
        if (this._audioPlayerFrame === null || event.origin !== this._audioPlayerTargetOrigin) { return; }
        const data = event.data;
        if (data === null || typeof data !== 'object') { return; }
        const message = /** @type {import('inline-audio-player').PlayerOutboundMessage} */ (data);
        if (message.action === 'inlineAudioPlayerReady') {
            this._audioPlayerReady = true;
            const pending = this._pendingAudioPlay;
            if (pending !== null) {
                this._pendingAudioPlay = null;
                this._postAudioPlay(pending);
            }
        }
        // 'inlineAudioPlayerPlayed' is informational — the fallback sound is played in the frame, so
        // there is no button state to update here.
    }

    /**
     * @param {import('inline-audio-player').PlayParams} params
     * @returns {void}
     */
    _postAudioPlay(params) {
        const win = this._audioPlayerFrame !== null ? this._audioPlayerFrame.contentWindow : null;
        if (win === null) { return; }
        win.postMessage({action: 'play', params}, this._audioPlayerTargetOrigin);
    }

    /**
     * @param {import('dictionary').DictionaryEntry} dictionaryEntry The dictionary entry being rendered.
     * @param {HTMLElement} node The rendered entry node.
     * @param {?import('display').ContentDetails} displayDetails The display content details.
     * @returns {Promise<void>}
     */
    async _addAnkiActions(dictionaryEntry, node, displayDetails) {
        const options = this._options;
        if (options === null || !options.anki.enable) { return; }

        const noteActionsContainer = node.querySelector('.note-actions-container');
        if (!(noteActionsContainer instanceof HTMLElement)) { return; }

        const cardFormats = options.anki.cardFormats.filter((cardFormat) => cardFormat.type === dictionaryEntry.type);
        if (cardFormats.length === 0) { return; }

        const template = await this._getAnkiFieldTemplates(options);
        const context = this._createAnkiContext(displayDetails);
        const dictionaryStylesMap = this._ankiNoteBuilder.getDictionaryStylesMap(options.dictionaries);

        for (const [cardFormatIndex, cardFormat] of cardFormats.entries()) {
            if (!cardFormat.deck || !cardFormat.model) { continue; }

            let note;
            try {
                ({note} = await this._ankiNoteBuilder.createNote({
                    dictionaryEntry,
                    cardFormat,
                    context,
                    template,
                    tags: options.anki.tags,
                    duplicateScope: options.anki.duplicateScope,
                    duplicateScopeCheckAllModels: options.anki.duplicateScopeCheckAllModels,
                    resultOutputMode: options.general.resultOutputMode,
                    glossaryLayoutMode: options.general.glossaryLayoutMode,
                    compactTags: options.general.compactTags,
                    mediaOptions: null,
                    requirements: [],
                    dictionaryStylesMap,
                }));
            } catch (e) {
                log.error(e);
                continue;
            }

            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'action-button-container';
            buttonContainer.dataset.cardFormatIndex = `${cardFormatIndex}`;

            const saveButton = this._createInlineActionButton(cardFormat.icon, `Add ${cardFormat.name} note`);
            saveButton.dataset.action = 'save-note';
            saveButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                saveButton.disabled = true;
                try {
                    const noteId = await this._application.api.addAnkiNote(note);
                    if (typeof noteId === 'number' && noteId > 0) {
                        const viewButton = this._createInlineActionButton('view-note', `View ${cardFormat.name} note`);
                        viewButton.dataset.action = 'view-note';
                        viewButton.addEventListener('click', async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            await this._application.api.viewNotes([noteId], options.anki.noteGuiMode, false);
                        }, false);
                        buttonContainer.replaceChildren(viewButton);
                    } else {
                        saveButton.disabled = false;
                    }
                } catch (error) {
                    log.error(error);
                    saveButton.disabled = false;
                }
            }, false);
            buttonContainer.appendChild(saveButton);

            try {
                const [noteInfo] = await this._application.api.getAnkiNoteInfo([note], false);
                const noteIds = Array.isArray(noteInfo?.noteIds) ? noteInfo.noteIds.filter((id) => id !== INVALID_NOTE_ID) : [];
                if (noteIds.length > 0) {
                    const viewButton = this._createInlineActionButton('view-note', `View ${cardFormat.name} note`);
                    viewButton.dataset.action = 'view-note';
                    viewButton.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        await this._application.api.viewNotes(noteIds, options.anki.noteGuiMode, false);
                    }, false);
                    buttonContainer.replaceChildren(viewButton);
                }
            } catch (error) {
                log.error(error);
            }

            noteActionsContainer.appendChild(buttonContainer);
        }
    }

    /**
     * @param {string} icon The icon identifier.
     * @param {string} title The button title.
     * @returns {HTMLButtonElement}
     */
    _createInlineActionButton(icon, title) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button';
        button.title = title;
        const iconNode = document.createElement('span');
        iconNode.className = 'action-icon icon color-icon';
        iconNode.dataset.icon = icon;
        button.appendChild(iconNode);
        return button;
    }

    /**
     * @param {?import('display').ContentDetails} displayDetails The display content details.
     * @returns {import('anki-templates-internal').Context}
     */
    _createAnkiContext(displayDetails) {
        const historyState = (typeof displayDetails?.state === 'object' && displayDetails.state !== null) ? displayDetails.state : {};
        const sentence = (typeof historyState.sentence === 'object' && historyState.sentence !== null) ? historyState.sentence : null;
        const query = typeof displayDetails?.params?.query === 'string' ? displayDetails.params.query : '';
        return {
            url: typeof historyState.url === 'string' ? historyState.url : window.location.href,
            documentTitle: typeof historyState.documentTitle === 'string' ? historyState.documentTitle : document.title,
            query,
            fullQuery: typeof sentence?.text === 'string' ? sentence.text : query,
            sentence: {
                text: typeof sentence?.text === 'string' ? sentence.text : query,
                offset: typeof sentence?.offset === 'number' ? sentence.offset : 0,
            },
        };
    }

    /**
     * @param {import('settings').ProfileOptions} options The profile options.
     * @returns {Promise<string>}
     */
    async _getAnkiFieldTemplates(options) {
        if (typeof options.anki.fieldTemplates === 'string') {
            return options.anki.fieldTemplates;
        }
        if (typeof this._ankiFieldTemplates === 'string') {
            return this._ankiFieldTemplates;
        }
        const dictionaryInfo = await this._getDictionaryInfo();
        const staticTemplates = await this._application.api.getDefaultAnkiFieldTemplates();
        this._ankiFieldTemplates = staticTemplates + getDynamicTemplates(options, dictionaryInfo);
        return this._ankiFieldTemplates;
    }

    /**
     * @param {string} text The message text.
     * @returns {HTMLDivElement}
     */
    _createMessage(text) {
        const node = document.createElement('div');
        node.className = 'inline-message';
        node.textContent = text;
        return node;
    }

    /** @returns {Promise<Element>} */
    async _ensureRenderer() {
        let setupPromise = this._setupPromise;
        if (setupPromise === null) {
            setupPromise = this._setupRenderer();
            this._setupPromise = setupPromise;
        }
        await setupPromise;
        if (this._contentRoot === null) {
            throw new Error('Renderer root not initialized');
        }
        return this._contentRoot;
    }

    /** @returns {Promise<void>} */
    async _setupRenderer() {
        // DisplayContentManager only reads `display.application` and `display.setContent`, so a
        // minimal stub suffices here; cast through `unknown` to satisfy the full Display type.
        const display = /** @type {import('../display/display.js').Display} */ (/** @type {unknown} */ ({
            application: this._application,
            setContent() {},
        }));
        const displayContentManager = new DisplayContentManager(display);
        const displayGenerator = new DisplayGenerator(displayContentManager, null);
        let [materialCss, displayCss, displayPronunciationCss, structuredContentCss] = await Promise.all([
            fetchText('/css/material.css'),
            fetchText('/css/display.css'),
            fetchText('/css/display-pronunciation.css'),
            fetchText('/css/structured-content.css'),
        ]);
        materialCss = this._transformInlineCss(materialCss);
        displayCss = this._transformInlineCss(displayCss);
        displayPronunciationCss = this._transformInlineCss(displayPronunciationCss);
        structuredContentCss = this._transformInlineCss(structuredContentCss);

        const style = document.createElement('style');
        style.textContent = `${materialCss}\n${displayCss}\n${displayPronunciationCss}\n${structuredContentCss}\n${this._getInlineCssOverrides()}`;

        // The user's custom CSS lives in its own node placed AFTER the bundled styles, so its
        // rules win the cascade at equal specificity (matching the standard popup's behavior).
        const customStyle = document.createElement('style');
        customStyle.textContent = this._customCss;
        this._customCssStyleNode = customStyle;

        const dragBar = document.createElement('div');
        dragBar.className = 'yomitan-drag-bar';
        dragBar.innerHTML = `
            <div class="yomitan-drag-title">
                <span class="yomitan-drag-grip">⋮⋮</span>
                <span class="yomitan-drag-name">Yomitan</span>
                <span class="yomitan-drag-hint">drag to move</span>
            </div>
            <button class="yomitan-drag-close" type="button" title="Close">✕</button>
        `;

        const closeButton = dragBar.querySelector('.yomitan-drag-close');
        if (closeButton !== null) {
            closeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.hide(false);
            }, false);
            closeButton.addEventListener('mousedown', (event) => {
                event.stopPropagation();
            }, false);
        }

        dragBar.addEventListener('mousedown', this._onDragStart.bind(this), false);

        const wrapper = document.createElement('div');
        wrapper.className = 'content-outer';
        wrapper.dataset.browser = 'safari';
        wrapper.dataset.theme = 'default';
        wrapper.dataset.outerTheme = 'default';
        wrapper.innerHTML = '<div class="content"><div class="content-scroll contain-overscroll scrollbar"><div class="content-body"><div class="content-body-inner"></div></div></div></div>';

        this._shadow.replaceChildren(style, customStyle, dragBar, wrapper);
        this._contentRoot = wrapper.querySelector('.content-body-inner');
        this._displayGenerator = displayGenerator;
        this._displayContentManager = displayContentManager;
        // `prepare()` loads the display templates (via chrome.runtime.getURL) and updates hotkeys,
        // which is exactly what the inline popup needs; no need to load templates manually.
        await displayGenerator.prepare();
    }

    /** @returns {Promise<import('dictionary-importer').Summary[]>} */
    async _getDictionaryInfo() {
        if (this._dictionaryInfo === null) {
            this._dictionaryInfo = await this._application.api.getDictionaryInfo();
        }
        return this._dictionaryInfo;
    }

    /**
     * @param {?import('settings').OptionsContext} optionsContext
     * @returns {import('settings').OptionsContext}
     */
    _normalizeOptionsContext(optionsContext) {
        return (
            typeof optionsContext === 'object' &&
            optionsContext !== null ?
            optionsContext :
            {current: true}
        );
    }

    /** @returns {void} */
    _updateContainerSize() {
        // Mirror the width/height that `_position`/`_positionFullWidth` would apply, so that
        // re-applying options while the popup is visible (when the visible-popup guard skips
        // repositioning) never leaves the container at an inconsistent size -- e.g. a
        // full-width bar collapsed to popupWidth, or a height that ignores the viewport clamp.
        if (this._displayModeIsFullWidth) {
            const viewport = this._getViewport();
            const {scale} = viewport;
            // Match `_positionFullWidth`: a fixed on-screen height (scaled against pinch-zoom)
            // spanning the visible width.
            const height = Math.min(this._initialHeight / scale, Math.max(120 / scale, viewport.height - 16 / scale));
            this._container.style.width = `${viewport.width}px`;
            this._container.style.maxWidth = `${viewport.width}px`;
            this._container.style.minHeight = '0';
            this._container.style.height = `${height}px`;
            this._container.style.maxHeight = `${height}px`;
            return;
        }
        const savedW = this._savedSize?.width ?? this._initialWidth;
        const savedH = this._savedSize?.height ?? this._initialHeight;
        const width = Math.min(Math.max(savedW, 240), window.innerWidth - 16);
        const height = Math.min(Math.max(savedH, 180), window.innerHeight - 16);
        this._container.style.width = `${width}px`;
        this._container.style.maxWidth = '90vw';
        this._container.style.minWidth = '240px';
        this._container.style.minHeight = '180px';
        this._container.style.height = `${height}px`;
        this._container.style.maxHeight = '90vh';
    }

    /**
     * Returns the bounding rectangle of the game window in viewport DOM coordinates.
     * If the bridge has provided `window.__bridgeGameBounds`, uses that.
     * Otherwise defaults to the full viewport window.
     * @returns {{x: number, y: number, w: number, h: number}}
     */
    _getGameBounds() {
        let bridgeBounds = /** @type {any} */ (window).__bridgeGameBounds;
        if (!bridgeBounds && document.documentElement && document.documentElement.dataset.gameBounds) {
            try {
                bridgeBounds = JSON.parse(document.documentElement.dataset.gameBounds);
            } catch (e) {
                // ignore
            }
        }
        if (
            typeof bridgeBounds === 'object' &&
            bridgeBounds !== null &&
            typeof bridgeBounds.x === 'number' &&
            typeof bridgeBounds.y === 'number' &&
            typeof bridgeBounds.w === 'number' &&
            typeof bridgeBounds.h === 'number' &&
            bridgeBounds.w > 300 &&
            bridgeBounds.h > 200
        ) {
            return {
                x: Math.max(0, bridgeBounds.x),
                y: Math.max(0, bridgeBounds.y),
                w: Math.min(window.innerWidth - Math.max(0, bridgeBounds.x), bridgeBounds.w),
                h: Math.min(window.innerHeight - Math.max(0, bridgeBounds.y), bridgeBounds.h),
            };
        }
        return {
            x: 0,
            y: 0,
            w: window.innerWidth,
            h: window.innerHeight,
        };
    }

    /** @returns {Promise<void>} */
    async _ensurePositionLoaded() {
        if (this._positionLoaded) { return; }
        this._positionLoaded = true;
        const key = this._getPositionStorageKey();
        const sizeKey = this._getSizeStorageKey();
        const store = /** @type {{[key: string]: unknown}} */ (await new Promise((resolve) => {
            chrome.storage.local.get([key, sizeKey], (result) => {
                resolve(result);
            });
        }));
        const bounds = this._getGameBounds();
        const value = store[key];
        if (
            typeof value === 'object' &&
            value !== null &&
            'left' in value && typeof value.left === 'number' &&
            'top' in value && typeof value.top === 'number'
        ) {
            // Must be within game bounds and below menu safe zone
            if (value.top >= 38 && value.left >= bounds.x && value.left <= bounds.x + bounds.w - 100 &&
                value.top <= bounds.y + bounds.h - 80) {
                this._savedPosition = {left: value.left, top: value.top};
            } else {
                this._savedPosition = null;
            }
        }
        const sizeValue = store[sizeKey];
        if (
            typeof sizeValue === 'object' &&
            sizeValue !== null &&
            'width' in sizeValue && typeof sizeValue.width === 'number' &&
            'height' in sizeValue && typeof sizeValue.height === 'number'
        ) {
            if (sizeValue.width >= 200 && sizeValue.width <= Math.min(800, bounds.w - 20) &&
                sizeValue.height >= 160 && sizeValue.height <= Math.min(800, bounds.h - 20)) {
                this._savedSize = {width: sizeValue.width, height: sizeValue.height};
            } else {
                this._savedSize = null;
            }
        }
    }

    /** @returns {Promise<void>} */
    async _savePosition() {
        if (this._lastPosition === null) { return; }
        const key = this._getPositionStorageKey();
        const value = {left: this._lastPosition.left, top: this._lastPosition.top};
        this._savedPosition = value;
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
            chrome.storage.local.set({[key]: value}, () => resolve());
        }));
    }

    /** @returns {string} */
    _getSizeStorageKey() {
        const host = window.location.hostname || 'default';
        return `popupInlineSize:${host}`;
    }

    /** @returns {Promise<void>} */
    async _saveSize() {
        if (this._savedSize === null) { return; }
        const key = this._getSizeStorageKey();
        const value = {width: this._savedSize.width, height: this._savedSize.height};
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
            chrome.storage.local.set({[key]: value}, () => resolve());
        }));
    }

    /** @returns {string} */
    _getPositionStorageKey() {
        const host = window.location.hostname || 'default';
        return `popupInlinePosition:${host}`;
    }

    /**
     * @param {import('popup').Rect[]} sourceRects
     * @param {number} width
     * @param {number} height
     * @returns {{left: number, top: number}}
     */
    _getSourcePosition(sourceRects, width, height) {
        const sourceRect = this._getBoundingSourceRect(sourceRects);
        const hasArea = sourceRect.right > sourceRect.left && sourceRect.bottom > sourceRect.top;
        if (sourceRects.length === 0 || !hasArea) {
            return this._getDefaultPosition(width, height);
        }
        const gap = 5;
        const spaceBelow = window.innerHeight - sourceRect.bottom;
        const top = (spaceBelow >= height + gap || spaceBelow >= sourceRect.top) ?
            sourceRect.bottom + gap :
            sourceRect.top - gap - height;
        return this._clampPosition(sourceRect.left, top);
    }

    /**
     * @param {number} width
     * @param {number} height
     * @returns {{left: number, top: number}}
     */
    _getDefaultPosition(width, height) {
        return this._clampPosition(
            window.innerWidth - width - 16,
            Math.round((window.innerHeight - height) / 2),
        );
    }

    /**
     * @param {number} width
     * @param {number} height
     * @returns {{left: number, top: number}}
     */
    _getDefaultFixedPosition(width, height) {
        const bounds = this._getGameBounds();
        const padding = 24;
        const left = bounds.x + bounds.w - width - padding;
        const top = bounds.y + padding;
        return this._clampPosition(left, top);
    }

    /**
     * @param {number} left
     * @param {number} top
     * @returns {{left: number, top: number}}
     */
    _clampPosition(left, top) {
        const bounds = this._getGameBounds();
        const rect = this._container.getBoundingClientRect();
        const width = (rect.width > 0 ? rect.width : (this._savedSize?.width || this._initialWidth || 360));
        const height = (rect.height > 0 ? rect.height : (this._savedSize?.height || this._initialHeight || 420));
        const margin = 8;
        const minTopMargin = 40;

        const minX = bounds.x + margin;
        const maxX = Math.max(minX, bounds.x + bounds.w - width - margin);
        const minY = Math.max(minTopMargin, bounds.y + margin);
        const maxY = Math.max(minY, bounds.y + bounds.h - height - margin);

        return {
            left: Math.max(minX, Math.min(Math.round(left), maxX)),
            top: Math.max(minY, Math.min(Math.round(top), maxY)),
        };
    }

    /**
     * @param {number} left
     * @param {number} top
     * @returns {void}
     */
    _applyPosition(left, top) {
        this._lastPosition = {left, top};
        this._container.style.left = `${left}px`;
        this._container.style.top = `${top}px`;
    }

    /**
     * @param {string} css The raw CSS text.
     * @returns {string}
     */
    _transformInlineCss(css) {
        const extensionRoot = chrome.runtime.getURL('/');
        return css
            .replaceAll("url('/", `url('${extensionRoot}`)
            .replaceAll('url("/', `url("${extensionRoot}`)
            // Unquoted root-relative urls, e.g. material.css's `url(/images/kebab-menu.svg)`.
            // Without this they resolve against the host page's origin and 404 in the inline
            // popup (which runs in the page context), leaving broken/missing action icons.
            .replaceAll('url(/', `url(${extensionRoot}`)
            .replaceAll(':root', ':host')
            .replaceAll('html[data-page-type=popup]', ':host')
            .replaceAll('html[data-page-type="popup"]', ':host')
            .replaceAll('body', '.content-outer');
    }

    /** @returns {string} */
    _getInlineCssOverrides() {
        return `
:host([hidden]) {
    display: none !important;
}
:host {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
}
::-webkit-resizer {
    background-color: rgba(156, 163, 175, 0.4);
    border-top-left-radius: 4px;
}
.yomitan-drag-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 30px;
    padding: 0 10px;
    background: var(--sidebar-background-color, #f3f4f6);
    color: var(--text-color, #374151);
    border-bottom: 1px solid var(--light-border-color, rgba(0, 0, 0, 0.12));
    border-top-left-radius: 9px;
    border-top-right-radius: 9px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    flex-shrink: 0;
    box-sizing: border-box;
}
.yomitan-drag-bar:active {
    cursor: grabbing;
}
.yomitan-drag-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: inherit;
    pointer-events: none;
}
.yomitan-drag-grip {
    font-size: 14px;
    color: #9ca3af;
    letter-spacing: -1px;
}
.yomitan-drag-hint {
    font-size: 11px;
    font-weight: normal;
    color: #9ca3af;
    margin-left: 2px;
}
.yomitan-drag-close {
    background: transparent;
    border: none;
    font-size: 13px;
    color: inherit;
    opacity: 0.65;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}
.yomitan-drag-close:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.08);
}
.content-outer {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow: hidden !important;
    background: var(--background-color, #ffffff);
    color: var(--text-color, #111827);
    width: 100% !important;
    height: auto !important;
    border-bottom-left-radius: 9px;
    border-bottom-right-radius: 9px;
}
.content {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow: hidden !important;
    position: static !important;
    height: auto !important;
}
.content-scroll {
    position: static !important;
    display: block !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    padding: 12px 14px 16px 14px;
    box-sizing: border-box;
}
.content-body {
    position: static !important;
    height: auto !important;
    padding: 0;
    overflow: visible !important;
}
.content-body-inner {
    display: block !important;
    position: static !important;
    padding: 0;
    overflow: visible !important;
}
.entry {
    margin: 0;
    border: 0;
    box-shadow: none;
    content-visibility: visible !important;
    contain: none !important;
    contain-intrinsic-height: auto !important;
    visibility: visible !important;
    opacity: 1 !important;
}
.entry * {
    visibility: visible;
}
.entry + .entry {
    border-top: 1px solid var(--light-border-color);
}
:host(:not([data-audio-enabled="true"])) .headword-list .headword-details > .action-button[data-action="play-audio"] {
    display: none !important;
}
.entry-current-indicator,
.entry-current-indicator-icon,
.action-popup-menu-button,
.action-popup-button,
.action-button-badge,
.headword-current-indicator,
.entry .expansion-button {
    display: none !important;
}
.entry-header,
.entry-body,
.kanji-glyph-data {
    padding-right: 0 !important;
}
.entry-body-section:first-child,
.entry-body-section[data-section-type="pronunciations"] {
    display: none;
}
.headword-list-tag-list,
.tag-list {
    margin-top: 0.3em;
}
.gloss-sc-table-container {
    overflow-x: auto;
}
.inline-message {
    padding: 0.72em;
    color: var(--text-color);
}
`;
    }

    /**
     * Returns the visible viewport in client coordinates. Falls back to the layout
     * viewport when the `visualViewport` API is unavailable. Under pinch-zoom the visual
     * viewport is a (possibly offset) subset of the layout viewport, which is what a
     * `position: fixed` element is measured against.
     * @returns {{left: number, top: number, width: number, height: number, scale: number}}
     */
    _getViewport() {
        const {visualViewport} = window;
        if (typeof visualViewport !== 'undefined' && visualViewport !== null) {
            return {
                left: visualViewport.offsetLeft,
                top: visualViewport.offsetTop,
                width: visualViewport.width,
                height: visualViewport.height,
                scale: visualViewport.scale || 1,
            };
        }
        return {left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, scale: 1};
    }

    /**
     * Shifts client rects into the coordinate space used to place `position: fixed` elements.
     * On Safari, `Range.getClientRects()` is reported relative to the visual viewport, while a
     * `position: fixed` element is laid out relative to the layout viewport; the two diverge
     * under pinch-zoom. Adding the visual-viewport offset keeps a fixed popup anchored to the
     * selection as the user zooms and pans. This is a no-op at the default (unzoomed) offset.
     * @param {import('popup').Rect[]} sourceRects
     * @returns {import('popup').Rect[]}
     */
    _toFixedRects(sourceRects) {
        const {left, top} = this._getViewport();
        if (left === 0 && top === 0) { return sourceRects; }
        return sourceRects.map((rect) => ({
            left: rect.left + left,
            top: rect.top + top,
            right: rect.right + left,
            bottom: rect.bottom + top,
        }));
    }

    /**
     * @param {import('popup').Rect[]} sourceRects
     * @returns {import('popup').Rect}
     */
    _getBoundingSourceRect(sourceRects) {
        switch (sourceRects.length) {
            case 0: return {left: 0, top: 0, right: 0, bottom: 0};
            case 1: return sourceRects[0];
        }
        let {left, top, right, bottom} = sourceRects[0];
        for (let i = 1; i < sourceRects.length; ++i) {
            const sourceRect = sourceRects[i];
            left = Math.min(left, sourceRect.left);
            top = Math.min(top, sourceRect.top);
            right = Math.max(right, sourceRect.right);
            bottom = Math.max(bottom, sourceRect.bottom);
        }
        return {left, top, right, bottom};
    }
}
