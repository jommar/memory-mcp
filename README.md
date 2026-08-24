# memory-mcp

A standalone MCP server for persistent **agent memory** — short/long-term tiers,
measurable reliability, and lifecycle maintenance — backed by SQLite (FTS5 +
sqlite-vec) with local MiniLM embeddings. No external services, no API keys.

## Requirements

- Node.js >= 22
- The package ships compiled JavaScript, so no TypeScript toolchain is needed at
  runtime.

## Install

```sh
npm install @jommar/memory-mcp
```

Two executables are provided:

| Command | Purpose |
| --- | --- |
| `memory-mcp-server` | The MCP server (stdio by default, HTTP via `MEMORY_TRANSPORT`) |
| `memory-mcp` | Store maintenance CLI (`export`, `import`, `reindex`, `stats`) |

## Quickstart

### stdio (default)

Point your MCP client at the server binary:

```json
{
  "mcpServers": {
    "memory": {
      "command": "memory-mcp-server"
    }
  }
}
```

Or run it directly:

```sh
memory-mcp-server
```

With `npx`, select the server bin explicitly (installs the package on first use):

```sh
npx -y -p @jommar/memory-mcp memory-mcp-server
```

### HTTP (localhost only)

```sh
MEMORY_TRANSPORT=http memory-mcp-server
```

The HTTP endpoint binds to `127.0.0.1:3000` by default and serves both the modern
(2026-07-28) and legacy (2025-11-25) protocol revisions from the same endpoint, so
any MCP client can connect. The server is stateless — no session id is required.

### First run

The store is created automatically at `~/.memory-mcp/memory.db`. Embeddings are
**offline-first**: no model is downloaded unless you opt in.

```sh
# opt in to the one-time model download (about 90 MB, MiniLM-L6, q8 quantized)
MEMORY_EMBEDDING_OFFLINE=false memory-mcp-server
```

Until a model is available, `remember` and `recall` still work — they fall back to
keyword search only. Use the CLI `reindex` to backfill vectors after the model is
in place.

## Configuration

All configuration is via `MEMORY_*` environment variables (no config file):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_DB_PATH` | `~/.memory-mcp/memory.db` | SQLite database file |
| `MEMORY_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MEMORY_HTTP_HOST` | `127.0.0.1` | HTTP bind host (localhost only) |
| `MEMORY_HTTP_PORT` | `3000` | HTTP bind port |
| `MEMORY_EMBEDDING_OFFLINE` | `true` | `false` opts in to the one-time model download |
| `MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS` | `300000` | Timeout for a model download attempt |
| `MEMORY_EMBEDDING_CACHE_DIR` | `~/.memory-mcp/cache` | Where downloaded models are cached |

## Tools

Ten tools are registered: `remember`, `recall`, `get`, `update`, `forget`, `list`,
`confirm`, `contradict`, `promote`, `consolidate`. See [docs/tools.md](docs/tools.md)
for the full reference with inputs and behaviors.

`remember` accepts an `interactive` opt-in: when it finds near-duplicate entries it
can ask the client to merge or create (MRTR), and degrades gracefully for clients
without interactive support.

## Maintenance CLI

```sh
memory-mcp export ./out      # write every memory as a markdown frontmatter file
memory-mcp import ./staging  # validate, then import (never overwrites existing keys)
memory-mcp reindex           # rebuild FTS + vector indexes from stored content
memory-mcp stats             # print store counts
```

## Documentation

- [docs/tools.md](docs/tools.md) — tool reference
- [docs/reliability.md](docs/reliability.md) — reliability model and lifecycle rules
  (the report-only maintenance engine behind `consolidate`)

## License

MIT — see [LICENSE](LICENSE).
