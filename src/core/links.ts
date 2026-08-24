import type Database from 'better-sqlite3';
import {
  getMemory,
  insertLink,
  listIncomingLinks,
  listOutgoingLinks,
  type LinkKind,
  type LinkRow,
} from '../db/queries.js';

export { listOutgoingLinks };
export type { LinkKind, LinkRow };

const VALID_KINDS: readonly LinkKind[] = ['related', 'supersedes', 'contradicts'];

export interface CreateLinkInput {
  fromId: string;
  toId: string;
  kind: LinkKind;
}

export interface CreateLinkResult {
  created: boolean;
}

export const createLink = (db: Database.Database, input: CreateLinkInput): CreateLinkResult => {
  if (!VALID_KINDS.includes(input.kind)) {
    throw new Error(`invalid link kind: ${input.kind}`);
  }
  for (const [label, id] of [
    ['source', input.fromId],
    ['target', input.toId],
  ] as const) {
    if (!getMemory(db, id)) {
      console.warn(`skipping link ${input.kind} from ${input.fromId} to ${input.toId}: ${label} ${id} does not exist`);
      return { created: false };
    }
  }
  return { created: insertLink(db, input.fromId, input.toId, input.kind) };
};

export interface BacklinksPage {
  links: LinkRow[];
  hasMore: boolean;
}

export const listBacklinks = (
  db: Database.Database,
  toId: string,
  opts: { limit: number; offset?: number },
): BacklinksPage => {
  const limit = opts.limit;
  const offset = opts.offset ?? 0;
  const rows = listIncomingLinks(db, toId, limit + 1, offset);
  const hasMore = rows.length > limit;
  return { links: rows.slice(0, limit), hasMore };
};

export const supersessionChain = (db: Database.Database, id: string): string[] => {
  const chain: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = id;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const row = getMemory(db, currentId);
    if (!row) break;
    chain.push(currentId);
    currentId = row.status === 'superseded' && row.superseded_by ? row.superseded_by : null;
  }
  return chain;
};
