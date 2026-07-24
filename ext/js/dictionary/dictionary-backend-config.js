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

/**
 * Feature flag for the native engine (plan/native-rewrite.md). When `true`, the extension holds no
 * dictionary storage at all: every query crosses `sendNativeMessage` to the same SQLite engine
 * hosted in JavaScriptCore inside the Safari app extension, reading a database in the app container.
 *
 * This is what answers the blocker in plan/safari-opfs-blocker.md — Safari rotates the extension
 * origin on every launch, so OPFS data is stranded each restart, while the app container is keyed by
 * bundle identifier and is not. It also takes the WASM heap, the single-connection worker handoff
 * and the in-browser importer out of the extension in one move.
 *
 * Safari-only by construction: it needs the app extension on the other end. On any other browser
 * this must stay `false` — there is nothing to talk to.
 * @type {boolean}
 */
export const USE_NATIVE_BACKEND = false;
