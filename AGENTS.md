# AGENTS.md

Guidance for AI coding agents. This file only points at the real docs and lists rules
not stated elsewhere — read the linked files before working here.

## Read first

| Doc | Covers |
| --- | --- |
| [DESIGN.md](DESIGN.md) | Authoritative design: architecture, data model, reliability engine, tool surface, stack pins (§3), repo layout (§7), session learnings (§11) |
| [README.md](README.md) | Install/run, `MEMORY_*` env config, maintenance CLI, explorer UI |
| [docs/tools.md](docs/tools.md) | Reference for all 10 MCP tools |
| [docs/reliability.md](docs/reliability.md) | Reliability formula, decay λ/tiers, lifecycle rules behind `consolidate` |

## Rules

- **Keep DESIGN.md current.** Update it in the same change set when you ship or change a
  feature — new behavior, replaced decisions, corrected stack/version facts. Stale design = bug.
- **Keep this file current too.** If your change invalidates any command, path, or claim
  here, update or delete that line in the same change set — a stale instruction is worse
  than none.
- Verify like CI does (`.github/workflows/ci.yml`, Node 22 + 24):
  `npm run lint && npm run typecheck && npm test`; when `ui/` is touched also
  `npm run ui:typecheck && npm run ui:build && npm run ui:test`.
- Orchestrator sessions live under `.orchestrator/<NN-slug>/` (gitignored). Never edit or
  reuse a past session's directory; number new ones (`01-`, `02-`, …) so `ls` orders them.
- Node ≥22, TypeScript ESM (`nodenext`: relative imports end in `.js`; `verbatimModuleSyntax`
  requires `import type`). Stack pins live in `package.json`; decisions in DESIGN.md §2–3.

## Tooling gotchas

- There is no eslint/prettier/biome by design — `npm run lint` is tsc-based dead-code
  checking (`--noUnusedLocals --noUnusedParameters --noUncheckedSideEffectImports`).
  Don't add a linter or reformat the tree unasked.
- `npm test` is not purely unit tests: `test/packaging.test.ts` runs `npm run build`,
  packs the tarball, installs it into a temp dir, and drives the compiled bins
  (`dist/cli.js`, `dist/src/index.js`) over stdio. While iterating, run one file:
  `npx vitest run test/core/recall.test.ts` (same pattern under `ui/`).
- The suite is offline-safe: tests inject fake embedding providers; the only real-model
  test (`test/embeddings/local.test.ts`) skips itself unless `.cache/models/` exists.
