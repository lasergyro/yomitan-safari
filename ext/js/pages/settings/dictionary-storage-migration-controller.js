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

import {log} from '../../core/log.js';
import {USE_SQLITE_BACKEND} from '../../dictionary/dictionary-backend-config.js';
import {deleteLegacyIndexedDbDictionary, legacyIndexedDbDictionaryExists} from '../../dictionary/sqlite/dictionary-storage-migration.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

/**
 * Drives the one-time migration off the legacy IndexedDB `dict` store when the SQLite backend is
 * live (see plan/design.md → Migration). The SQLite backend uses a fresh OPFS file and never reads
 * the old IndexedDB, so a user upgrading into it keeps a full, now-unused copy of their dictionaries
 * in IndexedDB. This controller surfaces a notification asking them to re-import (through the normal
 * dictionary UI just below), and a button to reclaim the old copy once they have.
 *
 * While `USE_SQLITE_BACKEND` is off the whole thing is inert: the legacy store *is* the live store,
 * so there is nothing to migrate away from and the notification stays hidden.
 */
export class DictionaryStorageMigrationController {
    /**
     * @param {import('../../application.js').Application} application
     * @param {import('./modal-controller.js').ModalController} modalController
     */
    constructor(application, modalController) {
        /** @type {import('../../application.js').Application} */
        this._application = application;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {HTMLElement} */
        this._notification = querySelectorNotNull(document, '#dictionary-legacy-storage-notification');
        /** @type {HTMLButtonElement} */
        this._deleteButton = querySelectorNotNull(document, '#dictionary-legacy-storage-delete-button');
    }

    /** */
    async prepare() {
        if (!USE_SQLITE_BACKEND) { return; }

        this._deleteButton.addEventListener('click', this._onDeleteButtonClick.bind(this), false);
        /** @type {HTMLButtonElement} */
        const confirmButton = querySelectorNotNull(document, '#dictionary-legacy-storage-confirm-delete-button');
        confirmButton.addEventListener('click', this._onConfirmDelete.bind(this), false);

        await this._updateVisibility();
    }

    // Private

    /** */
    async _updateVisibility() {
        let exists = false;
        try {
            exists = await legacyIndexedDbDictionaryExists();
        } catch (e) {
            log.error(e);
        }
        this._notification.hidden = !exists;
    }

    /** */
    _onDeleteButtonClick() {
        const modal = this._modalController.getModal('dictionary-legacy-storage-confirm-delete');
        if (modal === null) { return; }
        modal.setVisible(true);
    }

    /** */
    _onConfirmDelete() {
        void this._deleteLegacyStorage();
    }

    /** */
    async _deleteLegacyStorage() {
        this._deleteButton.disabled = true;
        try {
            await deleteLegacyIndexedDbDictionary();
        } catch (e) {
            log.error(e);
        } finally {
            this._deleteButton.disabled = false;
        }
        // Hide the notification once the old copy is gone, and refresh the storage figures so the
        // reclaimed space shows up.
        await this._updateVisibility();
        this._application.triggerStorageChanged();
    }
}
