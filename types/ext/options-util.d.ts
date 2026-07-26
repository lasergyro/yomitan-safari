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

import type * as Core from './core';

export type LegacyOptions = Core.SafeAny;

export type IntermediateOptions = Core.SafeAny;

export type LegacyUpdateFunction = (options: LegacyOptions) => void;

export type UpdateFunction = (options: IntermediateOptions) => void | Promise<void>;

/**
 * Where `OptionsUtil` persists the serialized options. The extension backs this with the native app
 * container (`NativeOptionsStore`); tests inject a fake. `load` returns `null` when the store holds
 * nothing yet.
 */
export type OptionsStorage = {
    load(): Promise<string | null>;
    save(optionsJson: string): Promise<void>;
};

export type TemplateFieldUpdate = {
    version: number;
    changes: string;
};
