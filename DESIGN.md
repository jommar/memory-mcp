# memory-mcp — Design Document

Status: approved design, implementation not started
Decided: 2026-08-24 (design session)
Next: run orchestrator skill (`investigate – plan` segment), then checkpoint before implementation

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
| Test/tooling | vitest, eslint, GitHub Actions |

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

Import/export/reindex = CLI subcommands (`memory-mcp export|import|reindex`), not tools.
Markdown frontmatter format modeled on wiki-v2's import/export contract (key/title/tags/parent).

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
├── test/                   # vitest unit + integration (in-memory SQLite)
├── docs/                   # tool reference, reliability model
└── README.md
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

## 12. Open items (resolve during implementation)

- Exact consolidation thresholds tuning (defaults above are starting values)
- npm package scope/name (@scope/memory-mcp vs bare memory-mcp)
- Config var naming (MEMORY_* prefix) and config-file support (v1: env only)
- Whether `consolidate` runs automatically on server start or only on demand (lean: on demand)
