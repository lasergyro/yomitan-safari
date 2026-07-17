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

import {describe, expect, test} from 'vitest';
import {
    applyInflectionRule,
    buildInflectionTable,
    deriveLemmas,
    induceInflectionRule,
    isDerivable,
} from '../ext/js/dictionary/sqlite/inflection-rules.js';

/**
 * Real `kty-de-en` shapes. The periphrastic and participle cases are the point: they are what a
 * suffix-only rule model cannot express, and they are 55% of the dictionary's form-of rows.
 * @type {{form: string, lemma: string, labels: string[]}[]}
 */
const PAIRS = [
    {form: 'Strolches', lemma: 'Strolch', labels: ['genitive singular']},
    {form: 'Strolchs', lemma: 'Strolch', labels: ['genitive']},
    {form: 'Hochstifte', lemma: 'Hochstift', labels: ['nominative plural']},
    {form: 'Philosophien', lemma: 'Philosophie', labels: ['plural']},
    {form: 'geschützt', lemma: 'schützen', labels: ['past participle']},
    {form: 'geplant', lemma: 'planen', labels: ['past participle']},
    {form: 'würde gegrunzt haben', lemma: 'grunzen', labels: ['future II subjunctive II']},
    {form: 'würde geplant haben', lemma: 'planen', labels: ['future II subjunctive II']},
    {form: 'bin', lemma: 'sein', labels: ['first-person singular present']},
];

describe('inflection rule induction', () => {
    test('models a circumfix as one rule, which a suffix-only model cannot', () => {
        // geschützt/schützen share no prefix at all; the shared core is "schütz".
        const rule = induceInflectionRule('geschützt', 'schützen');
        expect(applyInflectionRule(rule, 'geschützt')).toBe('schützen');
        // The same rule generalizes to every other regular weak participle -- that is the whole point.
        expect(applyInflectionRule(rule, 'geplant')).toBe('planen');
        expect(applyInflectionRule(rule, 'gebellt')).toBe('bellen');
        expect(induceInflectionRule('geplant', 'planen')).toBe(rule);
    });

    test('models a periphrastic phrase as one rule', () => {
        const rule = induceInflectionRule('würde gegrunzt haben', 'grunzen');
        expect(applyInflectionRule(rule, 'würde gegrunzt haben')).toBe('grunzen');
        expect(applyInflectionRule(rule, 'würde geplant haben')).toBe('planen');
        expect(induceInflectionRule('würde geplant haben', 'planen')).toBe(rule);
    });

    test('a plain suffix change carries no prefix', () => {
        const rule = induceInflectionRule('Strolches', 'Strolch');
        expect(applyInflectionRule(rule, 'Strolches')).toBe('Strolch');
        expect(applyInflectionRule(rule, 'Hochstiftes')).toBe('Hochstift');
    });

    test('a pair sharing no core at all falls back to a whole-word rule, matching only itself', () => {
        const rule = induceInflectionRule('abc', 'xyz');
        expect(applyInflectionRule(rule, 'abc')).toBe('xyz');
        expect(applyInflectionRule(rule, 'abcd')).toBeNull();
        expect(applyInflectionRule(rule, 'zabc')).toBeNull();
    });

    test('a near-suppletive pair still finds a core, and over-generates from it', () => {
        // `bin`/`sein` share "in", so this is an affix rule rather than a whole-word one, and it
        // happily turns `bist` into the non-word `seist`. That is expected: rules over-generate by
        // design and correctness comes from the paradigm check, not from the rule.
        const rule = induceInflectionRule('bin', 'sein');
        expect(applyInflectionRule(rule, 'bin')).toBe('sein');
        expect(applyInflectionRule(rule, 'bist')).toBe('seist');
    });

    test('a rule does not apply to a form it does not fit', () => {
        const rule = induceInflectionRule('geschützt', 'schützen');
        expect(applyInflectionRule(rule, 'Strolches')).toBeNull(); // no ge- prefix
        expect(applyInflectionRule(rule, 'gehen')).toBeNull(); // no -t suffix
    });

    test('a rule never consumes the whole form, which would derive a lemma from nothing', () => {
        const rule = induceInflectionRule('geschützt', 'schützen');
        expect(applyInflectionRule(rule, 'get')).toBeNull();
    });
});

describe('inflection table', () => {
    const table = buildInflectionTable(PAIRS, {ruleBudget: 100});

    test('every pair the table keeps is derivable, and derives back to its own lemma', () => {
        // The safety property the whole scheme rests on: a row may only be dropped at import if the
        // table reproduces it, so a weak rule set costs size rather than correctness.
        for (const {form, lemma} of PAIRS) {
            expect(isDerivable(table, form, lemma), `${form} -> ${lemma}`).toBe(true);
            expect(deriveLemmas(table, form).map((r) => r.lemma)).toContain(lemma);
        }
    });

    test('the labels survive, so a derived hit can still say which inflection it is', () => {
        const derived = deriveLemmas(table, 'geschützt').find((r) => r.lemma === 'schützen');
        expect(derived?.labels).toStrictEqual(['past participle']);
        const genitive = deriveLemmas(table, 'Strolches').find((r) => r.lemma === 'Strolch');
        expect(genitive?.labels).toStrictEqual(['genitive singular']);
    });

    test('the paradigm check rejects a real-but-wrong candidate', () => {
        // The -es rule turns "Rasenes" into "Rasen", but nothing licenses "Philosophie" via a rule
        // it has no paradigm entry for. Over-generation is filtered by the lemma, not by the rule.
        const rule = induceInflectionRule('Strolches', 'Strolch');
        expect(applyInflectionRule(rule, 'Philosophiees')).toBe('Philosophie');
        // ...but Philosophie's paradigm only licenses the plural rule, so it is not derived:
        expect(deriveLemmas(table, 'Philosophiees')).toStrictEqual([]);
    });

    test('a form the dictionary never listed derives nothing', () => {
        // This is a compression of the dictionary's table, not a morphological analyser.
        expect(deriveLemmas(table, 'geklopft')).toStrictEqual([]);
        expect(isDerivable(table, 'geklopft', 'klopfen')).toBe(false);
    });

    test('the rule budget bounds the table and drops the rarest rules first', () => {
        // Two lemmas share the participle rule and the periphrastic rule; the rest are used by one
        // lemma each, so a budget of 2 keeps exactly the two shared ones.
        const small = buildInflectionTable(PAIRS, {ruleBudget: 2});
        expect(small.rules).toHaveLength(2);
        expect(isDerivable(small, 'geschützt', 'schützen')).toBe(true);
        expect(isDerivable(small, 'würde gegrunzt haben', 'grunzen')).toBe(true);
        // Dropped rules mean rows that must be kept, not wrong answers:
        expect(isDerivable(small, 'bin', 'sein')).toBe(false);
        expect(deriveLemmas(small, 'bin')).toStrictEqual([]);
    });

    test('an identity pair is never a rule', () => {
        const identity = buildInflectionTable([{form: 'Haus', lemma: 'Haus', labels: []}], {ruleBudget: 10});
        expect(identity.rules).toHaveLength(0);
        expect(isDerivable(identity, 'Haus', 'Haus')).toBe(false);
    });
});
