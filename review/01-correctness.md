# Round-01 correctness review — items 1–6 (mmc-review-correctness)

VERDICT: FINDINGS (0 BLOCKING, 5 MINOR)

Scope: uncommitted working tree since 10fabc4 — scaffold/harness, db connection+migrations,
relational schema+FTS5, vec0+KNN, embeddings dim guard, local MiniLM provider.
Verified live during review: `npm test` 31/31 pass (7 files), `npm run typecheck` clean,
`npm ls --depth=0` matches Defaults-block pins exactly (@huggingface/transformers@4.2.0,
@modelcontextprotocol/server@2.0.0, better-sqlite3@13.0.3, sqlite-vec@0.1.9 exact),
tsconfig has `"types": ["node"]`. Additional probes run by reviewer: FTS5
`integrity-check` command over the external-content index after INSERT/UPDATE
(tags-only)/DELETE — passes; KNN cosine distances 0/1/2 confirmed exact.

## Findings

1. **MINOR** — src/db/schema.ts:136 — On every `runMigrations` call, including a full
   re-run where nothing was applied, `recordSchemaVersion` executes a `meta` UPSERT
   rewriting `schema_version` with an identical value. Item 2 Accept says the runner
   "applies nothing on re-run"; no migration side effects occur and observable state is
   unchanged, so this does not block — but the letter of the contract is a strict no-op.
   Gate the write on an actual version change.

2. **MINOR** — src/embeddings/local.ts:50-55 — `modelPromise ??= loadModel(...)` memoizes
   the promise even when the loader rejects: one transient load failure permanently
   poisons `embed()` for the life of the provider/process, with no reset or retry path.
   No Accept line in item 6 covers the failure path, so non-blocking for this round;
   flagged because items 11/12 will build on this provider and a cold-start network blip
   would silently disable the semantic leg until process restart.

3. **MINOR** — test/embeddings/local.test.ts:79 — Assertion recomputes its expected value:
   `expect(seen.length).toBe(DEFAULT_MAX_EMBED_CHARS > 64 ? 64 : DEFAULT_MAX_EMBED_CHARS)`.
   With injected `maxChars: 64` and constant `DEFAULT_MAX_EMBED_CHARS = 8_000`, the
   conditional is dead and always yields `64` — tautology-flavored noise (and it couples
   the test to an implementation constant). Line 80 (`seen` equals `'x'.repeat(64)`)
   already asserts the real behavior; simplify line 79 to a literal.

4. **MINOR** — test/db/relational-schema.test.ts:50-55 vs test/db/vector-schema.test.ts:33-36 —
   Two byte-equivalent tests assert `meta.schema_version === '2'` in separate files — a
   horizontal-slicing artifact of items 3 and 4 each carrying its own copy. Keep one
   (vector-schema's "for the full migration set" is the better-named owner).

5. **MINOR** — test/db/relational-schema.test.ts:21 — Test title embeds an external doc
   reference ("exactly the DESIGN §4 columns"). Self-containment: doc-section references
   belong in the plan/DESIGN, not in code identifiers or test names that surface in test
   output. Rename to describe the observed behavior (e.g. "creates the memories table
   with exactly the specified columns").

## Explicitly checked and clean

- Migration atomicity: body + tracking row commit in one transaction; failing migration
  rolls back partial DDL and throws (migrations.test.ts:41-48 verifies table `p` absent,
  tracking unchanged). Re-run idempotency and ordered filename recording covered.
- External-content FTS5 trigger trio uses the correct `'delete'` command pattern with
  old-row values; rowid sync key valid for TEXT-PK memories table; reviewer-run
  `integrity-check` passes; MATCH reflects insert/update/delete including tags-only updates.
- CHECK constraints cover all §4 enums (type/tier/status/source, importance 1–5);
  links composite PK `(from_id,to_id,kind)` gives future idempotency; FK CASCADE present,
  `foreign_keys=ON` asserted for both handle kinds.
- vec0: canonical `MATCH ? AND k = ?` form, ascending cosine distance [0,1,2] exact,
  wrong-dim insert rejected, BigInt-bound integer PK accepted; extension version-queryable.
- Dim guard: dim checked before name, both mismatches throw loudly, first-init records the
  (provider, dim) pair atomically in one transaction, re-init verifies the pair. No bypass:
  unmigrated handles fail loud on missing `meta`.
- MiniLM provider: q8 dtype + explicit cacheDir + offline mode per Defaults; truncation
  happens before the model sees input; concurrency collapses to exactly one load across
  sequential+concurrent phases; real-model offline test proves 384-dim unit-norm
  deterministic output through the pre-seeded `.cache/models` cache.
- Test quality: all suites drive the plan-declared seams (exported opener/runner/factory/
  guard functions); the only mock boundary is the plan-sanctioned injectable ModelLoader;
  no uncovered Accept lines found for items 1–6.

## Per-item status

| Item | Description                          | Reviewer |
|------|--------------------------------------|----------|
| 1    | Scaffold + vitest harness            | [x] verified clean (pins, types:["node"], smoke TS ESM confirmed live) |
| 2    | Connection + migration runner        | [x] verified — MINOR #1 noted, non-blocking |
| 3    | Relational schema + FTS5             | [x] verified — MINORs #4/#5 noted, non-blocking |
| 4    | Vector table + KNN                   | [x] verified — MINOR #4 (dup assert) noted, non-blocking |
| 5    | Provider interface + dim guard       | [x] verified clean |
| 6    | Local MiniLM provider                | [x] verified — MINORs #2/#3 noted, non-blocking |

Items 1–6 are accepted to proceed to checkpoint 1; findings 1–5 are follow-ups, none gate.
