/*
 * Copyright (C) 2024-2025  Yomitan Authors
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

import {readResponseJson} from './json.js';

/**
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchAsset(url) {
    // Use CORS mode rather than 'no-cors'. The Safari inline popup runs in the host
    // page's context, so fetching an extension asset is cross-origin there; 'no-cors'
    // would return an opaque response (status 0, ok false) and fail. CORS mode is
    // equivalent for the same-origin extension-page contexts the other callers use.
    const response = await fetch(chrome.runtime.getURL(url), {
        method: 'GET',
        mode: 'cors',
        cache: 'default',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
    });
    if (response.type === 'opaque' || response.status === 0) {
        // An opaque response (status 0) means this was a cross-origin fetch made with
        // mode: 'no-cors'. The usual cause is fetching an extension asset from a context
        // that is NOT an extension-origin page -- most notably the Safari inline popup,
        // which runs in the host page's content-script context. Use mode: 'cors'.
        throw new Error(`Failed to fetch ${url}: opaque response (status 0). This is a cross-origin fetch made with mode:'no-cors' (e.g. an extension asset fetched from the Safari inline popup, which runs in the page context). Use mode:'cors'.`);
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response;
}


/**
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchText(url) {
    const response = await fetchAsset(url);
    return await response.text();
}

/**
 * @template [T=unknown]
 * @param {string} url
 * @returns {Promise<T>}
 */
export async function fetchJson(url) {
    const response = await fetchAsset(url);
    return await readResponseJson(response);
}
