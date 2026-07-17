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
 * Schema version for the SQLite dictionary backend, stored in `PRAGMA user_version`. Bump when the
 * DDL below changes and add the corresponding step to `migrateDictionarySchema`, which runs on open.
 *
 * 1. Initial columnar schema.
 * 2. Dropped `ix_terms_dictionary`; `ix_terms_reading` became partial (`WHERE reading <> ''`).
 *    See plan/02-decisions.md #28.
 * 3. Added `dictionaries.inflection_table`. See plan/02-decisions.md #31.
 * 4. Added `dictionaries.stub_template`, which is also the "derivable rows were dropped" flag.
 *    See plan/02-decisions.md #34.
 * 5. `ix_terms_reading` predicate `reading <> ''` → `reading <> expression`. The `''` form excluded
 *    nothing (the importer rewrites an empty reading to the expression), so it saved nothing; the new
 *    form indexes only rows a reading probe can actually contribute. See plan/02-decisions.md #35/#36.
 */
export const DICTIONARY_SQLITE_SCHEMA_VERSION = 5;

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
    codec_dict   BLOB,
    -- Inflection rules induced from this dictionary's own form-of entries, encoded through the same
    -- codec as the payloads. Stored as one blob rather than as rows because it only pays for itself
    -- compressed: 1.42 MB deflated at a 1,000-rule budget on kty-de-en, against ~11-15 MB as SQLite
    -- rows. Null when the dictionary has no form-of entries to induce from. See decisions #31.
    inflection_table BLOB,
    -- The payload every dropped form-of row shared, minus its glossary: on kty-de-en all 852,139
    -- stub rows carry byte-identical definitionTags/rules/score/termTags, so one copy reproduces the
    -- rows the query path synthesizes back. A row whose fields differ from this is kept instead.
    --
    -- Doubles as the flag for "rows really were dropped": non-null is the ONLY thing that licenses
    -- findTermsBulk to synthesize. A v3 database has an inflection_table but every row still stored,
    -- so keying synthesis off the table alone would return every deinflection twice. See #34.
    stub_template BLOB
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
-- Partial on \`reading <> expression\`, NOT \`reading <> ''\`. The importer rewrites an empty reading to
-- the expression (dictionary-importer.js: \`reading = reading.length > 0 ? reading : expression\`), so
-- on a German dictionary every one of ~947k rows has reading = expression and NONE has reading = '' --
-- a \`<> ''\` predicate would exclude nothing and index all 947k rows (~25.67 MB of a column the
-- expression index already covers). \`<> expression\` indexes only the rows a reading probe can
-- actually contribute: findTermsBulk probes expression first and dedups by id, so a row whose reading
-- equals its expression is always already found by the expression probe. On German that is 0 rows (an
-- empty index); on Japanese it is exactly the rows with a distinct reading. The reading probe in
-- _queryTermColumn MUST carry the literal \`AND reading <> expression\` or SQLite cannot use this index
-- -- with INDEXED BY it fails outright with "no query solution". See plan/02-decisions.md #35/#36.
CREATE INDEX IF NOT EXISTS ix_terms_reading    ON terms(reading) WHERE reading <> expression;
-- Serves both the sequence lookup and, on its dictionary_id prefix, the per-dictionary count and
-- delete. A separate ix_terms_dictionary(dictionary_id) would be a strict prefix-duplicate of this.
CREATE INDEX IF NOT EXISTS ix_terms_sequence   ON terms(dictionary_id, sequence);

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
 * Brings an existing database up to `DICTIONARY_SQLITE_SCHEMA_VERSION`, then creates anything still
 * missing and records the version. Idempotent, and safe on a fresh database (`user_version` is 0 and
 * every step below is a no-op against empty schema).
 *
 * Migrations run **before** the DDL because `CREATE ... IF NOT EXISTS` will not alter an object that
 * already exists — an index whose definition changed has to be dropped here or the create silently
 * keeps the old one.
 * @param {import('sqlite-wasm').SqliteDatabaseHandle} db
 * @returns {void}
 */
export function createDictionarySchema(db) {
    const version = Number(db.selectValue('PRAGMA user_version'));
    if (version < 2) {
        // v1 -> v2: ix_terms_dictionary is redundant with ix_terms_sequence's leading column, and
        // ix_terms_reading is recreated below as a partial index. Both are index-only changes, so
        // this rebuilds them in place and keeps the imported data — no re-import.
        db.exec('DROP INDEX IF EXISTS ix_terms_dictionary');
        db.exec('DROP INDEX IF EXISTS ix_terms_reading');
    }
    if (version > 0 && version < 3) {
        // v2 -> v3: `CREATE TABLE IF NOT EXISTS` will not add a column to a table that exists, so an
        // already-created `dictionaries` needs this explicitly. Left null: the rules are induced at
        // import, so an existing dictionary simply keeps every row it already has.
        db.exec('ALTER TABLE dictionaries ADD COLUMN inflection_table BLOB');
    }
    if (version > 0 && version < 4) {
        // v3 -> v4: same reason. Left null, which reads as "this dictionary had no rows dropped" —
        // true of every v3 database, and exactly what stops the query path from synthesizing rows
        // that are still stored.
        db.exec('ALTER TABLE dictionaries ADD COLUMN stub_template BLOB');
    }
    if (version > 0 && version < 5) {
        // v4 -> v5: ix_terms_reading's predicate changed (reading <> '' → reading <> expression), and
        // CREATE INDEX IF NOT EXISTS keeps an index that already exists, so it has to be dropped for
        // the create below to rebuild it. Index-only change — the imported rows are untouched.
        db.exec('DROP INDEX IF EXISTS ix_terms_reading');
    }
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${DICTIONARY_SQLITE_SCHEMA_VERSION}`);
}

/**
 * The set of table names the schema defines, for validation/tests.
 * @type {string[]}
 */
export const DICTIONARY_SQLITE_TABLES = ['dictionaries', 'terms', 'term_meta', 'kanji', 'kanji_meta', 'tag_meta', 'media'];
