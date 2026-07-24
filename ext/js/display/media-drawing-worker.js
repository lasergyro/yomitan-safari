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

import {API} from '../comm/api.js';
import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';
import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {safePerformance} from '../core/safe-performance.js';
import {WebExtension} from '../extension/web-extension.js';
import {initWasm, Resvg} from '../../lib/resvg-wasm.js';

/**
 * Draws dictionary images into the `OffscreenCanvas`es the display transfers in.
 *
 * **This worker now does the decoding itself.** It used to hold a `MessagePort` to the IndexedDB
 * dictionary worker, which owned the data, decoded each image, and posted pixel buffers back — a
 * round trip that existed only because the bytes lived in a different thread. With the store in the
 * native app the bytes arrive over the extension API like any other query result, so fetching,
 * decoding and painting all happen here.
 *
 * That collapses the awkward part of the old design: the buffers no longer cross a worker boundary
 * after decoding, so neither the `ImageDecoder`-vs-`createImageBitmap` split nor the
 * draw-to-a-temporary-canvas dance (both worked around what Firefox could transfer between
 * processes) is needed. `createImageBitmap` here and draw straight onto the canvas.
 */
export class MediaDrawingWorker {
    constructor() {
        /** @type {number} */
        this._generation = 0;

        /** @type {import('api').PmApiMap} */
        this._fromApplicationApiMap = createApiMap([
            ['drawMedia', this._onDrawMedia.bind(this)],
        ]);

        /** @type {Map<number, OffscreenCanvas[]>} */
        this._canvasesByGeneration = new Map();

        /** @type {API} */
        this._api = new API(new WebExtension());

        /**
         * resvg's WASM module and the font it substitutes for text in SVGs, loaded once on first
         * use. Deferred rather than loaded in `prepare()` because most lookups draw no SVG at all,
         * and this is ~1 MB of WASM plus a font.
         * @type {?Promise<void>}
         */
        this._svgSupportPromise = null;
        /** @type {?Uint8Array} */
        this._resvgFontBuffer = null;
    }

    /** @returns {Promise<void>} */
    async prepare() {
        addEventListener('message', (event) => {
            /** @type {import('api').PmApiMessageAny} */
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const message = event.data;
            return invokeApiMapHandler(this._fromApplicationApiMap, message.action, message.params, [event.ports], () => {});
        });
        addEventListener('messageerror', (event) => {
            const error = new ExtensionError('MediaDrawingWorker: Error receiving message from application');
            error.data = event;
            log.error(error);
        });
    }

    /** @type {import('api').PmApiHandler<'drawMedia'>} */
    async _onDrawMedia({requests}) {
        safePerformance.mark('drawMedia:start');
        this._generation++;
        const generation = this._generation;
        this._canvasesByGeneration.set(generation, requests.map((request) => request.canvas));
        this._cleanOldGenerations();

        // Several requests routinely name the same image at the same size (the same word appearing
        // in more than one entry), so they are grouped and the bytes fetched and decoded once.
        /** @type {Map<string, {path: string, dictionary: string, canvasIndexes: number[], canvasWidth: number, canvasHeight: number}>} */
        const grouped = new Map();
        for (let i = 0, ii = requests.length; i < ii; ++i) {
            const {path, dictionary, canvas} = requests[i];
            const key = `${path}:::${dictionary}`;
            let group = grouped.get(key);
            if (typeof group === 'undefined') {
                group = {path, dictionary, canvasIndexes: [], canvasWidth: canvas.width, canvasHeight: canvas.height};
                grouped.set(key, group);
            }
            group.canvasIndexes.push(i);
        }

        const groups = [...grouped.values()];
        /** @type {import('api').ApiReturn<'getMedia'>} */
        let media;
        try {
            media = await this._api.getMedia(groups.map(({path, dictionary}) => ({path, dictionary})));
        } catch (e) {
            log.error(e);
            return;
        }

        safePerformance.mark('drawMedia:draw:start');
        for (let i = 0, ii = media.length; i < ii; ++i) {
            const group = groups[i];
            if (typeof group === 'undefined') { continue; }
            try {
                await this._drawOne(media[i], group, generation);
            } catch (e) {
                log.error(e);
            }
        }
        safePerformance.mark('drawMedia:draw:end');
        safePerformance.measure('drawMedia:draw', 'drawMedia:draw:start', 'drawMedia:draw:end');
        safePerformance.mark('drawMedia:end');
        safePerformance.measure('drawMedia', 'drawMedia:start', 'drawMedia:end');
    }

    /**
     * @param {import('dictionary-database').MediaDataStringContent} item
     * @param {{canvasIndexes: number[], canvasWidth: number, canvasHeight: number}} group
     * @param {number} generation
     * @returns {Promise<void>}
     */
    async _drawOne(item, group, generation) {
        const canvases = this._canvasesByGeneration.get(generation);
        if (typeof canvases === 'undefined') { return; }
        const content = base64ToArrayBuffer(item.content);
        if (item.mediaType === 'image/svg+xml') {
            await this._prepareSvgSupport();
            /** @type {import('@resvg/resvg-wasm').ResvgRenderOptions} */
            const options = {
                fitTo: {mode: 'width', value: group.canvasWidth},
                font: {fontBuffers: this._resvgFontBuffer !== null ? [this._resvgFontBuffer] : []},
            };
            const render = new Resvg(new Uint8Array(content), options).render();
            const imageData = new ImageData(new Uint8ClampedArray(render.pixels.buffer), render.width, render.height);
            for (const index of group.canvasIndexes) {
                canvases[index]?.getContext('2d')?.putImageData(imageData, 0, 0);
            }
            return;
        }
        const bitmap = await createImageBitmap(
            new Blob([content], {type: item.mediaType}),
            {resizeWidth: group.canvasWidth, resizeHeight: group.canvasHeight, resizeQuality: 'high'},
        );
        for (const index of group.canvasIndexes) {
            const canvas = canvases[index];
            canvas?.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        }
        bitmap.close();
    }

    /**
     * Loads resvg and its fallback font, once.
     * @returns {Promise<void>}
     */
    _prepareSvgSupport() {
        if (this._svgSupportPromise === null) {
            this._svgSupportPromise = (async () => {
                await initWasm(fetch('/lib/resvg.wasm'));
                const font = await fetch('/fonts/NotoSansJP-Regular.ttf');
                this._resvgFontBuffer = new Uint8Array(await font.arrayBuffer());
            })();
        }
        return this._svgSupportPromise;
    }

    /**
     * @param {number} keepNGenerations Number of generations to keep, defaults to 2 (the current generation and the one before it).
     */
    _cleanOldGenerations(keepNGenerations = 2) {
        const generations = [...this._canvasesByGeneration.keys()];
        for (const g of generations) {
            if (g <= this._generation - keepNGenerations) {
                this._canvasesByGeneration.delete(g);
            }
        }
    }
}

const mediaDrawingWorker = new MediaDrawingWorker();
await mediaDrawingWorker.prepare();
