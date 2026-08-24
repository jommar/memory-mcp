# memory-mcp — Design Document

Status: approved design, implementation complete (core + CLI + explorer UI)
Decided: 2026-08-24 (design session)
Next: phase-2 UI work (consolidate visualization) when picked up

---

## 1. Purpose

A standalone, publishable MCP server for personal agent memory: short/long-term tiers,
measurable reliability driving lifecycle (expand / re-confirm / archive / expire).
Replaces the current deployment where a wiki-v2 Postgres+pgvector server is re-skinned as
"memory" via env vars (WIKI_ID=memory, DB_NAME=memory) — same code, wrong semantics.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Build approach | Greenfield rewrite (no fork of wiki-v2) |
| Storage | SQLite (better-sqlite3, WAL) + sqlite-vec + FTS5 |
| Audience | Publishable open source (zero-config DX matters) |
| Maintenance | Pure heuristics + report; nothing destructive without explicit apply |
| Language/runtime | TypeScript ESM, Node 20+ |
| MCP SDK | v2 split packages on the stateless 2026-07-28 spec |
| Name | `memory-mcp` |
| Migration of old store | Manual — memories re-created natively; no importer |

## 3. Stack (verified against live sources 2026-08-24)

| Layer | Choice |
|---|---|
| Server SDK | `@modelcontextprotocol/server@^2.0.0` (stable on npm; deps: zod ^4.2, @modelcontextprotocol/core 2.0.0) |
| Schemas | Zod v4 via Standard Schema |
| Transports | stdio (`@modelcontextprotocol/server/stdio`) + stateless HTTP via `createMcpHandler` — serves `2026-07-28` per request and legacy `2025-11-25` clients from the same endpoint |
| Vector search | sqlite-vec vec0 virtual tables (KNN: MATCH + LIMIT k); dimension pinned in a meta table |
| Full-text | SQLite FTS5 with bm25() ranking |
| Embeddings | Pluggable provider interface; default local MiniLM-L6 (Xenova/all-MiniLM-L6-v2, mean pooling, normalize, 384-dim) via @huggingface/transformers v3; optional OpenAI/Ollama providers |
| Test/tooling | vitest, tsc-based lint (unused/dead-code checks), GitHub Actions |
| Explorer UI | React 19 + Vite 8 + TypeScript SPA; React Flow (@xyflow/react) graph with dagre layout; read-only `node:http` API server (zero new server deps); cytoscape was replaced by React Flow during build for richer node cards |

Spec notes:
- Stateless core: no initialize handshake / Mcp-Session-Id; any instance serves any request.
- **MRTR (`InputRequiredResult`) is in TS SDK v2** — use for optional interactive
  conflict resolution in `remember()` ("found near-duplicates X/Y: merge or create?").
  Clients without MRTR support get graceful degradation (conflict info in the response).
- API shapes per blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28:
  `new McpServer({name, version})`, `server.registerTool(name, {description, inputSchema}, handler)`,
  codemod + migration guides live in the typescript-sdk repo (`docs/migration/upgrade-to-v2.md`,
  `support-2026-07-28.md`). Re-verify exact signatures during Phase 1.

## 4. Data model

```sql
memories(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,          -- preference|decision|fact|procedure|person|project-state|lesson|session
  tier TEXT NOT NULL,          -- short|long
  scope TEXT DEFAULT 'global', -- global | project slug
  tags TEXT,                   -- JSON array
  status TEXT DEFAULT 'active',-- active|superseded|archived|expired
  superseded_by TEXT,          -- id of replacement entry
  source TEXT NOT NULL,        -- user-stated|agent-inferred|agent-guessed
  importance INTEGER DEFAULT 3,-- 1..5
  confidence REAL,             -- base from source at write time
  observed_count INTEGER DEFAULT 0,   -- corroborations + useful recalls
  contradiction_count INTEGER DEFAULT 0, -- open contradictions
  created_at TEXT, updated_at TEXT,
  last_accessed_at TEXT, last_confirmed_at TEXT,
  expires_at TEXT              -- STM only; NULL for long tier
);
memories_fts(title, content, tags);        -- FTS5
memories_vec(embedding float[384]);        -- vec0; dim recorded in meta table
links(from_id, to_id, kind);               -- related|supersedes|contradicts
history(memory_id, content_before, content_after, reason, changed_at);
meta(key, value);                          -- schema version, embedding provider + dim
```

Type → recency decay λ (per day, for reliability): preference .002 · person/project .003 ·
decision/lesson .005 · fact .01 · session-state .1.
STM default TTL by type: session 24h · project-state 14d (configurable).

## 5. Reliability engine (pure heuristics, computed at read)

```
base    = user-stated 1.0 · agent-inferred 0.7 · agent-guessed 0.4
recency = exp(-λ_type × days_since(last_confirmed_at ?? created_at))
corrob  = 1 + min(0.5, observed_count × 0.05)
penalty = 0.7 ^ open_contradictions
reliability = clamp(base × recency × corrob × penalty, 0, 1)
```

Lifecycle rules surfaced by `consolidate`:

| Signal | Action proposed |
|---|---|
| STM past expires_at | expire (auto-safe) |
| reliability < ~0.35 AND last_access > 90d AND importance ≤ 2 | archive candidate |
| stale past type-TTL AND importance ≥ 3 | re-confirm queue |
| access_count ≥ ~10 AND thin content (< ~400 chars) | needs expansion |
| pairwise cosine > ~0.92 within scope | duplicate cluster → merge proposal |
| no links AND never accessed | orphan flag |

All thresholds configurable; report-only until `apply` names specific action ids.

### Resolved at implementation (v1)

Locked Defaults-block values plus the gaps they left, settled during items 11–13:

- **remember() dedupe/conflict bands** — cosine > 0.88 → `merged:<key>`; cosine in (0.6, 0.88] → `conflict:[candidates]` with no write; candidates are same-scope active memories. The 0.6 conflict floor is new (Defaults block only pinned 0.88).
- **Tier default by type** — `session` and `project-state` default to `short` with STM TTLs (24h / 14d); every other type defaults to `long` with no expiry.
- **procedure λ** — §4's decay table omits `procedure`; defaulted to 0.005 (same as decision/lesson).
- **re-confirm staleness** — stale = days since (`last_confirmed_at` ?? `created_at`) exceeds `ln(2)/λ_type` (i.e. recency factor < 0.5), with `importance ≥ 3`.
- **needs-expansion access proxy** — v1 has no `access_count` column; `observed_count` (confirmations + useful recalls) is the proxy at ≥ 10, content < 400 chars.
- **consolidate applied-action ledger** — executed action ids persist in `meta` under key `consolidate_applied_actions` (append-only JSON; no migration). Action ids are stable: `` `${memoryId}:${signal}` ``; duplicate-cluster canonical member is the lexicographically smallest id.
- **recall defaults** — the status hard filter defaults to `active`; both bm25 and cosine legs run unconditionally (no sequential fallback); FTS5 query tokens are quoted (embedded quotes doubled) before MATCH.
- **embeddings** — `EmbeddingProvider` gained an optional `reset()` so a failed model load can be retried (local.ts clears its memoized load promise).
- **MEMORY_* config surface (item 14)** — finalized var names: `MEMORY_DB_PATH` (default `~/.memory-mcp/memory.db` per §7), `MEMORY_TRANSPORT` (`stdio` | `http`, default `stdio`), `MEMORY_HTTP_HOST` (default `127.0.0.1` — HTTP binds localhost only per §9), `MEMORY_HTTP_PORT` (default `3000`), `MEMORY_EMBEDDING_OFFLINE` (default `true`), `MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS` (default `300000`), `MEMORY_EMBEDDING_CACHE_DIR` (default `~/.memory-mcp/cache`). Env-only, no config file (§12). Resolves the §12 config-var-naming open item.
- **offline-first embeddings (item 14, resolves security follow-up M2)** — the local provider defaults to `offline: true`, so a cache miss never triggers an implicit HF CDN fetch; first-run model download is an explicit opt-in (`MEMORY_EMBEDDING_OFFLINE=false`) guarded by `MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS`. A timed-out load clears the provider's memoized load promise so the next embed retries; non-timeout load failures keep requiring `reset()`. Both knobs flow from `src/config.ts` through `src/index.ts` into `createLocalEmbeddingProvider`.
- **MRTR interactive conflict resolution (item 15)** — `remember` gains an `interactive` opt-in. On a modern (2026-07-28) request with a mid-band conflict it returns an `input_required` result eliciting merge-vs-create; the chosen branch completes on a retry that carries `inputResponses` plus a byte-exact echoed `requestState`. `requestState` is integrity-protected with `createRequestStateCodec` (HMAC-SHA256, optional `ServerDependencies.requestStateKey`, per-process random default), wired via `ServerOptions.requestState.verify`; tampered state is refused with `-32602`. Merge resolves to `merged:<target>` with no write; create forces the write past dedupe (`RememberOptions.force`). On stateless legacy HTTP (no envelope) the handler degrades to the plain `conflict:[candidates]` result — no protocol error.
- **Packaging, docs and CI (item 17)** — the package compiles to `dist/` (`tsconfig.build.json`, `npm run build`, run by `prepare`); the tarball ships compiled JS plus the `.ts` sources. Bins: `memory-mcp` → `dist/cli.js` and `memory-mcp-server` → `dist/src/index.js`. Both `cli.ts` and `src/index.ts` direct-invocation guards compare `realpathSync(argv[1])` vs the module path so the npm `.bin` symlinks fire correctly from a clean install. Node refuses type-stripping under `node_modules`, so raw-TS bins are impossible — hence the compile step. Lint is tsc-based (`--noUnusedLocals --noUnusedParameters --noUncheckedSideEffectImports`) rather than eslint — minimal, zero new deps, green on this repo (removed five dead imports to get there). README quickstart covers stdio + HTTP + all `MEMORY_*` vars; `docs/tools.md` documents the ten tools; `docs/reliability.md` summarizes DESIGN §5; LICENSE is MIT; CI runs lint + typecheck + tests on push/PR on Node 22 and 24.
- **CLI (item 16)** — `memory-mcp export|import|reindex|stats` subcommands: `export <outDir>`, `import <stagingDir>`, `reindex`, `stats`; config comes from `MEMORY_*` env vars only (no CLI flags beyond the positional dirs; `--help`/no-command print usage). **Export** writes one markdown frontmatter file per memory (`<outDir>/<key>.md`, atomic tmp+rename, no `.tmp` leftovers), fields in order `key/title/tags/parent/type` where `parent` = the memory's `scope`; `tags` omitted when empty; values containing `:`/`#`/`"` (or empty/whitespace-edged) are double-quoted with `"` escaped — the known-good edge-case list from wiki-v2's contract. **Import** requires `key` (`^[a-z0-9-]+$`), `title`, `parent`, `type` (enum) per frontmatter block; `tags` optional (bracketed list, default `[]`). Multi-section files and concatenated files are tolerated; blocks without a `key` are ignored as preamble; a trailing `---` belongs to the previous body. Every staged file is parsed and validated before anything is written; per-file quarantine moves failing files to `<staging>/fail/` (with a per-file error summary) and valid files to `<staging>/success/`; all accepted blocks insert in ONE transaction (no partial writes from a failing file). Keys already in the store — or declared earlier in the same batch — are refused with a provenance report (`skipped <key> from <file>: already exists in store | duplicate of a key declared in <file>`); existing rows are never overwritten. Exit code is 0 only when every block imported; any refused key or quarantined file exits 1. Imported memories re-derive lifecycle fields (tier + STM expiry by type per §5, source `user-stated`, status `active`, importance 3) and write **no vectors** — `reindex` backfills them. **Reindex** rebuilds FTS5 (`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`) and wipes + re-embeds every `memories_vec` row from stored `content` (embedding text matches `remember()`'s write path, not title+content); a vector failure leaves FTS rebuilt, reports on stderr, exits 1. **Stats** prints memory counts by tier and status plus link count. Body content with a `---`-only line does not roundtrip (contract limitation inherited from wiki-v2); links/history/timestamps/status are not part of the v1 export/import contract.
- **Explorer UI (item 18)** — read-only visual explorer in the `ui/` npm workspace (not published). Architecture: `ui/server` is a plain `node:http` JSON API (zero new server deps) serving `GET /api/graph`, `/api/memory/:id` (row + reliability factor breakdown via `memoryReliabilityFactors`, history, supersession chain, neighbor links), `/api/stats`, `/api/consolidate`, plus the built SPA from `ui/dist` with SPA fallback and a `safeJoin` traversal guard; `ui/app` is a Vite 8 + React 19 SPA rendering the links graph with React Flow (`@xyflow/react`) — card-style custom nodes (type chip, importance, reliability bar), edges styled per kind (`related` solid gray, `supersedes` dashed blue arrow, `contradicts` red animated), minimap + controls, dark `colorMode`. Cytoscape was the first choice and was replaced mid-build for richer node rendering. Layout is deterministic d3-force (`d3-force`, replaced dagre after it collapsed mostly-unlinked stores into a single column): force simulation with type-anchor forces on a 4×2 region grid, link/charge/collide forces, golden-angle seeded init + fixed tick count, computed once per graph payload client-side so filtering never reshuffles positions. A **maintenance drawer** (phase 2) lists `consolidate` proposals grouped by signal with click-to-select on the graph and clickable duplicate-cluster member chips — report-only; applying stays with the MCP tool. Data access opens the SQLite file via a new `openDatabaseReadOnly` (`better-sqlite3 { readonly: true }` — writes throw at the SQL layer; sqlite-vec still registered because `consolidateReport` queries `memories_vec`), so the UI cannot mutate the store and works while the MCP server is live (WAL). New read helpers: `listLinks`, `listHistory` (src/db/queries.ts); `reliabilityFactors`/`memoryReliabilityFactors` exports (src/core/reliability.ts). Config: `MEMORY_DB_PATH` shared with the server, `MEMORY_UI_PORT` (default 3001) with EADDRINUSE auto-increment up to 10 attempts (3001–3010) then a clear error; host hard-wired 127.0.0.1. Tests: payload unit tests + fetch-level HTTP integration + `safeJoin` traversal cases + port-retry (increment and budget-exhaustion) in `ui/test/`; CI runs `ui:typecheck` + `ui:build` + `ui:test` after the root job steps.

## 6. Tool surface (10)

| Tool | Behavior |
|---|---|
| `remember(content, opts)` | one-shot write; dedupe check (cosine > ~0.88) → returns `created \| merged:key \| conflict:[candidates]`; auto key generation; tier defaults by type; `interactive` opt-in uses MRTR to ask mid-call |
| `recall(query, opts)` | hybrid bm25 + KNN → RRF fuse → weight reliability × importance; hard filters scope/tier/status; markdown bundle with scores + 1-hop links; records last_accessed |
| `get(key)` | entry + optional history/supersession chain |
| `update(key, content, opts)` | reason required-ish; writes history row |
| `forget(key, opts)` | archive default; `purge` opt-in severs backlinks |
| `list(opts)` | filter scope/tier/type/status |
| `confirm(key\|query)` | bumps last_confirmed_at, observed_count++, raises confidence |
| `contradict(key, correction, opts)` | creates superseding entry, old → superseded, link kind=contradicts |
| `promote(key)` | short → long tier; clears expires_at |
| `consolidate(opts)` | heuristic report (§5); `apply: [actionIds]` executes selections |

Import/export/reindex = CLI subcommands (`memory-mcp export|import|reindex|stats`), not tools.
Markdown frontmatter format modeled on wiki-v2's import/export contract (key/title/tags/parent,
plus `type`); finalized CLI behavior and flags in §5 "Resolved at implementation".

## 7. Repo layout

```
/home/dev/mcp/memory-mcp/
├── src/
│   ├── index.ts            # entrypoint: config, transport selection (stdio | http)
│   ├── server.ts           # McpServer setup + registerTool wiring
│   ├── config.ts           # env vars + zero-config defaults (~/.memory-mcp/memory.db)
│   ├── db/{schema,connection,queries}.ts
│   ├── core/{remember,recall,reliability,lifecycle,links}.ts
│   └── embeddings/{types,local,openai,ollama}.ts
├── cli.ts                  # export/import/reindex/stats
├── src/index.ts + cli.ts compile to dist/ (tsconfig.build.json, `npm run build`)
├── ui/                     # explorer UI workspace (dev tool, not published)
│   ├── server/{api,http,index}.ts   # read-only JSON API + static server (tsc → dist-server/)
│   ├── src/                # React SPA (vite → dist/): GraphView, DetailPanel, Filters, StatsBar
│   ├── test/               # vitest: api payloads, http integration, safeJoin, port retry
│   └── tsconfig{,.server,.test}.json
├── test/                   # vitest unit + integration (in-memory SQLite)
├── docs/                   # tool reference, reliability model
├── .github/workflows/ci.yml # lint + typecheck + test + ui:typecheck + ui:build + ui:test (Node 22/24)
├── README.md
└── LICENSE                 # MIT
```

Search pipeline detail: FTS5 bm25 + vec0 cosine → RRF fusion → multiply reliability &
importance weights → hard filters applied → side-effect access tracking on returned ids.

## 8. Implementation phases (each ends verified)

1. Scaffold + DB layer: migrations runner, FTS5 + vec0 smoke tests
2. Embeddings: provider interface, local MiniLM, dim guard vs meta table
3. Core CRUD + links + history
4. `remember()` pipeline: dedupe/conflict branches unit-tested
5. `recall()` ranking: seeded golden-set ordering assertions
6. Lifecycle: rule-table tests for every consolidate action
7. Server wiring: stdio + stateless HTTP; MCP Inspector + SDK conformance suite;
   verify legacy-revision fallback works
8. CLI: export/import roundtrip test
9. OSS polish: README, docs, CI, MIT license, npm packaging (`npx`-friendly)

Pause points between phases are safe; plan.md checklist will track progress.

## 9. Out of scope (v1)

Auth / multi-user (HTTP binds localhost only) · LLM-assisted maintenance · embedding-dim
migration without reindex · auto-migration of existing memory store · remote-host hardening.

## 10. Reference material

- Prior-art codebase (read-only mining): `/home/dev/mcp/wiki-v2/` (+ identical fork copy
  `/home/dev/mcp/memory/`). Worth extracting: tsvector trigger pattern, trigram index,
  HNSW m=16/ef=200 params, section_links/history dual-path content_before, forward-only
  migration runner, embedding lazy-load pattern, markdown frontmatter contract, full
  ~17-tool inventory (to stay sharper at 10), pitfalls visible in migration fixups
  (004_trigger_fk replaced 003; api_keys wiki_ids dropped in 006).
- Old store stays online read-only during transition: docker `wiki-v2-server`
  (WIKI_ID=memory, DB_NAME=memory, 122 sections). User migrates content manually by
  using the new server natively.
- Spec/SDK: MCP 2026-07-28 final (Linux Foundation AAIF). Blog post sdk-betas-2026-07-28;
  draft spec changelog at modelcontextprotocol.io/specification/draft/changelog.

## 11. Operational notes (session learnings, 2026-08-24)

- Orchestrator convention (user requirement): session dirs numbered `.orchestrator/01-*`,
  `02-*`, … so `ls` orders sessions.
- Subagent dispatch quirks (updated session `01-mvp`, supersedes the earlier
  brief-file theory): (a) transient provider `network_error` on dispatch → simply retry;
  (b) **silent-empty** completions ("completed" instantly, empty result, nothing written)
  occur even when the full brief is inlined verbatim — prompt length and
  brief-file-vs-inline are NOT the cause; resuming those sessions returns empty too, so
  never recover via resume; (c) tiny probes (plain reply, single web lookup) and
  small-scope tasks (one-file mining) succeed consistently → on repeated empties,
  **split the work into several smaller single-topic dispatches** instead of resending
  the same large one; (d) subagents must create files via bash heredocs — their
  Write/Edit tools hit the permission wall silently; (e) keep briefs under
  `.orchestrator/<session>/briefs/` as audit trail and paste the brief content into the
  dispatch prompt verbatim.
- Env facts: Node v25.8.0 on PATH; companion scripts at
  `/home/jommar/.claude/skills/dispatch/` (persona-builder.mjs, write-handoff.mjs);
  personas mmc-context-priorart / mmc-context-stack already exist in its personas/ dir.

## 12. Open items

Resolved during implementation:

- npm package scope/name → `@jommar/memory-mcp` (package.json, published)
- Config var naming → `MEMORY_*` env-only, finalized in item 14 (+ `MEMORY_UI_PORT` in item 18)
- `consolidate` on server start vs on demand → **on demand** (v1 shipped report-only on demand)

Still open:

- Exact consolidation threshold tuning (defaults are starting values; needs real-store usage data)
