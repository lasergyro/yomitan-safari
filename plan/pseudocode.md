# The main idea, in pseudocode

One place that spells out the whole scheme end to end: a columnar SQLite store, a self-describing
per-row codec, and — the part that carries the size win — **dropping the dictionary's inflected-form
rows at import and synthesizing them back on lookup.**

This is a reading aid, not the source. Prose and rationale: [design.md](design.md). Real code:
`ext/js/dictionary/sqlite/dictionary-database-sqlite.js`, `inflection-rules.js`.

```
A term row  = (id, dictionary_id, expression, reading, sequence, payload)
payload     = codec.encode([definitionTags, rules, score, glossary, termTags])

A form-of stub is a term row whose glossary is entirely [lemma, labels] pointers and nothing a
reader would see — e.g.  geschützt  ->  [["schützen", ["past participle"]]].
In kty-de-en these are 90% of the rows and 85% of the database.
```

---

## The rule model (`inflection-rules.js`)

A rule rewrites a surface form into its lemma by changing the affixes around a shared **core** — the
longest common substring of the two. Modelling both affixes (not just the suffix) is what lets one
rule cover German circumfixes and periphrastic phrases.

```
induceRule(form, lemma):
    core = longestCommonSubstring(form, lemma)
    if core is empty:                       # suppletion: bin / sein
        return wholeWordRule(form, lemma)
    return (formPrefix > lemmaPrefix | formSuffix > lemmaSuffix)   # the parts around the core

    # geschützt / schützen            ->  "ge>|t>en"
    # würde gegrunzt haben / grunzen  ->  "würde ge>|t haben>en"
    # Strolches / Strolch             ->  ">|es>"

applyRule(rule, form) -> lemma | none       # inverse: find the core in `form`, swap the affixes back

buildInflectionTable(pairs, K):             # pairs = every (form, lemma) the dictionary states
    for each (form, lemma): rule = induceRule(form, lemma)
    rank rules by how many distinct lemmas they touch
    keep the top K                          # K is the storage/latency knob; shipped K = 1000
    # A paradigm class records which rules a given lemma actually licenses. This makes derivation
    # exact rather than over-generating — see "why the paradigm check" in design.md.
    return { rules, paradigmClasses, labelSets }

deriveLemmas(table, form) -> [(lemma, labels)]   # every lemma `form` derives, paradigm-checked
isDerivable(table, form, lemma) -> bool          # does the table reproduce this exact pair?
```

Everything above is pure and language-agnostic: it only ever reads the pairs the dictionary itself
ships, so the rules are exactly consistent with it. It is a _compression_ of the inflection table,
not a morphological analyser — it cannot analyse a form the dictionary never listed.

---

## Import

`bulkAdd` streams rows in as they arrive; `finalizeImport` runs once at the end, when every pair is
known.

```
bulkAdd("terms", rows):
    ensureWriteCodec(dictionary)            # resolve + train the preset dict once, before the tx (async)
    transaction:
        for row in rows:
            insert (dictionary_id, expression, reading, sequence,
                    codec.encode(row.payload))
    # No rows are dropped here — ranking needs the whole dictionary first.

finalizeImport():                           # called once after the import completes
    for each dictionary:
        buildInflectionTable(dictionary)    # induce rules, store them as ONE codec-encoded blob
        dropDerivableRows(dictionary)       # take the win
    ANALYZE; VACUUM
```

### Inducing the table

```
buildInflectionTable(dictionary):
    if dictionaries.inflection_table already set: return      # idempotent across multi-dict imports
    pairs = every (form, lemma) decoded from this dictionary's form-of rows
    if no pairs: return
    table = buildInflectionTable(pairs, K)
    dictionaries.inflection_table = codec.encode(serialize(table))
```

### Dropping the rows the rules reproduce

This is the step that actually shrinks the file. A row is dropped only when losing it is provably
free — otherwise it stays a row and costs space, never correctness.

```
dropDerivableRows(dictionary):
    if dictionaries.stub_template already set: return         # already dropped; don't rescan
    table = load inflection_table(dictionary)
    if none: return

    template = null                         # the shared non-glossary payload of the dropped rows
    dropIds  = []
    for row in form-of rows of dictionary:
        if row is not a pure stub:                     continue   # has real text -> keep
        if row.reading not in {row.expression, ""}:    continue   # a distinct reading only a reading
                                                                  #   probe could answer -> keep
        if not every pair of row is isDerivable(table): continue  # a row is dropped whole or not at all
        if template is null: template = row.template
        else if row.template != template:              continue   # differs from the shared one -> keep
        dropIds.push(row.id)

    if template is null or dropIds empty: return
    transaction:
        DELETE FROM terms WHERE id IN (dropIds)        # batched
        dictionaries.stub_template = codec.encode(template)   # non-null == "rows were dropped"
    invalidate inflectionCache[dictionary]
```

`stub_template` being non-null is the **only** thing that later licenses synthesis. A database that
has the rules but still has all its rows (an intermediate state, or an older schema) leaves it null,
so the query path does not double anything.

---

## Lookup

`findTermsBulk` is unchanged in shape from the IndexedDB backend — probe expression, then reading,
dedup by id — plus one appended step: on an **exact** probe, synthesize the rows that were dropped.

```
findTermsBulk(terms, enabledDicts, matchType):
    results = []
    visited = {}                            # physical row ids, dedup across the whole result
    for i, term in terms:
        start = results.length
        for column in [expression, reading]:
            for row in queryTermColumn(column, term, matchType, enabledDicts):
                if row.id in visited: continue
                visited.add(row.id)
                results.push(buildTermEntry(row, column, ...))

        if matchType == "exact":            # a wildcard asks which *stored* forms match; a dropped
            addDerivedTerms(results, start, term, i, enabledDicts)   # form is not stored
    return results

queryTermColumn(column, term, matchType, dicts):
    # exact/prefix: INDEXED BY the column's index -> always a seek, never the planner's full scan.
    # reading probe additionally carries the literal `AND reading <> expression` (the partial-index
    # predicate) or SQLite refuses the index. suffix: JS endsWith filter (no index can serve it).
    ...
```

### Synthesizing the dropped rows

```
addDerivedTerms(results, start, term, i, enabledDicts):
    for dictionary in enabledDicts:
        inflection = getInflection(dictionary)         # {table, template}, or null if nothing dropped
        if inflection is null: continue
        derived = deriveLemmas(inflection.table, term) # [(lemma, labels)] the rules produce for `term`
        if derived empty: continue

        # A kept row (one with an underivable pair) may already state some of these lemmas; don't
        # emit those twice.
        alreadyStored = { lemma of every [lemma,labels] definition in results[start..] for this dict }
        pointers = [ [lemma, labels] for (lemma, labels) in derived if lemma not in alreadyStored ]
        if pointers empty: continue

        # ONE synthesized entry carrying every pointer — the shape the dictionary itself used
        # (kty-de-en packs all of Rappen's pointers into one row). Fields come from the template.
        results.push(termEntry(
            term, definitions = pointers, ...inflection.template,
            id = negative(),                # can't collide with a real row id in visited / merge sets
        ))
```

To everything downstream, a synthesized entry _is_ the dropped row:
`translator._getDictionaryDeinflections` follows its `[lemma, labels]` pointers exactly as it did the
stored ones, and `translator._getDeinflections` then strips them (a form-of definition never
renders). **The translator does not change** — the rules never reach `MultiLanguageTransformer`; they
compress the dictionary deinflection path, which `findTermsBulk` alone feeds.

---

## The invariant, in one line

> A dropped stub row and its synthesized replacement yield the **same set of `[lemma, labels]`
> pointers** on an exact lookup — verified against the source ZIP over 41,921 forms: 100% exact, 0
> lost, 0 invented.

That is the whole correctness claim. Entry-identity, row grouping, and ordering are all free to
differ, because the only consumer is the set of deinflection pointers.
