import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { openDatabase } from '../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../src/db/schema.js';
import { createMemory, listMemories } from '../src/db/queries.js';
import type { EmbeddingProvider } from '../src/embeddings/types.js';
import { createServerFactory } from '../src/server.js';

const PROTOCOL_VERSION = '2026-07-28';
const REQUEST_STATE_KEY = 'mrtr-test-request-state-key-0123456789abcdef';

const fixedEmbedder = (): EmbeddingProvider => ({
  name: 'fake',
  dim: 384,
  embed: async () => {
    const v = new Float32Array(384);
    v[0] = 1;
    return [v];
  },
});

const mrtrEnvelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
};

const mrtrJson = (params: Record<string, unknown>, id = 1): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { ...params, _meta: mrtrEnvelope },
  });

const parseBody = async (
  response: Response,
): Promise<{ result?: any; error?: any; id?: any }> =>
  (await response.json()) as { result?: any; error?: any; id?: any };

const legacyJson = (method: string, params: Record<string, unknown>, id = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

const parseLegacyBody = async (
  response: Response,
): Promise<{ result?: any; error?: any; id?: any }> => {
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`no data line in legacy response: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length)) as { result?: any; error?: any; id?: any };
};

const vector = (components: number[]): Float32Array => {
  const v = new Float32Array(384);
  for (let i = 0; i < components.length; i += 1) v[i] = components[i];
  return v;
};

const seedConflictCandidate = (db: Database.Database, id: string): void => {
  createMemory(db, {
    id,
    title: 'near miss',
    content: 'related but distinct angle',
    type: 'fact',
    tier: 'long',
    source: 'user-stated',
  });
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(row.rowid),
    Buffer.from(vector([0.7, Math.sqrt(1 - 0.49)]).buffer),
  );
};

describe('MRTR interactive conflict resolution', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const build = (): ReturnType<typeof createMcpHandler> => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return createMcpHandler(
      createServerFactory({
        db,
        embedder: fixedEmbedder(),
        requestStateKey: REQUEST_STATE_KEY,
      }),
    );
  };

  const callRemember = (
    handler: ReturnType<typeof createMcpHandler>,
    params: Record<string, unknown>,
  ): Promise<Response> =>
    handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'remember',
        },
        body: mrtrJson(params),
      }),
    );

  const rememberArgs = { content: 'related but distinct angle restated', type: 'fact', interactive: true };

  it('with interactive opted in and a near-dupe found, returns an input-required result eliciting merge-vs-create', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const response = await callRemember(handler, { name: 'remember', arguments: rememberArgs });
    expect(response.status).toBe(200);
    const body = await parseBody(response);
    expect(body.result.resultType).toBe('input_required');
    expect(body.result.requestState).toBeTypeOf('string');
    expect(body.result.inputRequests.resolve.method).toBe('elicitation/create');
    const schema = body.result.inputRequests.resolve.params.requestedSchema;
    expect(schema.properties.action.enum).toEqual(['merge', 'create']);
    expect(listMemories(db)).toHaveLength(1);
  });

  it('a simulated retry carrying inputResponses plus byte-exact echoed requestState completes the merge branch', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const first = await parseBody(await callRemember(handler, { name: 'remember', arguments: rememberArgs }));
    const requestState = first.result.requestState as string;
    const second = await parseBody(
      await callRemember(handler, {
        name: 'remember',
        arguments: rememberArgs,
        inputResponses: {
          resolve: { action: 'accept', content: { action: 'merge', target: 'near-miss-0000' } },
        },
        requestState,
      }),
    );
    expect(second.result.resultType).toBe('complete');
    const outcome = JSON.parse(second.result.content[0].text as string) as {
      outcome: string;
      id?: string;
      result?: string;
    };
    expect(outcome.outcome).toBe('merged');
    expect(outcome.id).toBe('near-miss-0000');
    expect(listMemories(db)).toHaveLength(1);
  });
  it('a simulated retry choosing create forces a new memory past the near-dupe', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const first = await parseBody(await callRemember(handler, { name: 'remember', arguments: rememberArgs }));
    const requestState = first.result.requestState as string;
    const second = await parseBody(
      await callRemember(handler, {
        name: 'remember',
        arguments: rememberArgs,
        inputResponses: {
          resolve: { action: 'accept', content: { action: 'create' } },
        },
        requestState,
      }),
    );
    expect(second.result.resultType).toBe('complete');
    const outcome = JSON.parse(second.result.content[0].text as string) as {
      outcome: string;
      id?: string;
      result?: string;
    };
    expect(outcome.outcome).toBe('created');
    expect(outcome.id).toBeTypeOf('string');
    expect(listMemories(db)).toHaveLength(2);
    const created = listMemories(db).find((row) => row.id === outcome.id);
    expect(created?.content).toBe('related but distinct angle restated');
  });
  it('rejects a tampered requestState on retry', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const first = await parseBody(await callRemember(handler, { name: 'remember', arguments: rememberArgs }));
    const requestState = first.result.requestState as string;
    const flip = requestState[10] === 'A' ? 'B' : 'A';
    const tampered = requestState.slice(0, 10) + flip + requestState.slice(11);
    const second = await parseBody(
      await callRemember(handler, {
        name: 'remember',
        arguments: rememberArgs,
        inputResponses: {
          resolve: { action: 'accept', content: { action: 'merge', target: 'near-miss-0000' } },
        },
        requestState: tampered,
      }),
    );
    expect(second.error.code).toBe(-32602);
    expect(second.error.message).toBe('Invalid or expired requestState');
    expect(second.result).toBeUndefined();
  });
  it('without MRTR support (stateless legacy HTTP) the same call returns a normal result carrying the conflict candidates', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const response = await handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: legacyJson('tools/call', {
          name: 'remember',
          arguments: { content: 'related but distinct angle restated', type: 'fact', interactive: true },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await parseLegacyBody(response);
    expect(body.error).toBeUndefined();
    const outcome = JSON.parse(body.result.content[0].text as string) as {
      outcome: string;
      candidates?: string[];
      result?: string;
    };
    expect(outcome.outcome).toBe('conflict');
    expect(outcome.candidates).toEqual(['near-miss-0000']);
    expect(outcome.result).toContain('near-miss-0000');
  });
  it('without interactive opted in, the same modern call returns a plain conflict result', async () => {
    const handler = build();
    seedConflictCandidate(db, 'near-miss-0000');
    const body = await parseBody(
      await callRemember(handler, {
        name: 'remember',
        arguments: { content: 'related but distinct angle restated', type: 'fact' },
      }),
    );
    expect(body.result.resultType).toBe('complete');
    const outcome = JSON.parse(body.result.content[0].text as string) as {
      outcome: string;
      candidates?: string[];
    };
    expect(outcome.outcome).toBe('conflict');
    expect(outcome.candidates).toEqual(['near-miss-0000']);
  });
});
