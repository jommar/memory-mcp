import crypto from 'node:crypto';
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  isInputRequiredResult,
  type InputRequiredResult,
  type McpRequestContext,
  type McpServerFactory,
  type RequestStateCodec,
  type ServerContext,
  McpServer,
} from '@modelcontextprotocol/server';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { remember, type RememberInput, type RememberResult } from './core/remember.js';
import { recall } from './core/recall.js';
import {
  forgetMemory,
  getMemory,
  listMemories,
  updateMemory,
} from './db/queries.js';
import {
  applyConsolidate,
  confirmMemory,
  consolidateReport,
  contradictMemory,
  promoteMemory,
} from './core/lifecycle.js';
import { supersessionChain } from './core/links.js';
import type { EmbeddingProvider } from './embeddings/types.js';

export const SERVER_NAME = 'memory-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerDependencies {
  db: Database.Database;
  embedder?: EmbeddingProvider | null;
  requestStateKey?: string;
}

interface RememberState {
  input: RememberInput;
  candidates: string[];
}

const MEMORY_TYPE = z.enum([
  'preference',
  'decision',
  'fact',
  'procedure',
  'person',
  'project-state',
  'lesson',
  'session',
]);
const MEMORY_TIER = z.enum(['short', 'long']);
const MEMORY_STATUS = z.enum(['active', 'superseded', 'archived', 'expired']);
const MEMORY_SOURCE = z.enum(['user-stated', 'agent-inferred', 'agent-guessed']);

const jsonText = (value: unknown): string => JSON.stringify(value);

export interface ToolRunDeps extends ServerDependencies {
  requestStateCodec: RequestStateCodec<RememberState>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run(
    args: Record<string, unknown>,
    deps: ToolRunDeps,
    ctx?: ServerContext,
  ): string | InputRequiredResult | Promise<string | InputRequiredResult>;
}

const completeInteractiveRemember = async (
  deps: ToolRunDeps,
  state: RememberState,
  ctx: ServerContext,
): Promise<RememberResult> => {
  const resolved = acceptedContent<{ action?: string; target?: string }>(
    ctx.mcpReq.inputResponses,
    'resolve',
  );
  if (resolved?.action === 'merge' && state.candidates.length > 0) {
    const target =
      resolved.target !== undefined && state.candidates.includes(resolved.target)
        ? resolved.target
        : state.candidates[0];
    return { result: `merged:${target}`, outcome: 'merged', id: target };
  }
  return remember(deps.db, state.input, { embedder: deps.embedder ?? null, force: true });
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'remember',
    description:
      'Store a memory: dedupe check against near-identical entries, auto key generation, and short-term tiering by type.',
    inputSchema: z.object({
      content: z.string(),
      title: z.string().optional(),
      type: MEMORY_TYPE.optional(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source: MEMORY_SOURCE.optional(),
      importance: z.number().int().min(1).max(5).optional(),
      interactive: z.boolean().optional(),
    }),
    run: async (args, deps, ctx) => {
      const input: RememberInput = {
        content: args.content as string,
        title: (args.title as string | undefined) ?? (args.content as string),
        type: (args.type as never) ?? 'fact',
        scope: args.scope as string | undefined,
        tags: args.tags as string[] | undefined,
        source: args.source as never,
        importance: args.importance as number | undefined,
      };
      const state = ctx?.mcpReq.requestState<RememberState>();
      if (state) {
        return jsonText(await completeInteractiveRemember(deps, state, ctx!));
      }
      const result = await remember(deps.db, input, { embedder: deps.embedder ?? null });
      const candidates = result.candidates ?? [];
      if (
        result.outcome !== 'conflict' ||
        args.interactive !== true ||
        ctx?.mcpReq.envelope === undefined
      ) {
        return jsonText(result);
      }
      const requestState = await deps.requestStateCodec.mint({ input, candidates });
      return inputRequired({
        inputRequests: {
          resolve: inputRequired.elicit({
            message: `Near-duplicates found: ${candidates.join(', ')}. Merge into one, or create a new memory anyway?`,
            requestedSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['merge', 'create'] },
                target: { type: 'string', description: 'candidate id to merge into (merge only)' },
              },
              required: ['action'],
            },
          }),
        },
        requestState,
      });
    },
  },
  {
    name: 'recall',
    description:
      'Hybrid full-text + semantic search ranked by reliability and importance, returned as a markdown bundle.',
    inputSchema: z.object({
      query: z.string(),
      scope: z.string().optional(),
      tier: MEMORY_TIER.optional(),
      status: MEMORY_STATUS.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async (args, deps) => {
      const result = await recall(
        deps.db,
        args.query as string,
        {
          scope: args.scope as string | undefined,
          tier: args.tier as never,
          status: args.status as never,
          limit: args.limit as number | undefined,
          embedder: deps.embedder ?? null,
        },
      );
      return result.markdown;
    },
  },
  {
    name: 'get',
    description: 'Fetch one memory by id with its supersession chain and optional edit history.',
    inputSchema: z.object({
      key: z.string(),
      withHistory: z.boolean().optional(),
    }),
    run: (args, deps) => {
      const id = args.key as string;
      const row = getMemory(deps.db, id);
      if (!row) throw new Error(`memory not found: ${id}`);
      const history = args.withHistory
        ? (deps.db
            .prepare(
              'SELECT content_before, content_after, reason, changed_at FROM history WHERE memory_id = ? ORDER BY changed_at ASC, rowid ASC',
            )
            .all(id) as Record<string, unknown>[])
        : [];
      return jsonText({ ...row, chain: supersessionChain(deps.db, id), history });
    },
  },
  {
    name: 'update',
    description: 'Update a memory; content changes record a history row and require a reason.',
    inputSchema: z.object({
      key: z.string(),
      content: z.string().optional(),
      title: z.string().optional(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().int().min(1).max(5).optional(),
      reason: z.string().optional(),
    }),
    run: (args, deps) =>
      jsonText(
        updateMemory(deps.db, args.key as string, {
          content: args.content as string | undefined,
          title: args.title as string | undefined,
          scope: args.scope as string | undefined,
          tags: args.tags as string[] | undefined,
          importance: args.importance as number | undefined,
          reason: args.reason as string | undefined,
        }),
      ),
  },
  {
    name: 'forget',
    description: 'Archive a memory by default; purge deletes the row and its links, history, and vector.',
    inputSchema: z.object({
      key: z.string(),
      purge: z.boolean().optional(),
    }),
    run: (args, deps) => {
      forgetMemory(deps.db, args.key as string, { purge: (args.purge as boolean | undefined) ?? false });
      return (args.purge as boolean | undefined) === true ? 'purged' : 'archived';
    },
  },
  {
    name: 'list',
    description: 'List memories filtered by scope, tier, type, and status.',
    inputSchema: z.object({
      scope: z.string().optional(),
      tier: MEMORY_TIER.optional(),
      type: MEMORY_TYPE.optional(),
      status: MEMORY_STATUS.optional(),
    }),
    run: (args, deps) =>
      jsonText(
        listMemories(deps.db, {
          scope: args.scope as string | undefined,
          tier: args.tier as never,
          type: args.type as never,
          status: args.status as never,
        }),
      ),
  },
  {
    name: 'confirm',
    description: 'Confirm a memory by id or search, advancing its confirmation timestamp and confidence.',
    inputSchema: z.object({
      key: z.string(),
    }),
    run: (args, deps) => jsonText(confirmMemory(deps.db, args.key as string)),
  },
  {
    name: 'contradict',
    description: 'Record a correction: the new memory supersedes the old and is linked as a contradiction.',
    inputSchema: z.object({
      key: z.string(),
      content: z.string(),
      title: z.string().optional(),
      type: MEMORY_TYPE.optional(),
      scope: z.string().optional(),
      source: MEMORY_SOURCE.optional(),
      importance: z.number().int().min(1).max(5).optional(),
    }),
    run: (args, deps) =>
      jsonText(
        contradictMemory(deps.db, args.key as string, {
          content: args.content as string,
          title: args.title as string | undefined,
          type: args.type as never,
          scope: args.scope as string | undefined,
          source: args.source as never,
          importance: args.importance as number | undefined,
        }),
      ),
  },
  {
    name: 'promote',
    description: 'Promote a short-term memory to the long tier and clear its expiry.',
    inputSchema: z.object({
      key: z.string(),
    }),
    run: (args, deps) => jsonText(promoteMemory(deps.db, args.key as string)),
  },
  {
    name: 'consolidate',
    description:
      'Report maintenance signals, or apply the named action ids from the last report. Nothing mutates without apply.',
    inputSchema: z.object({
      apply: z.array(z.string()).optional(),
    }),
    run: (args, deps) => {
      const apply = args.apply as string[] | undefined;
      if (apply !== undefined) return jsonText(applyConsolidate(deps.db, apply));
      return jsonText(consolidateReport(deps.db));
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((tool) => tool.name);

const DEFAULT_REQUEST_STATE_KEY = crypto.randomBytes(32).toString('base64url');

export const createServerFactory = (deps: ServerDependencies): McpServerFactory => {
  const codec = createRequestStateCodec<RememberState>({
    key: deps.requestStateKey ?? DEFAULT_REQUEST_STATE_KEY,
  });
  const toolDeps: ToolRunDeps = { ...deps, requestStateCodec: codec };
  return (_ctx: McpRequestContext): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { tools: {} },
        requestState: { verify: codec.verify },
      },
    );
    for (const tool of TOOL_DEFINITIONS) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (args, ctx) => {
          const result = await tool.run(args as Record<string, unknown>, toolDeps, ctx);
          if (isInputRequiredResult(result)) return result;
          return { content: [{ type: 'text', text: result }] };
        },
      );
    }
    return server;
  };
};
