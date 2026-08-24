# Reliability model

Memory reliability is a pure heuristic computed **at read time** — nothing is
persisted as "the" reliability value, so the formula can evolve without a
migration. This document summarizes the model; the authoritative spec is
**DESIGN.md §5**.

## Formula

```
base    = user-stated 1.0 · agent-inferred 0.7 · agent-guessed 0.4
recency = exp(-λ_type × days_since(last_confirmed_at ?? created_at))
corrob  = 1 + min(0.5, observed_count × 0.05)
penalty = 0.7 ^ open_contradictions
reliability = clamp(base × recency × corrob × penalty, 0, 1)
```

- **base** — how much to trust the source of a memory.
- **recency** — exponential decay anchored at the last confirmation (falling back to
  creation time when never confirmed).
- **corrob** — corroboration bonus, capped at +0.5.
- **penalty** — each open contradiction multiplies reliability by 0.7.

## Type decay λ (per day)

| Type | λ |
| --- | --- |
| preference | 0.002 |
| person / project | 0.003 |
| decision / lesson / procedure | 0.005 |
| fact | 0.01 |
| session | 0.1 |

## Tiers and STM expiry

Tier defaults by type: `session` and `project-state` are `short` with a
short-term-memory TTL (24 h and 14 d respectively); every other type defaults to
`long` with no expiry. `promote` moves a memory to `long` and clears `expires_at`.

## Lifecycle signals (`consolidate`)

The maintenance engine is **report-only** — `consolidate` with no arguments lists
signals; nothing changes until `apply` names specific action ids. Thresholds are
the DESIGN §5 starting values:

| Signal | Action proposed |
| --- | --- |
| STM past `expires_at` | expire |
| reliability < 0.35 AND last access > 90 d AND importance ≤ 2 | archive |
| recency < 0.5 (days since confirmation/creation > `ln(2)/λ`) AND importance ≥ 3 | re-confirm |
| `observed_count` ≥ 10 AND content < 400 chars | needs expansion |
| pairwise cosine > 0.92 within scope | duplicate cluster → merge proposal |
| no links AND never accessed | orphan flag |

Action ids are stable (`<memoryId>:<signal>`), duplicate-cluster canonical members
are the lexicographically smallest id, and executed action ids persist in `meta`
under `consolidate_applied_actions` so re-applying the same id is rejected.
