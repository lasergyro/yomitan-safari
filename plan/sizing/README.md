# Where the 149.7 MB actually goes — a bottom-up budget for `kty-de-en`

Status: **analysis, measured; one recommendation not yet applied.** Everything here is measured on the
real `kty-de-en` (947,070 rows) imported through the real backend with the shipped
`DeflatePayloadCodec`, except where a row is explicitly marked a projection.

This doc exists because the previous headline — _"~78 MB of the database is indexes"_ — is **wrong**,
and because "the remaining weight is the schema" turned out to be only a third of the story. The
weight is the **dictionary's own shape**: 90% of the rows are inflected-form stubs.

Related: [../zstd/README.md](../zstd/README.md) (why compression stopped being the lever),
[../02-decisions.md](../02-decisions.md) #27 (the full-scan fix), #28 (the index recommendation).

---

## 1. The correction: indexes are 49.5 MB, not ~78 MB

`dev/measure-storage.js` reports `rest = db − payload − dict` and the plan labelled `rest`
"indexes". It is not: it also contains the terms table's own non-payload bytes. Split per B-tree
with `dbstat` (`SELECT name, sum(pgsize) FROM dbstat GROUP BY name`), same import, page_size 8192:

| B-tree                |         Size | What it holds                                      |
| --------------------- | -----------: | -------------------------------------------------- |
| `terms` (table)       | **100.0 MB** | payload 71.5 + expression 14.5 + row overhead 14.0 |
| `ix_terms_expression` |  **23.0 MB** | 947,070 real keys                                  |
| `ix_terms_sequence`   |   **9.5 MB** | 947,070 × `(1, 0)`                                 |
| `ix_terms_reading`    |   **8.5 MB** | 947,070 × `''`                                     |
| `ix_terms_dictionary` |   **8.5 MB** | 947,070 × `1`                                      |
| **total**             | **149.7 MB** |                                                    |

So the old `rest` of 78.1 MB = **49.5 MB of indexes + 28.5 MB of table row overhead**. The two
reconcile exactly, which is what makes the split trustworthy. Fix applied to
[../README.md](../README.md), [../03-progress.md](../03-progress.md), [../zstd/README.md](../zstd/README.md)
and `DEV.md`.

`rest` is also not a stable quantity — it is 91.2 MB under identity and 78.1 MB under deflate for the
same rows, because it silently absorbs page-fill differences. Prefer `dbstat`.

## 2. Three of the four indexes store zero information

Every row of `kty-de-en` has `reading = ''` **and** `sequence = 0`. So:

- **`ix_terms_reading`** — 947,070 copies of the empty string. 8.5 MB.
- **`ix_terms_sequence`** — 947,070 copies of `(1, 0)`. 9.5 MB.
- **`ix_terms_dictionary`** — 947,070 copies of `1`. 8.5 MB. This one is redundant **by
  construction, on every dictionary**: it is a strict prefix-duplicate of
  `ix_terms_sequence(dictionary_id, sequence)`.

**26.5 MB of the 49.5 MB — 54% of all index bytes — carries no information.** Dropping all three and
VACUUMing: **149.7 MB → 123.2 MB (−17.7%)**, with no capability lost. Verified: every query that used
the dropped index still plans as a seek.

**Schema v2 ships two of the three: −17.0 MB, 149.7 → 132.7 MB, measured.** `ix_terms_dictionary` is
dropped and `ix_terms_reading` is now partial (`WHERE reading <> ''`), 8.5 MB each. The third,
`ix_terms_sequence` (−9.5 MB), is deliberately **not** dropped: it is a semantics question, not a
storage one (§6, decision #29). The −26.5 MB above describes the experiment, not what shipped.

The reading index is partial rather than dropped so that Japanese dictionaries still get one while
German pays nothing — it adapts to the data instead of guessing. The queries that used
`ix_terms_dictionary` still seek, via the leading column of `ix_terms_sequence`:

```
count by dictionary   → SEARCH terms USING COVERING INDEX ix_terms_sequence (dictionary_id=?)
delete by dictionary  → SEARCH terms USING INDEX ix_terms_sequence (dictionary_id=?)
```

> **Watch out:** a partial index needs the literal predicate in the query, so `_queryTermColumn`
> appends `AND reading <> ''` to the reading probe. Without it the `INDEXED BY ix_terms_reading`
> does not fall back to a scan — the statement fails to compile at all, with **`no query solution`**.
> Schema and query are coupled and must change together; both are pinned by
> `dictionary-database-sqlite-query-plan.test.js`. This is the mirror image of decision #27: #27 pins
> an index the planner wrongly avoids, this leaves the planner nothing to get wrong.
>
> **`CREATE INDEX IF NOT EXISTS` will not redefine an existing index**, so this needed a real
> migration: `createDictionarySchema` drops both indexes when `user_version < 2` before running the
> DDL. Despite the version comment claiming otherwise, nothing had ever compared `user_version` —
> the check did not exist until this change. It is index-only, so no data is lost and no re-import.

## 3. The one legitimate index is already at SQLite's floor

```
 14.5 MB   real UTF-8 key bytes (947,070 keys, avg 15.3 B — German compounds are long)
+ 8.5 MB   record overhead, ~9 B/row: rowid + serial types + payload varint + cell pointer
= 23.0 MB  ← exactly what dbstat measures. VACUUM does not shrink it.
```

It stores nothing but keys and row pointers. But the **keys themselves** are highly redundant: in
sorted order **71.1% of key bytes repeat the previous key** (`Haus`, `Hausbau`, `Hausboot`…). SQLite's
B-tree does not prefix-compress, so it cannot exploit that:

| Representation                                  |    Size | vs SQLite |
| ----------------------------------------------- | ------: | --------: |
| SQLite B-tree (measured)                        | 23.0 MB |        1× |
| front-coded (store only the differing suffix)   |  8.9 MB |      2.6× |
| brotli'd key list + row pointers (not seekable) |  4.3 MB |      5.3× |

The ~9 MB is only reachable by not using a SQLite index — a structure you seek through yourself.
Not recommended; it is 14 MB against a much larger prize (§4).

## 4. The bottom-up anatomy: `kty-de-en` is two dictionaries

This is the finding that matters. Splitting rows by what their `glossary` actually contains:

| Population        |            Rows | Raw JSON |   deflate'd | ratio | B/row | share of payload |
| ----------------- | --------------: | -------: | ----------: | ----: | ----: | ---------------: |
| **definitions**   |  94,931 (10.0%) |  98.9 MB | **11.1 MB** | 8.93× |   117 |        **15.5%** |
| **form-of stubs** | 852,139 (90.0%) | 155.0 MB | **60.5 MB** | 2.56× |    71 |        **84.5%** |
| total             |         947,070 | 253.9 MB |     71.5 MB | 3.55× |    75 |                  |

**90% of the rows are inflections**, not definitions — `geschützt → past participle of schützen`.
A stub's whole payload is `[["schützen",["past participle"]]]`.

- The **real dictionary content is 11.1 MB.** All 94,931 structured-content definitions, compressed.
  It compresses 8.93× because every entry repeats the same scaffolding, which the 32 KB preset
  dictionary eats alive.
- The **stubs cost 60.5 MB** — 5.4× more than the definitions — and compress only 2.56×, because each
  row is tiny and compressed independently, so there is little context to exploit.

What is a stub worth, informationally?

```
2,170,986 form-of senses
    2,122 distinct inflection labels   → 12 bits
   82,661 distinct lemmas referenced   → 17 bits
        = 29 bits ≈ 3.6 B of information per sense
        → 7.9 MB for all of them, versus 155.0 MB raw / 60.5 MB stored  (~17× bloat)
```

The stubs also drive everything else: they are 852,139 of the 947,070 index entries, 90% of the row
overhead, and 90% of the degenerate index bytes. **The inflections are ~85% of the database.**

Inside a definition, meaning is also a minority of the bytes. A median entry (`eitrig`, 969 B):

- `"purulent, suppurating, festering"` — 32 B of actual gloss
- ~110 B of grammar/morphology text
- 44 B of `https://en.wiktionary.org/wiki/eitrig#German` — **derivable from the headword** (4.6 MB
  across the corpus, stored verbatim)
- ~780 B of structured-content scaffolding: `{"tag":"div","data":{"content":"Grammar-content"}…}`

Across the whole corpus: **12% of the raw payload is human-readable text; 35% is JSON punctuation;
the rest is markup.** Compression hides this (8.93× on definitions), which is why it never showed up.

## 5. The budget

### 5.1 Who is paying

Attributing every byte to the population that caused it. Payload is measured per population (§4);
the shared costs (index, row overhead, headword text) are split by row count, since both populations
have one headword and one row each and their headwords are the same average length.

| Cost              | 94,931 definitions | 852,139 inflections |
| ----------------- | -----------------: | ------------------: |
| payload           |            11.1 MB |             60.5 MB |
| headword in table |             1.5 MB |             13.0 MB |
| expression index  |             2.3 MB |             20.7 MB |
| degenerate index  |             2.7 MB |             23.8 MB |
| row overhead      |             1.4 MB |             12.6 MB |
| **total**         |        **18.9 MB** |        **130.6 MB** |
|                   |            **13%** |             **87%** |

**The actual German→English dictionary costs 18.9 MB. Its morphology costs 130.6 MB.** Every lever in
this doc is really a lever on the inflections; they dominate not just the payload but the index, the
row overhead and the wasted index too, because they are 90% of the rows.

### 5.2 What an ideal store would need

"Ideal" is a **projection** — the information-content rows are arithmetic, not measurements.

| Component             |       Now |      Ideal | How                                                    |
| --------------------- | --------: | ---------: | ------------------------------------------------------ |
| inflection payload    |      60.5 |     ~11 MB | store `(lemma_id, label_id)`, not JSON text            |
| definition payload    |      11.1 |      ~9 MB | drop derivable backlinks; template the scaffolding     |
| expression index      |      23.0 |     8.9 MB | front-coding (§3) — or 23.0 to stay on SQLite          |
| headword text (table) |      14.5 |          0 | `WITHOUT ROWID` makes the table _be_ the index (§7)    |
| degenerate indexes    |      26.5 |          0 | drop / partial (§2) — **verified, no capability lost** |
| row overhead          |      14.0 |    ~9.5 MB | fewer columns                                          |
| **total**             | **149.7** | **~38 MB** |                                                        |

Floors, for calibration:

- **Information content of the dictionary ≈ 8–15 MB.** Headwords brotli to 1.5 MB, all 94,931
  definitions brotli to 5.6 MB, the stubs are 7.9 MB bit-packed (0.6 MB if entropy-coded). That is
  what a de-en dictionary _is_. The app stores 149.7 MB — a **~12× representation tax**.
- **The random-access tax is most of that gap.** Whole-corpus gzip reaches ~12.8× (≈20 MB) but is not
  seekable. Per-row compression with a 32 KB shared dictionary reaches 3.55×. You are paying ~3.5×
  for the ability to seek one row without touching the others — that part is real and worth it.
- **The biggest single lever is not storage at all**: German inflection is rule-based and Yomitan
  already has a deinflector. A dictionary that shipped only its 94,931 real entries and let the
  deinflector do the rest would be **~15–20 MB total** (§5.1: those rows cost 18.9 MB today, before
  any of the fixes here). That is `kty`'s authoring choice, not ours, and changing it trades coverage
  for size — but it explains why the number is what it is.

**So, the answer to "how big does an indexed de-en dictionary need to be":**

Cumulative, each row building on the one above:

| Design                                     |     Size | Status                                   |
| ------------------------------------------ | -------: | ---------------------------------------- |
| today                                      | 149.7 MB | shipped                                  |
| − degenerate indexes, schema v2 (§2)       | 132.7 MB | **DONE** — measured                      |
| − derivable stubs, K≈100 rules (§5.3)      |   ~66 MB | benchmarked ~0.1 ms/hover (§5.4)         |
| − derivable stubs, K≈1,000 rules (§5.3)    |   ~46 MB | benchmarked **~0.2 ms/hover** (§5.4)     |
| − derivable stubs, all 70,247 rules (§5.3) |   ~20 MB | benchmarked **~3.4 ms/hover**, word mode |

Independent of the above, and mutually exclusive with it where noted:

| Alternative                                                         |     Size | Note                                           |
| ------------------------------------------------------------------- | -------: | ---------------------------------------------- |
| stubs stored as `(lemma_id, label_id)` instead of deleted (§4)      |   ~75 MB | keeps every row findable by exact surface form |
| `WITHOUT ROWID` + front-coded keys + templated definitions (§7, §3) |  −~25 MB | orthogonal; applies on top of any row above    |
| information content (brotli, not seekable)                          | ~8–15 MB | a floor, not a design                          |

§5.3 and §4 attack the same 852,139 stub rows — one by deleting them, the other by storing them
cheaply — so they are alternatives, not additions. §5.3 is strictly better where it applies (a derived
row costs nothing at all, not even an index entry), so the natural design is **§5.3 for the derivable
majority and §4 for the residue**, which is also the only combination that keeps every row findable.

## 5.3 Dropping what the deinflector can already derive — measured

The idea: at import, test each form-of stub against the deinflector; if it already derives the lemma,
don't store the row. It is **safe by construction** — whatever the rules cannot do, you keep — and it
is self-validating, because the dictionary ships **2,170,986 labelled `form → lemma` pairs**, which
is a ground-truth test set for any rule set.

**Against the shipped German rules it saves nothing: 6,593 of 852,139 stub rows (0.77%), 0.76 MB.**
`german-transforms.js` has only _derivational_ rules (past participle, `-bar`, `-heit`, `un-`,
nominalization, separable/zu- prefixes). It has **no inflectional rules at all**, so `genitive`,
`plural`, `dative plural definite` and every verb-conjugation label sit at **0.0%** coverage. Not
worth implementing on its own.

The value is entirely in the rule set, so both were measured:

| Rule set                                          | senses covered | stub rows droppable |   freed |
| ------------------------------------------------- | -------------: | ------------------: | ------: |
| shipped `germanTransforms`                        |           0.4% |               0.77% | 0.76 MB |
| a ~55-rule hand-written suffix set (an afternoon) |          61.9% |               36.2% | 58.1 MB |

That takes the database **149.7 → 91.6 MB**, or **~65 MB** with the §2 index drops. Row coverage is
well below sense coverage because a row is only droppable if _every_ sense on it is derivable.

**Rules can be induced from the dictionary itself, with no language knowledge.** Take each pair's
longest common prefix and the rule is `(strip, append)`; rank by frequency:

```
  -en  → ∅   225,686 pairs        rules   coverage   candidates/word
  -e   → ∅   149,472                 10      42.0%        1.4
  -er  → ∅   136,345                 25      56.9%        2.9
  -s   → ∅    79,014                 50      63.6%        6.0
  -t   → en   30,647                100      65.4%        8.9
                                   5,000      70.5%       27.9
                                 462,003     100.0%      115.2
```

This independently reproduces the hand-written set (top ~50 induced ≈ 63.6% vs 61.9% by hand), which
is a good sign for both. It is **language-agnostic** — nothing in it knows German — so it would work
for any dictionary. But note the tail: **462,003 distinct rules** are needed for 100%, i.e. memorising
the dictionary. The regular core is ~50 rules and ~64%; the rest is irregularity.
"candidates/word" is extra DB lookups per hover — free at 6, since a lookup is 0.06 ms, but each one
is also a chance to show a wrong entry, which is the real limit on over-generating.

**The residue is not irregularity — it is periphrasis.** Of the 543,658 rows the prototype keeps,
**85.4% are multi-word**, and 55.2% of _all_ stub rows are:

```
"wart gesprungen"       → springen  [second-person plural pluperfect indicative]
"würde gegrunzt haben"  → grunzen   [first/third-person singular future II subjunctive II]
"wirst geext haben"     → exen      [second-person singular future II indicative]
"läse ab"               → ablesen   [first/third-person singular subjunctive II]
```

Only **44.8%** of stub headwords are a single word. These are auxiliary constructions
(`haben`/`sein`/`werden`/`würde` + participle/infinitive), not inflections of one word, so no suffix
rule reaches them — but German periphrasis is perfectly regular, and **the transform engine already
supports multi-word rules**: `separatedPrefix` in `german-transforms.js` matches
`^([letters]+) .+ prefix$`. So this is reachable, and it is where the remaining ~55 MB of stub
storage lives. Note that hovering the content word (`gegrunzt`) already resolves via the existing
past-participle rule, so these rows mostly add a tense label for phrase-level scans.

### Precision, and why the paradigm check is a compression scheme rather than a deinflector

Over-generation is genuinely dangerous, and the DB lookup does **not** save you: a candidate that is a
real-but-wrong word passes it. Measured over the whole dictionary:

| rules kept | recall | real-but-wrong candidates | precision | with paradigm check |
| ---------: | -----: | ------------------------: | --------: | ------------------: |
|         10 |  22.3% |                   202,066 |     48.4% |      0 → **100.0%** |
|         50 |  38.4% |                   286,827 |     53.2% |      0 → **100.0%** |
|        500 |  42.7% |                   630,823 |     36.5% |      0 → **100.0%** |

Verifying against the candidate's own paradigm (reject unless its class licenses the rule that
produced it) gives **perfect precision — but tautologically.** Given candidate `C` and rule
`(strip, append)`, the source form is uniquely determined, so `rule ∈ paradigm(C)` holds **iff** the
form is an attested form of `C`. The check is equivalent to consulting the original form→lemma map.

That is not a defect, but it changes what this is: **paradigm classes + rules are a lossless
re-encoding of the inflection table, not a generalisation.** It cannot analyse a form the dictionary
never listed — which is fine, since reproducing this dictionary is the whole job. Measured encoding,
including the labels needed to still say "genitive singular of Strolch":

```
lemmas 82,661 | distinct rules 462,003 | label-sets 2,122 | paradigm classes 26,711 (3.1 lemmas each)

rule table                   1.55 MB      (deflate -9)
class table (rule/label ids) 2.54 MB
lemma → class id             0.11 MB
label-set table              0.01 MB
TOTAL                        4.21 MB      ← replaces ~94 MB of stub rows
```

### Prefix+suffix induction — the model matters more than the rule budget

Suffix-only induction needed **462,003** rules because German's productive morphology is not
suffix-only: `geschützt`/`schützen` share **no** prefix (circumfix `ge-…-t`), and
`"würde gegrunzt haben"`/`grunzen` share none either, so every participle and every periphrastic
phrase minted a _unique_ rule.

Modelling a rule as a shared **core** (longest common substring) with an affix change on each side —
`formPrefix>lemmaPrefix | formSuffix>lemmaSuffix` — fixes exactly that. The induced top rules become
recognisably German: `>|s>`, `>|en>`, `werde >|>`, `würde >|>`, `>| werden>`.

| Induction     | distinct rules | paradigm classes |    encoding |
| ------------- | -------------: | ---------------: | ----------: |
| suffix-only   |        462,003 |           26,711 |     4.21 MB |
| prefix+suffix |     **70,247** |       **16,129** | **1.65 MB** |

It dominates at every rule budget (coverage over the 849,941 **distinct** `(form,lemma)` pairs — note
the 2,170,986 senses collapse to that, since one pair carries many labels):

| rules kept | suffix-only |  prefix+suffix | cand/word | naive precision |
| ---------: | ----------: | -------------: | --------: | --------------: |
|         50 |       38.4% |      **49.4%** |       4.3 |           60.7% |
|        100 |       39.8% |      **59.1%** |       4.7 |           64.4% |
|      1,000 |       44.0% |      **76.7%** |      12.7 |           45.2% |
|        all | 100% (462k) | **100% (70k)** |     153.9 |           27.3% |

### The design table

Rule count is a **tunable knob** trading storage against lookup work. Rows dropped are rows where
_every_ sense is derivable and the lemma is present; freed bytes use the measured 2.56× stub
compression ratio; the table is deflate -9.

|      K | stub rows dropped |    freed | rule+class table | resulting DB | cand/word |
| -----: | ----------------: | -------: | ---------------: | -----------: | --------: |
|    100 |     496,857 (58%) |  84.1 MB |           0.1 MB |  **65.7 MB** |       4.7 |
|    250 |     577,548 (68%) |  94.5 MB |           0.2 MB |  **55.4 MB** |       9.8 |
|  1,000 |     644,969 (76%) | 103.8 MB |           0.3 MB |  **46.3 MB** |      12.7 |
|  5,000 |     737,753 (87%) | 116.4 MB |           0.7 MB |  **33.9 MB** |       ~30 |
| 70,247 |    851,050 (100%) | 131.6 MB |           1.6 MB |  **19.8 MB** |     153.9 |

At the limit this is **149.7 → 19.8 MB** (7.6×), and ~35× against the ~700 MB of IndexedDB — the
whole stub population replaced by a 1.6 MB table, with **no lookup lost**: recall is 100% by
construction for every pair the dictionary lists.

> **The lookup cost is understated and is the open risk.** `cand/word` is per _candidate string_, but
> `translator._getAlgorithmDeinflections` applies the transforms to **every substring** of the scanned
> text, so a ~20-character hover multiplies it: ~94 candidates at K=100 (fine), but ~3,000 at
> K=70,247 — plausibly 60–185 ms, which would be worse than the 75 ms scan of #27. It is also an
> over-estimate, since the sample measured is inflected forms (which match rules by definition) rather
> than arbitrary substrings. **None of it is benchmarked.** The sweet spot is likely K≈1,000–5,000
> (**46.3–33.9 MB** at ~13–30 cand/word), not the limit — but that is a guess until measured.

### What a derived entry displays — the UX objection was wrong

Earlier drafts of this doc called the display a blocker: "a dropped row becomes a lemma hit with an
inflection path instead of an explicit _past participle of X_ entry". **That is not what happens, and
there was never an explicit entry.** `translator._getDeinflections` runs

```js
entry.definitions = entry.definitions.filter(
  (definition) => !Array.isArray(definition),
);
deinflection.databaseEntries = deinflection.databaseEntries.filter(
  (entry) => entry.definitions.length,
);
```

so form-of definitions are stripped and a row left with none is dropped. **A stub row never renders.**
It is purely a deinflection pointer: `geschützt` → its `formOf` → `schützen`, displayed as the lemma
with an inflection chain (`_getDictionaryDeinflections`, `source: 'dictionary'`).

So deriving the same form by rule changes only the chain's `source` to `'algorithm'` and the origin of
the chip's label — and the label-set table (2,122 sets, 0.01 MB) carries the dictionary's own labels,
so the chip can read identically. The remaining work is architectural, not UX: algorithm deinflections
come from `MultiLanguageTransformer`, which is **language-static and built at construction**, whereas
these rules are **derived per dictionary and live in the database**, so they have to be loaded and
injected per enabled dictionary. Dropping the stub rows also removes what
`_getDictionaryDeinflections` reads, so the two paths must change together.

**Status: not implemented.** The import-time check is the right harness but has nothing to eat until
the rules exist; build the two together, since the check is what measures the rules. Ordering
matters — this changes _lookup behaviour_ (over-generation can surface wrong entries) and _display_
(a dropped row becomes a lemma hit with an inflection path instead of an explicit
"past participle of X" entry), so it needs a UX decision, not just a storage one.

## 5.4 The benchmark — it is fast enough, and it found a bug in the shipped query path

Measured end-to-end against the real database: import all 947,070 rows through the real backend with
deflate, mark each stub row with the smallest rule budget `K` that derives it, then
`DELETE … WHERE k <= K` + `VACUUM` + `ANALYZE` and time real hovers. Hovers are 16-character windows
(`scanning.length` default) over German prose, replicating `_getAlgorithmDeinflections`: step
substrings, generate candidates per substring, dedup, one `findTermsBulk`.

**`searchResolution` dominates the substring count, and German's recommended settings set it to
`word`** (`ext/data/recommended-settings.json`: _"Lookup whole words in the dictionary"_). A 16-char
window is ~3 substrings by word versus 16 by letter. The schema default is `letter`, so both matter.

|      K |    rows |  DB size | mode   | cand | rule gen |       DB |        total |
| -----: | ------: | -------: | ------ | ---: | -------: | -------: | -----------: |
|  today | 947,070 | 159.8 MB | word   |    3 |  0.00 ms |  0.17 ms |  **0.17 ms** |
|  today | 947,070 | 159.8 MB | letter |   16 |  0.01 ms |  0.60 ms |  **0.61 ms** |
|    100 | 450,213 |  81.0 MB | word   |   14 |  0.01 ms |  0.44 ms |  **0.45 ms** |
|  1,000 | 302,101 |  59.6 MB | word   |   29 |  0.04 ms |  0.76 ms |  **0.81 ms** |
|  1,000 | 302,101 |  59.6 MB | letter |  104 |  0.16 ms |  2.62 ms |  **2.79 ms** |
|  5,000 | 209,317 |  45.5 MB | word   |   56 |  0.16 ms |  1.41 ms |  **1.57 ms** |
| 70,247 |  96,020 |  28.5 MB | word   |  434 |  1.94 ms | 10.10 ms | **12.04 ms** |
| 70,247 |  96,020 |  28.5 MB | letter | 1876 |  8.23 ms | 43.38 ms | **51.60 ms** |

(The DB sizes here are pre-`§2` and slightly above the §5.3 projections, which assume the index drops
and a rule table rather than a `VACUUM`ed delete. 28.5 vs ~19.8 MB is that gap plus free-page slack.)

### The query strategy is worth ~7×, and the win is statement preparation

`findTermsBulk` loops per term and calls `selectObjects`, which **prepares and finalises a statement
on every call** — 434 candidates cost 868 prepare/execute/finalise cycles. Same candidate sets, SQL
only:

| K      | mode   | cand | A: per-term (today) | B: per-term, prepared once | C: batched `IN (?,?,…)` |
| ------ | ------ | ---: | ------------------: | -------------------------: | ----------------------: |
| 1,000  | word   |   29 |             0.85 ms |                    0.14 ms |             **0.15 ms** |
| 5,000  | word   |   56 |             1.29 ms |                    0.22 ms |             **0.23 ms** |
| 70,247 | word   |  434 |             9.44 ms |                    1.52 ms |             **1.34 ms** |
| 70,247 | letter | 1876 |            46.27 ms |                    6.41 ms |             **6.21 ms** |

**~85% of query time is `sqlite3_prepare` overhead, not index seeks.** Batching on top of statement
reuse adds only ~12% more. This is **a defect in the code as shipped today**, independent of
everything else here: every lookup on the SQLite backend pays it, and caching the two statements
makes today's hover ~5–10× cheaper on the SQL (0.17 → ~0.02 ms).

### Revised verdict: the full rule set is viable

With batched/prepared queries, per hover in `word` mode:

| K      | DB size | rule gen | DB (batched) |   **total** |
| ------ | ------: | -------: | -----------: | ----------: |
| 1,000  | 59.6 MB |  0.04 ms |      0.15 ms | **~0.2 ms** |
| 5,000  | 45.5 MB |  0.16 ms |      0.23 ms | **~0.4 ms** |
| 70,247 | 28.5 MB |  1.94 ms |      1.34 ms | **~3.4 ms** |

**The earlier "K=all is likely too slow" call was wrong** — it assumed today's per-term query
strategy. At the full rule set a hover costs ~3.4 ms in word mode (~14 ms in letter mode, where rule
generation becomes the bottleneck). Rule generation is naive linear iteration over 70,247 rules; a
suffix-indexed structure would cut the 1.94 ms substantially, and nothing here is optimised.

So the size/latency trade is real but mild, and **K is a genuine knob rather than a wall**.

`kty-de-en`'s `index.json` declares `sequenced: true`, but **every row has `sequence = 0`**.
`translator.js:709` gates the sequence lookup on `sequence >= 0`, so `0` passes, and
`findTermsBySequenceBulk(0)` runs `WHERE sequence = 0 AND dictionary_id = ?` — which matches **all
947,070 rows** and decodes every one.

- Only reachable in **`merge`** result-grouping mode (not the default) with `kty-de-en` as the main
  dictionary.
- **Not a regression and not SQLite-specific**: the IndexedDB backend does the same thing through its
  own `sequence` index. Inherited from upstream.
- It is the same shape as the 75 ms full scan of #27: a degenerate column the code assumes is
  selective.
- **This is why `ix_terms_sequence` is not made partial.** `WHERE sequence > 0` would make the query
  return nothing here rather than everything — arguably better, but a behaviour change that needs a
  decision about what `sequence = 0` means, not a storage tweak.

## 7. `WITHOUT ROWID` — measured, but not recommended yet

Make the table itself ordered by expression (`PRIMARY KEY(expression, id) WITHOUT ROWID`) and there is
no separate expression index to pay for. Built from the identical deflate payloads via
`INSERT..SELECT`, so the bytes are exactly comparable:

| Schema                               | terms storage |   saved |
| ------------------------------------ | ------------: | ------: |
| current (rowid + 4 indexes)          |      149.5 MB |       — |
| drop the 3 degenerate indexes (§2)   |      123.0 MB | 26.5 MB |
| `WITHOUT ROWID`, no expression index |  **113.8 MB** | 35.7 MB |
| `WITHOUT ROWID` + an `id` index      |      136.8 MB | 12.7 MB |

Seeks stay correct and fast: `SEARCH alt1 USING PRIMARY KEY (expression=?)`, 0.045 ms.
No `id` index is needed — `id` is only ever _returned_ and used for dedup, never looked up. (If one
were ever added it costs 23.0 MB and eats the win, because secondary indexes on a `WITHOUT ROWID`
table reference rows by the **full primary key**.)

**Do not adopt on this evidence.** That same property means a _Japanese_ dictionary's reading index
would carry `expression + id` in every entry instead of a 3-byte rowid. German gets this free (its
reading index is empty); Japanese — the dictionaries Yomitan mainly serves — would pay. **Measure a
Japanese dictionary before deciding.** The 9.2 MB it adds over §2 is not worth much risk.

## 8. What to do

> **Every MB figure in §1–§7 is terms-only and understated.** They came from harnesses that imported
> only `term_bank_*.json` and wrote `reading: ''`. Driving the real `DictionaryImporter` (all stores,
> `reading` rewritten to the expression) the pre-drop database is **170.5 MB**, not 132.7, and the
> post-drop database is **49.4 MB** (56.8 at schema v4, then 49.4 once #36 empties the reading index),
> not 44.56 (see [02-decisions.md](../02-decisions.md) #35). The shape of every conclusion holds; the
> absolute bytes were low. Re-measuring §1–§4 through the real importer is itself an open item.

1. **Do now** (small, verified, no capability lost): drop `ix_terms_dictionary`, make
   `ix_terms_reading` partial + add the literal predicate to the reading probe. **DONE** — schema v2.
   ⚠️ The predicate was `reading <> ''`, which **saved nothing** — the importer never writes an empty
   reading, so it excluded no rows (#35). Fixed by #36: `reading <> expression`, which on German
   empties the index (a 25.67 MB B-tree; **−23.0 MB** in the file after VACUUM, schema v5). The lesson
   is the durable part: this was measured on `bulkAdd(reading: '')` data the product never produces.
2. **Decide** what `sequence = 0` means (§6) before touching `ix_terms_sequence`.
3. **Measure a Japanese dictionary** — it gates §7, and it is also the only way to know whether the
   reading index and the reverse-column gap matter in practice. **More urgent now**: #36's reading
   index is empty on German and non-empty only on Japanese, so Japanese is the case that exercises it.
4. **The real prize is the inflection representation** (§4): 60.5 MB → ~11 MB. It is a schema +
   importer change, not a codec change, and it is worth more than everything else here combined.
   **DONE, and it went further than this section proposed.** Rather than store the form-of rows more
   cheaply as `(expression, lemma_id, label_id)`, they are **not stored at all**: rules induced from
   the dictionary's own pairs (§5.3) delete every row they can reproduce, and `findTermsBulk`
   synthesizes it back on lookup. Measured through the real importer: **170.5 → 49.4 MB, 947,070 →
   293,262 rows** (56.8 MB at v4 from the drop, 49.4 once #36 empties the reading index), with the
   pointers a lookup yields matching the ZIP exactly over 41,921 sampled forms (0 lost, 0 invented).
   Schema v4/v5; see [02-decisions.md](../02-decisions.md) #31, #34 and #36.

   The whole-file total is now **49.4 MB against the 149.7 MB this document opened on** (both partial
   pictures — the 149.7 was also terms-only — but the direction is real): the morphology that §4
   measured at 87% of the database is gone.

5. **Import cost is now the open question, not size.** `finalizeImport` is 124.0s on top of a 152.0s
   import, through the real importer. Unzip + parse is ~3s of that 152; **~90% of the import is pako
   deflate** (identity is 15.1s → 366.4 MB, deflate 152.0s → 170.5 MB, #37), so it is a codec knob,
   not a schema one. The drop pass also decodes every payload a second time (~60s of the 124).

## Reproducing

`npm run measure:storage -- --db` gives the totals. The per-B-tree split, the population split and
the schema variants were one-off scripts, not committed; they are ~40 lines each over
`dbstat` / `JSZip` and the recipes are in §1, §4 and §7 above.
