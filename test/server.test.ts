import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { openDatabase } from '../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../src/db/schema.js';
import { getMemory } from '../src/db/queries.js';
import type { EmbeddingProvider } from '../src/embeddings/types.js';
import { createServerFactory, TOOL_DEFINITIONS, TOOL_NAMES } from '../src/server.js';

const PROTOCOL_VERSION = '2026-07-28';

const fixedEmbedder = (): EmbeddingProvider => ({
  name: 'fake',
  dim: 384,
  embed: async () => {
    const v = new Float32Array(384);
    v[0] = 1;
    return [v];
  },
});

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const modernJson = (method: string, params: Record<string, unknown>, id = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } });

const legacyJson = (method: string, params: Record<string, unknown>, id = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

const parseModernBody = async (response: Response): Promise<{ result?: any; error?: any; id?: any }> =>
  (await response.json()) as { result?: any; error?: any; id?: any };

const parseLegacyBody = async (response: Response): Promise<{ result?: any; error?: any; id?: any }> => {
  const text = await response.text();
  const dataLine = text
    .split('\n')
    .find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`no data line in legacy response: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length)) as { result?: any; error?: any; id?: any };
};

describe('MCP server factory (item 14)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const build = (): ReturnType<typeof createMcpHandler> => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return createMcpHandler(createServerFactory({ db, embedder: fixedEmbedder() }));
  };

  describe('tool registry', () => {
    it('defines exactly the ten DESIGN §6 tools in one registry array', () => {
      expect(TOOL_NAMES).toEqual([
        'remember',
        'recall',
        'get',
        'update',
        'forget',
        'list',
        'confirm',
        'contradict',
        'promote',
        'consolidate',
      ]);
      expect(TOOL_DEFINITIONS).toHaveLength(10);
    });

    it('serves the ten tools over tools/list with no session id', async () => {
      const handler = build();
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Mcp-Method': 'tools/list' },
          body: modernJson('tools/list', {}),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const body = await parseModernBody(response);
      expect(body.result.resultType).toBe('complete');
      const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
      expect(names).toEqual(TOOL_NAMES);
    });
  });

  describe('modern era (2026-07-28) requests', () => {
    it('creates a memory through the remember tool, observable in the store', async () => {
      const handler = build();
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'remember',
          },
          body: modernJson('tools/call', { name: 'remember', arguments: { content: 'Prefer local-first tooling', type: 'fact' } }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await parseModernBody(response);
      expect(body.result.resultType).toBe('complete');
      const outcome = JSON.parse(body.result.content[0].text as string) as {
        outcome: string;
        id?: string;
      };
      expect(outcome.outcome).toBe('created');
      expect(getMemory(db, outcome.id!)).toBeDefined();
    });

    it('recalls through the recall tool and returns a markdown bundle', async () => {
      const handler = build();
      await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'remember',
          },
          body: modernJson('tools/call', { name: 'remember', arguments: { content: 'uniquely findable phrase zqx', type: 'fact' } }),
        }),
      );
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'recall',
          },
          body: modernJson('tools/call', { name: 'recall', arguments: { query: 'uniquely findable' } }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await parseModernBody(response);
      const markdown = body.result.content[0].text as string;
      expect(markdown).toContain('# Recall: uniquely findable');
      expect(markdown).toContain('uniquely findable phrase zqx');
    });
  });

  describe('legacy-era requests via the stateless fallback', () => {
    it('answers a claim-less tools/list over SSE with all ten tools', async () => {
      const handler = build();
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: legacyJson('tools/list', {}),
        }),
      );
      expect(response.status).toBe(200);
      const body = await parseLegacyBody(response);
      const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
      expect(names).toEqual(TOOL_NAMES);
    });

    it('answers a claim-less remember over SSE and persists the memory', async () => {
      const handler = build();
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: legacyJson('tools/call', { name: 'remember', arguments: { content: 'legacy era note', type: 'fact' } }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await parseLegacyBody(response);
      const outcome = JSON.parse(body.result.content[0].text as string) as { outcome: string; id?: string };
      expect(outcome.outcome).toBe('created');
      expect(getMemory(db, outcome.id!)).toBeDefined();
    });
  });
});

describe('tool error handling at the seam', () => {
  it('surfaces a missing-memory error as a tool error result, not a protocol failure', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    const handler = createMcpHandler(createServerFactory({ db }));
    const response = await handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'get',
        },
        body: modernJson('tools/call', { name: 'get', arguments: { key: 'does-not-exist' } }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await parseModernBody(response);
    expect(body.result.isError).toBe(true);
    expect((body.result.content[0].text as string).toLowerCase()).toContain('not found');
    db.close();
  });
});
