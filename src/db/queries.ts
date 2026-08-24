import type Database from 'better-sqlite3';

export type MemoryType =
  | 'preference'
  | 'decision'
  | 'fact'
  | 'procedure'
  | 'person'
  | 'project-state'
  | 'lesson'
  | 'session';
export type MemoryTier = 'short' | 'long';
export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'expired';
export type MemorySource = 'user-stated' | 'agent-inferred' | 'agent-guessed';

export interface MemoryRow {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  tier: MemoryTier;
  scope: string;
  tags: string[];
  status: MemoryStatus;
  superseded_by: string | null;
  source: MemorySource;
  importance: number;
  confidence: number | null;
  observed_count: number;
  contradiction_count: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  last_confirmed_at: string | null;
  expires_at: string | null;
}

export interface CreateMemoryInput {
  id?: string;
  title: string;
  content: string;
  type: MemoryType;
  tier: MemoryTier;
  source: MemorySource;
  scope?: string;
  tags?: string[];
  importance?: number;
  status?: MemoryStatus;
  expires_at?: string | null;
}

export const BASE_BY_SOURCE: Record<MemorySource, number> = {
  'user-stated': 1,
  'agent-inferred': 0.7,
  'agent-guessed': 0.4,
};

const SELECT_MEMORY = `
  SELECT id, title, content, type, tier, scope, tags, status, superseded_by, source,
         importance, confidence, observed_count, contradiction_count,
         created_at, updated_at, last_accessed_at, last_confirmed_at, expires_at
  FROM memories
`;

interface StoredMemory extends Omit<MemoryRow, 'tags'> {
  tags: string | null;
}

const mapRow = (row: StoredMemory): MemoryRow => ({
  ...row,
  tags: JSON.parse(row.tags ?? '[]') as string[],
});

export const makeMemoryId = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  }
  const suffix = hash.toString(36).padStart(4, '0');
  return slug ? `${slug}-${suffix}` : suffix;
};

export const getMemory = (db: Database.Database, id: string): MemoryRow | undefined => {
  const row = db.prepare(`${SELECT_MEMORY} WHERE id = ?`).get(id) as StoredMemory | undefined;
  return row ? mapRow(row) : undefined;
};

export const createMemory = (db: Database.Database, input: CreateMemoryInput): MemoryRow => {
  const id = input.id ?? makeMemoryId(input.title);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (
       id, title, content, type, tier, scope, tags, status, source, importance,
       confidence, observed_count, contradiction_count, created_at, updated_at, expires_at
     ) VALUES (
       @id, @title, @content, @type, @tier, @scope, @tags, @status, @source, @importance,
       @confidence, 0, 0, @now, @now, @expires_at
     )`,
  ).run({
    id,
    title: input.title,
    content: input.content,
    type: input.type,
    tier: input.tier,
    scope: input.scope ?? 'global',
    tags: JSON.stringify(input.tags ?? []),
    source: input.source,
    importance: input.importance ?? 3,
    status: input.status ?? 'active',
    confidence: BASE_BY_SOURCE[input.source],
    now,
    expires_at: input.expires_at ?? null,
  });
  return getMemory(db, id)!;
};

export interface UpdateMemoryInput {
  content?: string;
  title?: string;
  scope?: string;
  tags?: string[];
  tier?: MemoryTier;
  importance?: number;
  status?: MemoryStatus;
  superseded_by?: string | null;
  expires_at?: string | null;
  confidence?: number;
  observed_count?: number;
  last_confirmed_at?: string | null;
  reason?: string;
}

export const updateMemory = (
  db: Database.Database,
  id: string,
  update: UpdateMemoryInput,
): MemoryRow => {
  const existing = getMemory(db, id);
  if (!existing) throw new Error(`memory not found: ${id}`);
  if (update.content !== undefined && update.reason === undefined) {
    throw new Error('content updates require a reason');
  }
  const now = new Date().toISOString();
  const columns: [string, string | number | null][] = [['updated_at', now]];
  if (update.content !== undefined) columns.push(['content', update.content]);
  if (update.title !== undefined) columns.push(['title', update.title]);
  if (update.scope !== undefined) columns.push(['scope', update.scope]);
  if (update.tags !== undefined) columns.push(['tags', JSON.stringify(update.tags)]);
  if (update.tier !== undefined) columns.push(['tier', update.tier]);
  if (update.importance !== undefined) columns.push(['importance', update.importance]);
  if (update.status !== undefined) columns.push(['status', update.status]);
  if (update.superseded_by !== undefined) columns.push(['superseded_by', update.superseded_by]);
  if (update.expires_at !== undefined) columns.push(['expires_at', update.expires_at]);
  if (update.confidence !== undefined) columns.push(['confidence', update.confidence]);
  if (update.observed_count !== undefined) columns.push(['observed_count', update.observed_count]);
  if (update.last_confirmed_at !== undefined) columns.push(['last_confirmed_at', update.last_confirmed_at]);

  const setClause = columns.map(([column]) => `${column} = ?`).join(', ');
  const apply = db.transaction(() => {
    db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(
      ...columns.map(([, value]) => value),
      id,
    );
    db.prepare(
      `INSERT INTO history (memory_id, content_before, content_after, reason, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, update.content !== undefined ? existing.content : null, update.content ?? null, update.reason ?? null, now);
  });
  apply();
  return getMemory(db, id)!;
};

export interface ListMemoriesFilter {
  scope?: string;
  tier?: MemoryTier;
  type?: MemoryType;
  status?: MemoryStatus;
}

export const listMemories = (db: Database.Database, filter: ListMemoriesFilter = {}): MemoryRow[] => {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.tier !== undefined) {
    conditions.push('tier = ?');
    params.push(filter.tier);
  }
  if (filter.type !== undefined) {
    conditions.push('type = ?');
    params.push(filter.type);
  }
  if (filter.status !== undefined) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`${SELECT_MEMORY}${where} ORDER BY created_at DESC, id ASC`)
    .all(...params) as StoredMemory[];
  return rows.map(mapRow);
};

export const forgetMemory = (
  db: Database.Database,
  id: string,
  opts: { purge?: boolean } = {},
): void => {
  if (!getMemory(db, id)) throw new Error(`memory not found: ${id}`);
  if (opts.purge) {
    // FK cascade removes links/history, but memories_vec is a vec0 virtual table
    // with no FOREIGN KEY clause, so the cascade cannot reach it. Capture the
    // rowid first: without this delete the freed rowid is reused by a later
    // insert, silently attaching the purged memory's stale vector to new data.
    const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as {
      rowid: number;
    };
    db.transaction(() => {
      db.prepare('DELETE FROM memories_vec WHERE memory_rowid = ?').run(BigInt(rowid));
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    })();
    return;
  }
  db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(
    'archived',
    new Date().toISOString(),
    id,
  );
};

export const searchMemoriesByText = (db: Database.Database, term: string): MemoryRow[] => {
  const escaped = term.replace(/[\\%_]/g, '\\$&');
  const pattern = `%${escaped}%`;
  const rows = db
    .prepare(
      `${SELECT_MEMORY} WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       ORDER BY title ASC, id ASC`,
    )
    .all(pattern, pattern) as StoredMemory[];
  return rows.map(mapRow);
};

export type LinkKind = 'related' | 'supersedes' | 'contradicts';

export interface LinkRow {
  fromId: string;
  toId: string;
  kind: LinkKind;
}

const SELECT_LINK = `SELECT from_id, to_id, kind FROM links`;

interface StoredLink {
  from_id: string;
  to_id: string;
  kind: LinkKind;
}

const mapLink = (row: StoredLink): LinkRow => ({
  fromId: row.from_id,
  toId: row.to_id,
  kind: row.kind,
});

export const insertLink = (
  db: Database.Database,
  fromId: string,
  toId: string,
  kind: LinkKind,
): boolean => {
  const { changes } = db
    .prepare('INSERT INTO links (from_id, to_id, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(fromId, toId, kind);
  return changes > 0;
};

export const listOutgoingLinks = (db: Database.Database, fromId: string): LinkRow[] => {
  const rows = db
    .prepare(`${SELECT_LINK} WHERE from_id = ? ORDER BY rowid ASC`)
    .all(fromId) as StoredLink[];
  return rows.map(mapLink);
};

export const listIncomingLinks = (
  db: Database.Database,
  toId: string,
  limit: number,
  offset = 0,
): LinkRow[] => {
  const rows = db
    .prepare(`${SELECT_LINK} WHERE to_id = ? ORDER BY rowid ASC LIMIT ? OFFSET ?`)
    .all(toId, limit, offset) as StoredLink[];
  return rows.map(mapLink);
};
