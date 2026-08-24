# AGENTS.md

Guidance for AI coding agents working in this repo.

## Source of truth

- `DESIGN.md` is the authoritative design document: architecture, data model,
  reliability engine, tool surface, stack pins, and phase plan.
- **Keep DESIGN.md current.** When you ship or change a feature, update DESIGN.md in
  the same change set — new behavior, replaced decisions, corrected stack/version facts.
  Stale design = bug. Implementation never drifts from it silently.

## Working conventions

- Orchestrator sessions live under `.orchestrator/<NN-slug>/` (gitignored) — never edit
  or reuse a past session's directory.
- Tests: `npm test` (vitest). Lint/typecheck before handing work back.
- Node ≥22, TypeScript ESM. Stack pins live in `package.json` and DESIGN.md §3/Defaults.
