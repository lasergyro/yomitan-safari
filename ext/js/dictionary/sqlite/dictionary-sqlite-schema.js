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
 * Schema version for the SQLite dictionary backend. Bump when the DDL below changes; the
 * backend compares it against `PRAGMA user_version` and rebuilds if they differ.
 */
export const DICTIONARY_SQLITE_SCHEMA_VERSION = 1;

/**
 * The dictionary storage schema (see plan/01-design.md §8.1). Columnar tables — no per-row property
 * names; `dictionary_id` is an integer FK instead of the repeated title string; the heavy,
 * non-indexed term fields live compressed in `terms.payload`. Indexed columns
 * (expression/reading/sequence/character/path/name) let SQLite serve every lookup the legacy
 * IndexedDB indexes served.
 * @type {string}
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dictionaries (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL UNIQUE,
    revision     TEXT,
    version      INTEGER,
    summary_json TEXT,
    codec        TEXT,
    codec_dict   BLOB
);

CREATE TABLE IF NOT EXISTS terms (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    expression    TEXT NOT NULL,
    reading       TEXT NOT NULL,
    sequence      INTEGER,
    payload       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_terms_expression ON terms(expression);
CREATE INDEX IF NOT EXISTS ix_terms_reading    ON terms(reading);
CREATE INDEX IF NOT EXISTS ix_terms_sequence   ON terms(dictionary_id, sequence);
CREATE INDEX IF NOT EXISTS ix_terms_dictionary ON terms(dictionary_id);

CREATE TABLE IF NOT EXISTS term_meta (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    expression    TEXT NOT NULL,
    mode          TEXT,
    data_json     TEXT
);
CREATE INDEX IF NOT EXISTS ix_term_meta_expression ON term_meta(expression);
CREATE INDEX IF NOT EXISTS ix_term_meta_dictionary ON term_meta(dictionary_id);

CREATE TABLE IF NOT EXISTS kanji (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    character     TEXT NOT NULL,
    payload       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_kanji_character  ON kanji(character);
CREATE INDEX IF NOT EXISTS ix_kanji_dictionary ON kanji(dictionary_id);

CREATE TABLE IF NOT EXISTS kanji_meta (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    character     TEXT NOT NULL,
    mode          TEXT,
    data_json     TEXT
);
CREATE INDEX IF NOT EXISTS ix_kanji_meta_character  ON kanji_meta(character);
CREATE INDEX IF NOT EXISTS ix_kanji_meta_dictionary ON kanji_meta(dictionary_id);

CREATE TABLE IF NOT EXISTS tag_meta (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    name          TEXT NOT NULL,
    category      TEXT,
    sort_order    INTEGER,
    notes         TEXT,
    score         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tag_meta_name       ON tag_meta(name);
CREATE INDEX IF NOT EXISTS ix_tag_meta_dictionary ON tag_meta(dictionary_id);

CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id),
    path          TEXT NOT NULL,
    media_type    TEXT,
    width         INTEGER,
    height        INTEGER,
    content       BLOB
);
CREATE INDEX IF NOT EXISTS ix_media_path       ON media(path);
CREATE INDEX IF NOT EXISTS ix_media_dictionary ON media(dictionary_id);
`;

/**
 * Creates the dictionary schema (idempotent) and records the schema version.
 * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
 * @returns {void}
 */
export function createDictionarySchema(db) {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${DICTIONARY_SQLITE_SCHEMA_VERSION}`);
}

/**
 * The set of table names the schema defines, for validation/tests.
 * @type {string[]}
 */
export const DICTIONARY_SQLITE_TABLES = ['dictionaries', 'terms', 'term_meta', 'kanji', 'kanji_meta', 'tag_meta', 'media'];
