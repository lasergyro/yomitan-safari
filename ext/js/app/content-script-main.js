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

import {Application} from '../application.js';
import {HotkeyHandler} from '../input/hotkey-handler.js';
import {Frontend} from './frontend.js';
import {PopupFactory} from './popup-factory.js';

await Application.main(false, async (application) => {
    try {
        document.documentElement.dataset.csMainStep = '1_starting';
        const hotkeyHandler = new HotkeyHandler();
        hotkeyHandler.prepare(application.crossFrame);

        const popupFactory = new PopupFactory(application);
        popupFactory.prepare();
        document.documentElement.dataset.csMainStep = '2_popupFactory_ready';

        const frontend = new Frontend({
            application,
            popupFactory,
            depth: 0,
            parentPopupId: null,
            parentFrameId: null,
            useProxyPopup: false,
            pageType: 'web',
            canUseWindowPopup: true,
            allowRootFramePopupProxy: true,
            childrenSupported: true,
            hotkeyHandler,
        });
        document.documentElement.dataset.csMainStep = '3_frontend_created';
        await frontend.prepare();
        document.documentElement.dataset.csMainStep = '4_frontend_prepared';
        window.__yomitanFrontend = frontend;

        const updateDiagnostics = () => {
            document.documentElement.dataset.yomitanReady = 'true';
            document.documentElement.dataset.scannerEnabled = String(frontend._textScanner?.isEnabled?.());
            document.documentElement.dataset.safariInlineScanEnabled = String(frontend._safariInlineScanEnabled);
            document.documentElement.dataset.isSafariInline = String(frontend._isSafariInlinePopupMode?.());
        };
        updateDiagnostics();
        setInterval(updateDiagnostics, 200);

        document.addEventListener('yomitanBridgeEval', async (e) => {
            const { id, code } = e.detail || {};
            try {
                // eslint-disable-next-line no-eval
                let res = eval(code);
                if (res instanceof Promise) res = await res;
                document.documentElement.dataset['evalRes_' + id] = JSON.stringify({ ok: true, result: res });
            } catch (err) {
                document.documentElement.dataset['evalRes_' + id] = JSON.stringify({ ok: false, error: String(err) });
            }
        });
    } catch (err) {
        document.documentElement.dataset.csMainError = String(err) + ' ' + (err ? err.stack : '');
    }
});
