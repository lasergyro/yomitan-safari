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

import {querySelectorNotNull} from '../../dom/query-selector.js';

export class StorageController {
    /**
     * @param {import('./persistent-storage-controller.js').PersistentStorageController} persistentStorageController
     */
    constructor(persistentStorageController) {
    /** @type {import('./persistent-storage-controller.js').PersistentStorageController} */
        this._persistentStorageController = persistentStorageController;
        /** @type {boolean} */
        this._isUpdating = false;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUsageNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseFiniteNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseValidNodes = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._storageUseInvalidNodes = null;
    }

    /** */
    prepare() {
        this._storageUsageNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-usage'));
        this._storageUseFiniteNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-finite'));
        this._storageUseValidNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-valid'));
        this._storageUseInvalidNodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.storage-use-invalid'));
        /** @type {HTMLButtonElement} */
        const storageRefreshButton = querySelectorNotNull(document, '#storage-refresh');

        storageRefreshButton.addEventListener('click', this._onStorageRefreshButtonClick.bind(this), false);
        this._persistentStorageController.application.on('storageChanged', this._onStorageChanged.bind(this));

        void this._updateStats();
    }

    // Private

    /** */
    _onStorageRefreshButtonClick() {
        void this._updateStats();
    }

    /** */
    _onStorageChanged() {
        void this._updateStats();
    }

    /**
     * The "Storage" figure is the size of the dictionary database file in the app container, not
     * `navigator.storage.estimate()`. The engine moved into the native app, so the dictionaries no
     * longer live in the extension origin the estimate measures (plan/native-rewrite.md → Storage
     * location) — the old figure reported the near-empty origin and had nothing to do with the
     * installed dictionaries. There is no meaningful quota for a file in the container beyond the
     * disk, so only a usage figure is shown.
     */
    async _updateStats() {
        if (this._isUpdating) { return; }

        try {
            this._isUpdating = true;

            const databaseBytes = await this._databaseBytes();
            const valid = (databaseBytes !== null);
            if (valid) {
                const usageString = this._bytesToLabeledString(databaseBytes);
                for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._storageUsageNodes)) {
                    node.textContent = usageString;
                }
            }

            this._setElementsVisible(this._storageUseFiniteNodes, valid);
            this._setElementsVisible(this._storageUseValidNodes, valid);
            this._setElementsVisible(this._storageUseInvalidNodes, !valid);
        } finally {
            this._isUpdating = false;
        }
    }

    /**
     * @returns {Promise<?number>} The database file size in bytes, or `null` if the app extension
     *   could not be reached.
     */
    async _databaseBytes() {
        try {
            const {databaseBytes} = await this._persistentStorageController.application.api.getDictionaryDatabaseSize();
            return typeof databaseBytes === 'number' ? databaseBytes : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * @param {number} size
     * @returns {string}
     */
    _bytesToLabeledString(size) {
        const base = 1000;
        const labels = [' bytes', 'KB', 'MB', 'GB', 'TB'];
        const maxLabelIndex = labels.length - 1;
        let labelIndex = 0;
        while (size >= base && labelIndex < maxLabelIndex) {
            size /= base;
            ++labelIndex;
        }
        const label = labelIndex === 0 ? `${size}` : size.toFixed(1);
        return `${label}${labels[labelIndex]}`;
    }

    /**
     * @param {?NodeListOf<HTMLElement>} elements
     * @param {boolean} visible
     */
    _setElementsVisible(elements, visible) {
        if (elements === null) { return; }
        visible = !visible;
        for (const element of elements) {
            element.hidden = visible;
        }
    }
}
