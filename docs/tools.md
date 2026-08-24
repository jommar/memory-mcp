# Tool reference

All ten tools are registered by the MCP server (`memory-mcp-server`) and listed by
`tools/list`. Inputs follow the JSON Schema derived from each tool's definition.

## remember

Store a memory. Checks for near-duplicates against same-scope active entries:

- cosine **> 0.88** → `merged:<key>` (no write)
- cosine in **(0.6, 0.88]** → `conflict:[candidates]` (no write)
- otherwise → `created` (writes the memory)

Auto-generates a key when none is supplied and defaults the tier by type
(`session`/`project-state` → `short` with STM TTL; others → `long`).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `content` | string | yes | The memory body |
| `title` | string | no | Defaults to `content` |
| `type` | string | no | `preference`, `decision`, `fact`, `procedure`, `person`, `project-state`, `lesson`, `session` (default `fact`) |
| `scope` | string | no | Default `global` |
| `tags` | string[] | no | |
| `source` | string | no | `user-stated`, `agent-inferred`, `agent-guessed` |
| `importance` | integer | no | 1–5 (default 3) |
| `interactive` | boolean | no | Opt in to MRTR merge-vs-create on conflict |

With `interactive: true` on a modern (2026-07-28) request, a mid-band conflict
returns an `input_required` result; the client's merge/create choice completes the
write on retry. Clients without interactive support get the plain
`conflict:[candidates]` result instead.

## recall

Hybrid search: full-text (bm25) + semantic (cosine) legs fused with RRF, ranked by
reliability × importance, then hard-filtered by scope/tier/status. Returns a
markdown bundle with scores and 1-hop linked entries. Marks returned memories as
accessed.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | |
| `scope` | string | no | |
| `tier` | string | no | `short` \| `long` |
| `status` | string | no | `active` (default) \| `superseded` \| `archived` \| `expired` |
| `limit` | integer | no | 1–100 |

## get

Fetch one memory by id with its supersession chain and optional edit history.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |
| `withHistory` | boolean | no |

## update

Update a memory. A `content` change appends a history row (recording
content-before/after) and requires a `reason`; non-content updates record no
history entry.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |
| `content` | string | no |
| `title` | string | no |
| `scope` | string | no |
| `tags` | string[] | no |
| `importance` | integer | no |
| `reason` | string | no |

## forget

Archive a memory by default; `purge` deletes the row plus its links, history, and
vector entry.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |
| `purge` | boolean | no |

## list

List memories filtered by scope, tier, type, and status.

| Field | Type | Required |
| --- | --- | --- |
| `scope` | string | no |
| `tier` | string | no |
| `type` | string | no |
| `status` | string | no |

## confirm

Confirm a memory by id or query: advances `last_confirmed_at`, increments
`observed_count`, and raises confidence.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |

## contradict

Record a correction: creates a new superseding entry, marks the old entry
`superseded` (with `superseded_by` set), and links them with kind `contradicts`.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |
| `content` | string | yes |
| `title` | string | no |
| `type` | string | no |
| `scope` | string | no |
| `source` | string | no |
| `importance` | integer | no |

## promote

Promote a short-term memory to the long tier and clear its expiry.

| Field | Type | Required |
| --- | --- | --- |
| `key` | string | yes |

## consolidate

Report maintenance signals, or apply the named action ids from the last report.
Nothing mutates without an explicit `apply`.

| Field | Type | Required |
| --- | --- | --- |
| `apply` | string[] | no |

With no `apply`, returns the heuristic report (expired STM, archive candidates,
re-confirm queue, needs-expansion, duplicate clusters, orphans). With `apply`,
executes only the named action ids and returns per-id outcomes. See
[reliability.md](reliability.md) for the signals and thresholds.
