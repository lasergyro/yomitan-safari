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

// Minimal hand-written surface for the parts of @sqlite.org/sqlite-wasm's oo1 API that the
// dictionary backend uses. The package ships full types (dist/index.d.mts), but they are large
// and browser-oriented; this narrow interface is enough and keeps the injected-module boundary
// (browser build in the worker, node build in tests) simple.

export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlBind = SqlValue[] | {[key: string]: SqlValue};

export type SqlRow = {[column: string]: SqlValue};

export interface SqliteStatement {
    bind(index: number, value: SqlValue): SqliteStatement;
    bind(value: SqlValue | SqlBind): SqliteStatement;
    step(): boolean;
    stepReset(): SqliteStatement;
    // `alsoClearBinds` also drops the bound values, so a held statement can be safely rebound.
    reset(alsoClearBinds?: boolean): SqliteStatement;
    get(index: number): SqlValue;
    // Passing a plain object collects the whole row into it, keyed by column name.
    get(target: SqlRow): SqlRow;
    finalize(): number;
}

export interface SqliteDatabaseHandle {
    exec(sql: string): SqliteDatabaseHandle;
    prepare(sql: string): SqliteStatement;
    selectValue(sql: string, bind?: SqlBind): SqlValue;
    selectObject(sql: string, bind?: SqlBind): SqlRow | undefined;
    selectObjects(sql: string, bind?: SqlBind): SqlRow[];
    transaction(callback: (db: SqliteDatabaseHandle) => void): void;
    close(): void;
}

export interface SqliteSAHPool {
    OpfsSAHPoolDb: new (path: string) => SqliteDatabaseHandle;
    unlink(path: string): boolean;
    wipeFiles(): Promise<void>;
    getFileCount(): number;
    // Number of file slots the pool has pre-allocated (not the number in use; see getFileCount).
    getCapacity(): number;
    // Grows the pool to at least `minCapacity` slots if it is currently smaller, else no-op. Safe to
    // call at every startup (unlike addCapacity): the change is persistent, so a pool created small by
    // an older build is healed to the current minimum. Resolves to the resulting capacity.
    reserveMinimumCapacity(minCapacity: number): Promise<number>;
}

export interface Sqlite3Module {
    version: {libVersion: string, sourceId: string};
    oo1: {DB: new (filename?: string) => SqliteDatabaseHandle};
    installOpfsSAHPoolVfs(options: {name?: string, initialCapacity?: number}): Promise<SqliteSAHPool>;
}

export type Sqlite3InitModule = (config?: {[key: string]: unknown}) => Promise<Sqlite3Module>;

export type SqliteVfs = 'opfs' | 'memory';
