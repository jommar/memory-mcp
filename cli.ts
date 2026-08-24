#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { loadConfig, type MemoryConfig } from './src/config.js';
import { openDatabase } from './src/db/connection.js';
import { MIGRATIONS, runMigrations } from './src/db/schema.js';
import { createMemory, listMemories, type MemoryRow, type MemoryType } from './src/db/queries.js';
import { tierAndTtl } from './src/core/remember.js';
import { createLocalEmbeddingProvider } from './src/embeddings/local.js';
import { initEmbeddingProvider } from './src/embeddings/types.js';

const SEPARATOR = '---';
const KEY_PATTERN = /^[a-z0-9-]+$/;
const MEMORY_TYPES = new Set([
  'preference',
  'decision',
  'fact',
  'procedure',
  'person',
  'project-state',
  'lesson',
  'session',
]);

const usage = (stream: NodeJS.WritableStream): void => {
  stream.write(`usage: memory-mcp <command> [args]

commands:
  export <outDir>      export every memory as a markdown frontmatter file
  import <stagingDir>  import markdown frontmatter files from a staging directory
  reindex              rebuild the FTS and vector indexes from stored content
  stats                print store counts
`);
};

const openStore = (config: MemoryConfig): Database.Database => {
  const db = openDatabase(config.dbPath);
  runMigrations(db, MIGRATIONS);
  return db;
};

const printStats = (db: Database.Database): number => {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const memories = count('SELECT count(*) AS n FROM memories');
  const short = count("SELECT count(*) AS n FROM memories WHERE tier = 'short'");
  const long = count("SELECT count(*) AS n FROM memories WHERE tier = 'long'");
  const active = count("SELECT count(*) AS n FROM memories WHERE status = 'active'");
  const archived = count("SELECT count(*) AS n FROM memories WHERE status = 'archived'");
  const expired = count("SELECT count(*) AS n FROM memories WHERE status = 'expired'");
  const superseded = count("SELECT count(*) AS n FROM memories WHERE status = 'superseded'");
  const links = count('SELECT count(*) AS n FROM links');
  console.log(`memories: ${memories}`);
  console.log(`  tier: short ${short}, long ${long}`);
  console.log(`  status: active ${active}, archived ${archived}, expired ${expired}, superseded ${superseded}`);
  console.log(`links: ${links}`);
  return 0;
};

// Frontmatter values containing ':', '#', '"' (or whitespace/empty) are wrapped
// in double quotes with embedded quotes escaped, so a colon or hash in a title,
// tag or scope never breaks the line-based import parser.
const yamlValue = (value: string): string => {
  if (
    value.includes(':') ||
    value.includes('#') ||
    value.includes('"') ||
    value.trim() !== value ||
    value === ''
  ) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
};

const buildFile = (row: MemoryRow): string => {
  const lines = [SEPARATOR];
  lines.push(`key: ${yamlValue(row.id)}`);
  lines.push(`title: ${yamlValue(row.title)}`);
  if (row.tags.length > 0) {
    lines.push(`tags: [${row.tags.map(yamlValue).join(', ')}]`);
  }
  lines.push(`parent: ${yamlValue(row.scope)}`);
  lines.push(`type: ${row.type}`);
  lines.push(SEPARATOR);
  return `${lines.join('\n')}\n\n${row.content}\n\n${SEPARATOR}\n`;
};

const exportStore = (db: Database.Database, outDir: string): number => {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [...listMemories(db)].sort((a, b) => a.id.localeCompare(b.id));
  for (const row of rows) {
    const target = path.join(outDir, `${row.id}.md`);
    const tmp = `${target}.tmp`;
    try {
      fs.writeFileSync(tmp, buildFile(row), 'utf8');
      fs.renameSync(tmp, target);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // leave the tmp in place when it cannot be removed, so the bytes are inspectable
      }
      throw error;
    }
  }
  console.log(`exported ${rows.length} memories to ${outDir}`);
  return 0;
};

// --- import ---

interface ParsedSection {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Reads a double-quoted frontmatter value starting at raw[0] (the quote itself
// excluded). Returns the unescaped value, or null when the quote never closes or
// trailing junk follows it.
const unquote = (raw: string): string | null => {
  let out = '';
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && raw[i + 1] === '"') {
      out += '"';
      i += 1;
    } else if (ch === '"') {
      return raw.slice(i + 1).trim() === '' ? out : null;
    } else {
      out += ch;
    }
  }
  return null;
};

const parseValue = (raw: string): string | string[] | null => {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return null;
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    const items: string[] = [];
    for (const item of inner.split(',')) {
      const trimmed = item.trim();
      const parsed = trimmed.startsWith('"') ? unquote(trimmed) : trimmed;
      if (parsed === null) return null;
      items.push(parsed);
    }
    return items;
  }
  if (value.startsWith('"')) return unquote(value);
  return value;
};

interface ParseResult {
  sections: ParsedSection[];
  error?: string;
}

// Line-modeled after wiki-v2's battle-tested multi-section reader: frontmatter
// blocks are delimited by --- lines; only blocks carrying a 'key' field count as
// sections; a trailing --- at EOF belongs to the previous body. Blocks are matched
// with a lazy /---\n([\s\S]*?)\n---/ scan so a bare separator (e.g. two files
// concatenated) is skipped instead of being parsed as an empty section.
const parseSections = (content: string): ParseResult => {
  const sections: ParsedSection[] = [];
  const matched: { index: number; end: number; frontmatter: Record<string, unknown> }[] = [];
  const regex = /---\n([\s\S]*?)\n---/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const frontmatter: Record<string, unknown> = {};
    let malformed = false;
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const name = line.slice(0, colonIdx).trim();
      if (name === '') continue;
      const parsed = parseValue(line.slice(colonIdx + 1));
      if (parsed === null) {
        malformed = true;
        break;
      }
      frontmatter[name] = parsed;
    }
    if (malformed) return { sections: [], error: 'malformed value in frontmatter' };
    if (typeof frontmatter.key === 'string') {
      matched.push({ index: match.index, end: match.index + match[0].length, frontmatter });
    }
  }
  for (let i = 0; i < matched.length; i += 1) {
    const nextStart = i + 1 < matched.length ? matched[i + 1].index : content.length;
    const body = content
      .slice(matched[i].end, nextStart)
      .trim()
      .replace(/\n?---\s*$/, '')
      .trim();
    sections.push({ frontmatter: matched[i].frontmatter, body });
  }
  if (sections.length === 0) {
    const error = content.includes(SEPARATOR)
      ? 'no complete frontmatter sections found'
      : 'no frontmatter sections found';
    return { sections: [], error };
  }
  return { sections };
};

const validateSection = (section: ParsedSection, index: number): string | null => {
  const fm = section.frontmatter;
  const context = `block ${index + 1}`;
  const key = fm.key;
  if (typeof key !== 'string' || key === '') return `${context}: missing required field 'key'`;
  if (!KEY_PATTERN.test(key)) {
    return `${context}: invalid key '${key}' (must be lowercase alphanumeric with hyphens)`;
  }
  for (const field of ['title', 'parent', 'type'] as const) {
    if (typeof fm[field] !== 'string' || fm[field] === '') {
      return `${context}: missing required field '${field}'`;
    }
  }
  if (!MEMORY_TYPES.has(fm.type as string)) return `${context}: invalid type '${String(fm.type)}'`;
  if (fm.tags !== undefined) {
    if (!Array.isArray(fm.tags) || fm.tags.some((tag) => typeof tag !== 'string' || tag === '')) {
      return `${context}: 'tags' must be a bracketed list of non-empty strings`;
    }
  }
  return null;
};

// Imported memories re-derive lifecycle fields: tier and STM expiry from type,
// source user-stated, status active, importance 3, tags default [].
const insertSection = (db: Database.Database, section: ParsedSection): void => {
  const fm = section.frontmatter;
  const { tier, ttlMs } = tierAndTtl(fm.type as MemoryType);
  createMemory(db, {
    id: fm.key as string,
    title: fm.title as string,
    content: section.body,
    type: fm.type as MemoryType,
    tier,
    scope: fm.parent as string,
    tags: (fm.tags as string[] | undefined) ?? [],
    source: 'user-stated',
    importance: 3,
    status: 'active',
    expires_at: ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString(),
  });
};

const importStore = (db: Database.Database, stagingDir: string): number => {
  const successDir = path.join(stagingDir, 'success');
  const failDir = path.join(stagingDir, 'fail');
  const files = fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    console.log(`no markdown files in ${stagingDir}`);
    return 0;
  }

  const existingKeys = new Set(
    (db.prepare('SELECT id FROM memories').all() as { id: string }[]).map((row) => row.id),
  );

  const valid: { file: string; sections: ParsedSection[] }[] = [];
  const failed: { file: string; errors: string[] }[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(stagingDir, file), 'utf8');
    const { sections, error } = parseSections(content);
    const errors: string[] = [];
    if (error !== undefined) {
      errors.push(error);
    } else {
      for (let i = 0; i < sections.length; i += 1) {
        const validationError = validateSection(sections[i], i);
        if (validationError !== null) errors.push(validationError);
      }
    }
    if (errors.length > 0) failed.push({ file, errors });
    else valid.push({ file, sections });
  }

  fs.mkdirSync(failDir, { recursive: true });
  for (const { file, errors } of failed) {
    fs.renameSync(path.join(stagingDir, file), path.join(failDir, file));
    console.log(`failed ${file}: ${errors.join('; ')}`);
  }

  // Every accepted block is validated before any write; refused keys (already in
  // the store, or declared earlier in the batch) are skipped with a provenance
  // report — never silently overwritten.
  const plan: { file: string; section: ParsedSection }[] = [];
  const refused: { file: string; key: string; reason: string }[] = [];
  const firstDeclaredBy = new Map<string, string>();
  const seen = new Set(existingKeys);
  for (const { file, sections } of valid) {
    for (const section of sections) {
      const key = section.frontmatter.key as string;
      if (seen.has(key)) {
        refused.push({
          file,
          key,
          reason: existingKeys.has(key)
            ? 'already exists in store'
            : `duplicate of a key declared in ${firstDeclaredBy.get(key)}`,
        });
        continue;
      }
      seen.add(key);
      firstDeclaredBy.set(key, file);
      plan.push({ file, section });
    }
  }

  if (plan.length > 0) {
    db.transaction(() => {
      for (const { section } of plan) insertSection(db, section);
    })();
  }

  fs.mkdirSync(successDir, { recursive: true });
  for (const { file } of valid) {
    fs.renameSync(path.join(stagingDir, file), path.join(successDir, file));
  }

  let imported = 0;
  let skipped = 0;
  for (const { file, section } of plan) {
    imported += 1;
    console.log(`imported ${section.frontmatter.key} from ${file}`);
  }
  for (const { file, key, reason } of refused) {
    skipped += 1;
    console.log(`skipped ${key} from ${file}: ${reason}`);
  }
  console.log(`import ${imported} imported, ${skipped} skipped, ${failed.length} failed`);
  return skipped > 0 || failed.length > 0 ? 1 : 0;
};

const reindexStore = async (config: MemoryConfig, db: Database.Database): Promise<number> => {
  const rows = listMemories(db);
  db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
  if (rows.length === 0) {
    console.log('reindexed 0 memories');
    return 0;
  }
  const embedder = createLocalEmbeddingProvider({
    offline: config.embeddingOffline,
    downloadTimeoutMs: config.embeddingDownloadTimeoutMs,
    cacheDir: config.embeddingCacheDir,
  });
  initEmbeddingProvider(db, embedder);
  let vectors: Float32Array[];
  try {
    vectors = await embedder.embed(rows.map((row) => row.content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`reindex: FTS rebuilt for ${rows.length} memories, but vector rebuild failed: ${message}`);
    return 1;
  }
  db.transaction(() => {
    db.prepare('DELETE FROM memories_vec').run();
    const insert = db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)');
    for (let i = 0; i < rows.length; i += 1) {
      const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(rows[i].id) as {
        rowid: number;
      };
      insert.run(BigInt(rowid), Buffer.from(vectors[i].buffer));
    }
  })();
  console.log(`reindexed ${rows.length} memories (FTS + vectors)`);
  return 0;
};

const main = async (argv: string[], env: NodeJS.ProcessEnv): Promise<number> => {
  const [command, ...args] = argv;
  const config = loadConfig(env);
  try {
    switch (command) {
      case 'export': {
        const outDir = args[0];
        if (outDir === undefined) {
          usage(process.stderr);
          return 1;
        }
        const db = openStore(config);
        try {
          return exportStore(db, outDir);
        } finally {
          db.close();
        }
      }
      case 'import': {
        const stagingDir = args[0];
        if (stagingDir === undefined) {
          usage(process.stderr);
          return 1;
        }
        const db = openStore(config);
        try {
          return importStore(db, stagingDir);
        } finally {
          db.close();
        }
      }
      case 'reindex': {
        const db = openStore(config);
        try {
          return await reindexStore(config, db);
        } finally {
          db.close();
        }
      }
      case 'stats': {
        const db = openStore(config);
        try {
          return printStats(db);
        } finally {
          db.close();
        }
      }
      case '-h':
      case '--help':
        usage(process.stdout);
        return 0;
      default:
        usage(process.stderr);
        return 1;
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

export { main };
