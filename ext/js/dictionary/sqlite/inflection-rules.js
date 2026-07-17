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
 * Induces inflection rules from a dictionary's own form-of entries, so that the rows encoding them
 * do not have to be stored (see plan/02-decisions.md #31, plan/sizing/README.md §5.3).
 *
 * 90% of `kty-de-en`'s 947,070 rows are form-of stubs — `geschützt → past participle of schützen` —
 * costing 60.5 MB of the 71.5 MB payload to carry ~3.6 bytes of information each. They are never
 * displayed (`translator._getDeinflections` strips form-of definitions); they exist only so a lookup
 * of the surface form can find the lemma. A rule that derives the same form makes the row redundant.
 *
 * Nothing here knows any German, or any language: the rules are induced from the pairs the dictionary
 * itself ships, which also makes them exactly consistent with it.
 *
 * ## The rule model
 *
 * A rule is an affix change around a shared **core**, the longest common substring of the two forms:
 *
 *     geschützt / schützen        ->  "ge>|t>en"        (prefix ge- dropped, suffix -t becomes -en)
 *     würde gegrunzt haben / grunzen -> "würde ge>|t haben>en"
 *     Strolches / Strolch         ->  ">|es>"           (no prefix change, suffix -es dropped)
 *
 * Modelling the prefix matters: German's productive morphology is circumfixing (`ge-…-t`) and
 * periphrastic (`würde ge-…-t haben`), and a suffix-only model cannot express either — it mints a
 * unique rule per form, needing 462,003 rules where this model needs 70,247 for the same coverage.
 *
 * ## Why a rule alone is not enough
 *
 * Applying rules to a surface form over-generates: at 1,000 rules only ~45% of the candidates that
 * are real words are the right word (`Rasen` → `Rase` is a real word and a wrong answer), and a
 * database lookup does not filter those — they exist. So a candidate is only accepted if the lemma's
 * own **paradigm** licenses the rule that produced it. That check is exact, which is another way of
 * saying it is equivalent to consulting the original table: this is a **compression of the
 * dictionary's inflection data, not a morphological analyser**, and it cannot analyse a form the
 * dictionary never listed.
 */

/** Separates a rule's prefix change from its suffix change. */
const RULE_PART_SEPARATOR = '|';
/** Separates the form side of an affix change from the lemma side. */
const RULE_SIDE_SEPARATOR = '>';
/**
 * Marks a whole-word rule, used when two forms share no core at all (suppletion: `bin`/`sein`).
 * A space cannot begin a real affix, so this never collides with an induced affix rule.
 */
const WHOLE_WORD_PREFIX = ' ';

/**
 * Leading marker in a serialized table. Bump when the layout changes: an import written by an older
 * version then deserializes to null and simply derives nothing, which is safe because every row it
 * could have derived is still stored.
 */
const INFLECTION_TABLE_FORMAT = 1;

/**
 * Finds the longest common substring, i.e. the part of the two forms the inflection leaves alone.
 * @param {string} a
 * @param {string} b
 * @returns {{aStart: number, bStart: number, length: number}} `length` 0 when nothing is shared.
 */
function longestCommonSubstring(a, b) {
    const n = a.length;
    const m = b.length;
    // Rolling rows of the standard DP: lengths[j] is the longest common suffix of a[0..i) and b[0..j).
    let previous = new Int32Array(m + 1);
    let current = new Int32Array(m + 1);
    let best = 0;
    let aEnd = 0;
    let bEnd = 0;
    for (let i = 1; i <= n; ++i) {
        current.fill(0);
        for (let j = 1; j <= m; ++j) {
            if (a.charCodeAt(i - 1) !== b.charCodeAt(j - 1)) { continue; }
            const length = previous[j - 1] + 1;
            current[j] = length;
            if (length > best) {
                best = length;
                aEnd = i;
                bEnd = j;
            }
        }
        const swap = previous;
        previous = current;
        current = swap;
    }
    return {aStart: aEnd - best, bStart: bEnd - best, length: best};
}

/**
 * Derives the rule that turns `form` into `lemma`.
 * @param {string} form The inflected surface form, as it appears in the text.
 * @param {string} lemma The dictionary form it is an inflection of.
 * @returns {string} An opaque rule key; pass it to `applyInflectionRule`.
 */
export function induceInflectionRule(form, lemma) {
    const {aStart, bStart, length} = longestCommonSubstring(form, lemma);
    if (length === 0) {
        return `${WHOLE_WORD_PREFIX}${form}${RULE_SIDE_SEPARATOR}${lemma}`;
    }
    const formPrefix = form.slice(0, aStart);
    const lemmaPrefix = lemma.slice(0, bStart);
    const formSuffix = form.slice(aStart + length);
    const lemmaSuffix = lemma.slice(bStart + length);
    return `${formPrefix}${RULE_SIDE_SEPARATOR}${lemmaPrefix}${RULE_PART_SEPARATOR}${formSuffix}${RULE_SIDE_SEPARATOR}${lemmaSuffix}`;
}

/**
 * Applies a rule to a surface form, producing the lemma it would be an inflection of.
 *
 * The result is only a *candidate*: it is meaningless until it is found in the dictionary **and** its
 * paradigm licenses this rule (see the module comment). Rules deliberately over-generate.
 * @param {string} rule A key from `induceInflectionRule`.
 * @param {string} form
 * @returns {?string} The candidate lemma, or null if the rule does not apply to this form.
 */
export function applyInflectionRule(rule, form) {
    if (rule.startsWith(WHOLE_WORD_PREFIX)) {
        const split = rule.indexOf(RULE_SIDE_SEPARATOR);
        return rule.slice(WHOLE_WORD_PREFIX.length, split) === form ? rule.slice(split + 1) : null;
    }
    const partSplit = rule.indexOf(RULE_PART_SEPARATOR);
    const prefixPart = rule.slice(0, partSplit);
    const suffixPart = rule.slice(partSplit + 1);
    const prefixSplit = prefixPart.indexOf(RULE_SIDE_SEPARATOR);
    const suffixSplit = suffixPart.indexOf(RULE_SIDE_SEPARATOR);
    const formPrefix = prefixPart.slice(0, prefixSplit);
    const lemmaPrefix = prefixPart.slice(prefixSplit + 1);
    const formSuffix = suffixPart.slice(0, suffixSplit);
    const lemmaSuffix = suffixPart.slice(suffixSplit + 1);
    // The core must be non-empty: a rule that consumed the whole form would derive a lemma from
    // nothing, matching every string of the right shape.
    if (form.length <= formPrefix.length + formSuffix.length) { return null; }
    if (!form.startsWith(formPrefix) || !form.endsWith(formSuffix)) { return null; }
    const core = form.slice(formPrefix.length, form.length - formSuffix.length);
    return lemmaPrefix + core + lemmaSuffix;
}

/**
 * @typedef {object} InflectionTable
 * @property {string[]} rules Rule keys, most-used first; index is the rule id.
 * @property {string[]} labels Distinct label sets ('|'-joined); index is the label id.
 * @property {Map<string, [number, number][]>} paradigms lemma -> the (ruleId, labelId) pairs it
 *   licenses. A candidate produced by a rule is only valid if the lemma's list contains that rule.
 * @property {Map<string, number>} ruleIds Reverse of `rules`. Derived, not serialized: `isDerivable`
 *   runs once per stated pair over the whole dictionary (2.17M times on `kty-de-en`), which a linear
 *   scan of 1,000 rules turns into 2.17 billion string compares.
 */

/**
 * Builds the rule/paradigm tables from a dictionary's form-of pairs.
 *
 * Rules are ranked by how many lemmas use them and cut to `ruleBudget`, which is the size/latency
 * knob: every kept rule is another candidate to generate and look up on every hover, and every
 * dropped rule means its forms must stay as rows. Measured on `kty-de-en` (plan/sizing/README.md
 * §5.4): 1,000 rules derives 76% of the stub rows at ~0.2 ms per hover, while all 70,247 derives
 * 100% at ~3.4 ms.
 * @param {Iterable<{form: string, lemma: string, labels: string[]}>} pairs Every form-of entry.
 * @param {{ruleBudget: number}} options
 * @returns {InflectionTable}
 */
export function buildInflectionTable(pairs, {ruleBudget}) {
    /** @type {Map<string, Set<string>>} rule -> the lemmas using it, for ranking by lemma count. */
    const ruleLemmas = new Map();
    /** @type {{form: string, lemma: string, rule: string, labels: string}[]} */
    const derived = [];
    for (const {form, lemma, labels} of pairs) {
        if (form === lemma) { continue; }
        const rule = induceInflectionRule(form, lemma);
        derived.push({form, lemma, rule, labels: labels.join('|')});
        let lemmas = ruleLemmas.get(rule);
        if (typeof lemmas === 'undefined') {
            lemmas = new Set();
            ruleLemmas.set(rule, lemmas);
        }
        lemmas.add(lemma);
    }

    // Rank by lemma count rather than pair count: a rule used by many words is a rule of the
    // language, where one used many times by one word is that word's paradigm.
    const ranked = [...ruleLemmas.entries()]
        .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
        .slice(0, ruleBudget)
        .map(([rule]) => rule);
    /** @type {Map<string, number>} */
    const ruleIds = new Map(ranked.map((rule, id) => [rule, id]));

    /** @type {string[]} */
    const labels = [];
    /** @type {Map<string, number>} */
    const labelIds = new Map();
    /** @type {Map<string, [number, number][]>} */
    const paradigms = new Map();
    for (const entry of derived) {
        const ruleId = ruleIds.get(entry.rule);
        if (typeof ruleId === 'undefined') { continue; } // rule did not make the budget
        let labelId = labelIds.get(entry.labels);
        if (typeof labelId === 'undefined') {
            labelId = labels.length;
            labels.push(entry.labels);
            labelIds.set(entry.labels, labelId);
        }
        let paradigm = paradigms.get(entry.lemma);
        if (typeof paradigm === 'undefined') {
            paradigm = [];
            paradigms.set(entry.lemma, paradigm);
        }
        if (!paradigm.some(([r, l]) => r === ruleId && l === labelId)) { paradigm.push([ruleId, labelId]); }
    }
    return {rules: ranked, labels, paradigms, ruleIds};
}

/**
 * Flattens a table for storage. The result is handed to the dictionary's payload codec, which is
 * what makes the size work: at a 1,000-rule budget this is ~0.3 MB deflated, where the same data as
 * SQLite rows would be ~11-15 MB and eat a third of what dropping the rows saves.
 * @param {InflectionTable} table
 * @returns {import('dictionary-database').DatabaseTermEntryPayload} A codec-encodable payload.
 */
export function serializeInflectionTable(table) {
    /** @type {[string, [number, number][]][]} */
    const paradigms = [...table.paradigms];
    return /** @type {import('dictionary-database').DatabaseTermEntryPayload} */ (
        /** @type {unknown} */ ([INFLECTION_TABLE_FORMAT, table.rules, table.labels, paradigms])
    );
}

/**
 * Rebuilds a table from `serializeInflectionTable`.
 * @param {unknown} payload
 * @returns {?InflectionTable} null if the payload is not a table this version understands, so an
 *   older import degrades to "derives nothing" (every row is still stored) rather than throwing.
 */
export function deserializeInflectionTable(payload) {
    if (!Array.isArray(payload) || payload[0] !== INFLECTION_TABLE_FORMAT) { return null; }
    const parts = /** @type {[number, string[], string[], [string, [number, number][]][]]} */ (payload);
    const rules = parts[1];
    return {rules, labels: parts[2], paradigms: new Map(parts[3]), ruleIds: new Map(rules.map((rule, id) => [rule, id]))};
}

/**
 * Whether `table` can derive this pair, i.e. whether the row encoding it is redundant and can be
 * left out of the import. This is the check that keeps the scheme safe: whatever the rules cannot
 * reproduce stays a row, so a weak rule set costs size rather than correctness.
 * @param {InflectionTable} table
 * @param {string} form
 * @param {string} lemma
 * @returns {boolean}
 */
export function isDerivable(table, form, lemma) {
    if (form === lemma) { return false; }
    const paradigm = table.paradigms.get(lemma);
    if (typeof paradigm === 'undefined') { return false; }
    const ruleId = table.ruleIds.get(induceInflectionRule(form, lemma));
    return typeof ruleId !== 'undefined' && paradigm.some(([r]) => r === ruleId);
}

/**
 * Generates the lemma candidates for a surface form, each with the rule that produced it and the
 * labels to show for it. Only candidates whose lemma paradigm licenses the rule are returned, so the
 * result is exactly the set of (lemma, labels) the dropped rows would have pointed at.
 * @param {InflectionTable} table
 * @param {string} form
 * @returns {{lemma: string, labels: string[]}[]}
 */
export function deriveLemmas(table, form) {
    /** @type {{lemma: string, labels: string[]}[]} */
    const results = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (let ruleId = 0, ii = table.rules.length; ruleId < ii; ++ruleId) {
        const lemma = applyInflectionRule(table.rules[ruleId], form);
        if (lemma === null || lemma === form || lemma.length === 0) { continue; }
        const paradigm = table.paradigms.get(lemma);
        if (typeof paradigm === 'undefined') { continue; }
        for (const [licensedRule, labelId] of paradigm) {
            if (licensedRule !== ruleId) { continue; }
            const key = `${lemma} ${labelId}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            const labelSet = table.labels[labelId];
            results.push({lemma, labels: labelSet.length > 0 ? labelSet.split('|') : []});
        }
    }
    return results;
}
