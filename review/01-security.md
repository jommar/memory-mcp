# Round-01 Security Review — items 1–6 (scaffold, db, schema+FTS5, vec0, provider interface, local MiniLM)

Scope: uncommitted new code since 10fabc4 — `src/db/*`, `src/embeddings/*`, `src/index.ts`, `test/*`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`. Threat model per DESIGN.md §9: local-first personal MCP server, localhost-only HTTP, no auth in v1. Enterprise hardening intentionally out of scope.

**Verdict: FINDINGS (0 BLOCKING, 4 MINOR)**

## Findings

1. **MINOR — dependency risk (transitive, no fix available): sharp <0.35.0**
   - `package-lock.json` (resolved `node_modules/sharp`), pulled transitively by `@huggingface/transformers` 4.2.0.
   - `npm audit` reports **4 high advisories**, range `<0.35.0`, `fixAvailable: false` at current root pins. sharp is the image-preprocessing path of transformers.js and is never exercised by this text-embedding server (`pipeline('feature-extraction', ...)` at src/embeddings/local.ts:24), so exploitability here is low — but it sits in the prod dependency tree of every install.
   - Recommendation: track upstream; when transformers.js ships a sharp ≥0.35-compatible release (or a way to omit image codecs), bump. No action blocking round 01.

2. **MINOR — file permissions on the memory DB / WAL files**
   - `src/db/connection.ts:9` — `new Database(path)` creates the db plus `-wal`/`-shm` siblings with umask defaults (typically 0644, world-readable).
   - Memory content is sensitive personal context; on any multi-user host or shared machine other local accounts could read it. Single-user laptop: acceptable today.
   - Recommendation: after open, `fs.chmodSync(path, 0o600)` (and siblings) or document a restrictive umask requirement in DESIGN.md.

3. **MINOR — network egress enabled by default where "offline-first" is expected**
   - `src/embeddings/local.ts:46` — `offline` defaults to `false`; on cache miss `loadTransformersModel` (local.ts:23–28) silently fetches model weights from the Hugging Face CDN. Embedding text itself never leaves the machine (inference is local), so this is a one-time download, not data exfiltration — but for a local-first product an implicit network fetch is surprising and can hang without timeout handling.
   - Recommendation: consider honoring `HF_HUB_OFFLINE`/env gate, or make offline the documented default with an explicit opt-in flag for first-run download.

4. **MINOR (forward-looking) — FTS5 MATCH construction from user text not yet implemented**
   - Current slice contains no user-text-to-SQL path: all statements are static strings with bound parameters (`?`), including KNN `WHERE embedding MATCH ? AND k = ?` (test/db/vector-schema.test.ts:56) and FTS `MATCH 'literal'` in tests. `${TRACKING_TABLE}` interpolation (src/db/schema.ts:93,105) is a module constant — safe.
   - When the search tool (later phase) builds FTS5 MATCH queries from user input, raw user strings are query *syntax* to FTS5 (quotes/operators can break out or crash the match, e.g. unbalanced `"`) even via bound parameters. Plan ahead: bind as parameter AND escape/quote terms (e.g. wrap tokens in `"..."` with internal quotes doubled). Flagging now so it isn't retrofitted incorrectly.

## Checked clean

- **SQL injection:** all runtime SQL uses prepared statements with bound params; migration bodies are code-controlled constants executed via `db.exec` (src/db/schema.ts:122). No string interpolation of external input anywhere in `src/`.
- **Path traversal:** only paths handled are caller-supplied db path (`openDatabase`) and cache dir defaulting under `$HOME/.memory-mcp/cache` (src/embeddings/local.ts:12); tests use `mkdtempSync` temp dirs. No traversal surface in this slice (no server/tool layer yet).
- **Secret leakage:** grep across changed files found no API keys/tokens/passwords; nothing is logged; error messages expose only provider names and dims (src/embeddings/types.ts:28,33); test fixtures use synthetic data only. `.gitignore` excludes `.cache/` (model weights) and logs.
- **Unsafe deserialization:** none — inputs are strings/Float32Array buffers into SQLite bindings; no dynamic eval/deserialize.
- **vec0/KNN + dim guard:** dimension enforced both by schema (`float[384]`, rejects wrong-dim inserts) and meta guard (types.ts:26) — mismatch throws rather than silently corrupting vectors. BigInt binding noted for rowid safety.
- **Migration atomicity:** failing migration rolls back its tracking row transactionally (schema.ts:121–124) — no half-applied-state integrity hole.
