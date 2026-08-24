import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../src/db/schema.js';
import { createMemory, forgetMemory, insertLink } from '../src/db/queries.js';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const CLI_LOADER = fileURLToPath(new URL('./cli-loader.mjs', import.meta.url));
const MODEL_CACHE_DIR = fileURLToPath(new URL('../.cache/models', import.meta.url));
const HAS_MODEL_CACHE = fs.existsSync(MODEL_CACHE_DIR);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', CLI_LOADER, CLI, ...args],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else {
          resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr });
        }
      },
    );
  });

let dir: string;
let dbPath: string;

const dbEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MEMORY_DB_PATH: dbPath,
  ...overrides,
});

const openDb = (): Database.Database => {
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS);
  return db;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-cli-'));
  dbPath = path.join(dir, 'memory.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cli usage', () => {
  it('prints usage and exits 1 for an unknown command', async () => {
    const { code, stderr } = await runCli(['frobnicate'], dbEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('usage: memory-mcp');
    expect(stderr).toContain('export');
    expect(stderr).toContain('import');
    expect(stderr).toContain('reindex');
    expect(stderr).toContain('stats');
  });

  it('prints usage and exits 0 for --help', async () => {
    const { code, stdout } = await runCli(['--help'], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('usage: memory-mcp');
  });
});

describe('cli stats', () => {
  it('reports zero counts for a fresh store', async () => {
    const { code, stdout } = await runCli(['stats'], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('memories: 0');
    expect(stdout).toContain('links: 0');
  });

  it('counts memories by tier and status plus links', async () => {
    const db = openDb();
    createMemory(db, {
      id: 'one', title: 'one', content: 'body one', type: 'fact', tier: 'long', source: 'user-stated',
    });
    createMemory(db, {
      id: 'two', title: 'two', content: 'body two', type: 'fact', tier: 'long', source: 'user-stated',
    });
    createMemory(db, {
      id: 'three', title: 'three', content: 'body three', type: 'session', tier: 'short', source: 'user-stated',
    });
    forgetMemory(db, 'two');
    insertLink(db, 'one', 'three', 'related');
    db.close();

    const { code, stdout } = await runCli(['stats'], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('memories: 3');
    expect(stdout).toContain('tier: short 1, long 2');
    expect(stdout).toContain('status: active 2, archived 1, expired 0, superseded 0');
    expect(stdout).toContain('links: 1');
  });
});

describe('cli export', () => {
  it('handles an empty store without crashing', async () => {
    const outDir = path.join(dir, 'out');
    const { code, stdout } = await runCli(['export', outDir], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain(`exported 0 memories to ${outDir}`);
    expect(fs.existsSync(outDir)).toBe(true);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('writes one frontmatter file per memory id, quoting edge-case values, with no tmp leftovers', async () => {
    const db = openDb();
    createMemory(db, {
      id: 'quote-test',
      title: 'Meeting: "sync" #1',
      content: 'body with : and #',
      type: 'preference',
      tier: 'long',
      scope: 'project:alpha',
      tags: ['a:b', 'tag"x', 'plain'],
      source: 'user-stated',
    });
    createMemory(db, {
      id: 'second', title: 'second', content: 'plain body', type: 'fact', tier: 'long', source: 'user-stated',
    });
    db.close();

    const outDir = path.join(dir, 'out');
    const { code, stdout } = await runCli(['export', outDir], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain(`exported 2 memories to ${outDir}`);

    const files = fs.readdirSync(outDir).sort();
    expect(files).toEqual(['quote-test.md', 'second.md']);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    const first = fs.readFileSync(path.join(outDir, 'quote-test.md'), 'utf8');
    expect(first).toBe(
      [
        '---',
        'key: quote-test',
        'title: "Meeting: \\"sync\\" #1"',
        'tags: ["a:b", "tag\\"x", plain]',
        'parent: "project:alpha"',
        'type: preference',
        '---',
        '',
        'body with : and #',
        '',
        '---',
        '',
      ].join('\n'),
    );
    const second = fs.readFileSync(path.join(outDir, 'second.md'), 'utf8');
    expect(second).toBe(
      [
        '---',
        'key: second',
        'title: second',
        'parent: global',
        'type: fact',
        '---',
        '',
        'plain body',
        '',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('omits the tags line entirely for a memory with no tags', async () => {
    const db = openDb();
    createMemory(db, {
      id: 'bare', title: 'bare', content: 'body', type: 'fact', tier: 'long', source: 'user-stated',
    });
    db.close();
    const outDir = path.join(dir, 'out');
    const { code } = await runCli(['export', outDir], dbEnv());
    expect(code).toBe(0);
    const content = fs.readFileSync(path.join(outDir, 'bare.md'), 'utf8');
    expect(content).not.toContain('tags:');
  });
});

describe('cli import', () => {
  it('roundtrips: export then import into a fresh store reproduces an equivalent store', async () => {
    const db = openDb();
    createMemory(db, {
      id: 'fact-one', title: 'First: fact', content: 'body with : and # chars', type: 'fact', tier: 'long',
      scope: 'project:alpha', tags: ['a:b', 'plain'], source: 'user-stated',
    });
    createMemory(db, {
      id: 'pref-two', title: 'Preference two', content: 'preference body', type: 'preference', tier: 'long',
      source: 'user-stated',
    });
    createMemory(db, {
      id: 'session-three', title: 'Session three', content: 'session body', type: 'session', tier: 'short',
      source: 'user-stated',
    });
    createMemory(db, {
      id: 'proc-four', title: 'Procedure four', content: 'procedure body', type: 'procedure', tier: 'long',
      source: 'user-stated',
    });
    db.close();

    const outDir = path.join(dir, 'out');
    const firstExport = await runCli(['export', outDir], dbEnv());
    expect(firstExport.code).toBe(0);

    const otherDb = path.join(dir, 'other.db');
    const { code, stdout } = await runCli(['import', outDir], {
      MEMORY_DB_PATH: otherDb,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('import 4 imported, 0 skipped, 0 failed');

    const check = openDatabase(otherDb);
    runMigrations(check, MIGRATIONS);
    const imported = (check.prepare(
      'SELECT id, title, content, scope, tags, type, tier, status, source, importance FROM memories ORDER BY id',
    ).all() as {
      id: string; title: string; content: string; scope: string; tags: string | null;
      type: string; tier: string; status: string; source: string; importance: number;
    }[]).map((row) => ({ ...row, tags: JSON.parse(row.tags ?? '[]') as string[] }));
    check.close();

    expect(imported).toEqual([
      {
        id: 'fact-one', title: 'First: fact', content: 'body with : and # chars', scope: 'project:alpha',
        tags: ['a:b', 'plain'], type: 'fact', tier: 'long', status: 'active', source: 'user-stated', importance: 3,
      },
      {
        id: 'pref-two', title: 'Preference two', content: 'preference body', scope: 'global', tags: [],
        type: 'preference', tier: 'long', status: 'active', source: 'user-stated', importance: 3,
      },
      {
        id: 'proc-four', title: 'Procedure four', content: 'procedure body', scope: 'global', tags: [],
        type: 'procedure', tier: 'long', status: 'active', source: 'user-stated', importance: 3,
      },
      {
        id: 'session-three', title: 'Session three', content: 'session body', scope: 'global', tags: [],
        type: 'session', tier: 'short', status: 'active', source: 'user-stated', importance: 3,
      },
    ]);
    const successes = fs.readdirSync(path.join(outDir, 'success')).sort();
    expect(successes).toEqual(['fact-one.md', 'pref-two.md', 'proc-four.md', 'session-three.md']);
  });

  it('refuses keys that already exist in the store and never overwrites', async () => {
    const db = openDb();
    createMemory(db, {
      id: 'alpha', title: 'original title', content: 'original content', type: 'fact', tier: 'long', source: 'user-stated',
    });
    db.close();

    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(
      path.join(staging, 'alpha.md'),
      '---\nkey: alpha\ntitle: replacement title\nparent: global\ntype: fact\n---\n\nreplacement content\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(staging, 'beta.md'),
      '---\nkey: beta\ntitle: beta title\nparent: global\ntype: fact\n---\n\nbeta content\n',
      'utf8',
    );

    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(1);
    expect(stdout).toContain('import 1 imported, 1 skipped, 0 failed');
    expect(stdout).toContain('skipped alpha from alpha.md: already exists in store');

    const check = openDb();
    const alpha = check.prepare('SELECT title, content FROM memories WHERE id = ?').get('alpha') as {
      title: string; content: string;
    };
    expect(alpha).toEqual({ title: 'original title', content: 'original content' });
    expect(check.prepare('SELECT id FROM memories WHERE id = ?').get('beta')).toBeDefined();
    check.close();

    expect(fs.readdirSync(path.join(staging, 'success')).sort()).toEqual(['alpha.md', 'beta.md']);
  });

  it('validates every staged block before writing and quarantines failing files per-file', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(
      path.join(staging, 'good.md'),
      '---\nkey: good\ntitle: Good title\nparent: global\ntype: fact\n---\n\ngood body\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(staging, 'bad.md'),
      '---\nkey: bad-first\ntitle: first valid block\nparent: global\ntype: fact\n---\n\nfirst body\n\n---\nkey: bad-second\nparent: global\ntype: fact\n---\n\nsecond body (no title)\n',
      'utf8',
    );

    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(1);
    expect(stdout).toContain('import 1 imported, 0 skipped, 1 failed');
    expect(stdout).toContain('failed bad.md: block 2: missing required field');
    expect(fs.readdirSync(path.join(staging, 'fail'))).toEqual(['bad.md']);
    expect(fs.readdirSync(path.join(staging, 'success'))).toEqual(['good.md']);

    const db = openDb();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get('good')).toBeDefined();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get('bad-first')).toBeUndefined();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get('bad-second')).toBeUndefined();
    db.close();
  });

  it('refuses duplicate keys within the same batch with provenance', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(
      path.join(staging, 'a.md'),
      '---\nkey: dupe\ntitle: A title\nparent: global\ntype: fact\n---\n\na body\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(staging, 'b.md'),
      '---\nkey: dupe\ntitle: B title\nparent: global\ntype: fact\n---\n\nb body\n',
      'utf8',
    );

    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(1);
    expect(stdout).toContain('import 1 imported, 1 skipped, 0 failed');
    expect(stdout).toContain('skipped dupe from b.md: duplicate of a key declared in a.md');

    const db = openDb();
    const row = db.prepare('SELECT title, content FROM memories WHERE id = ?').get('dupe') as {
      title: string; content: string;
    };
    expect(row).toEqual({ title: 'A title', content: 'a body' });
    db.close();
  });

  it('quarantines files with no, unterminated, or malformed frontmatter', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'no-fm.md'), 'just some plain prose\n', 'utf8');
    fs.writeFileSync(path.join(staging, 'unterminated.md'), '---\nkey: x\ntitle: t\n', 'utf8');
    fs.writeFileSync(
      path.join(staging, 'bad-value.md'),
      '---\nkey: x\ntitle: "unclosed\nparent: p\ntype: fact\n---\n\nbody\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(staging, 'bad-type.md'),
      '---\nkey: x\ntitle: t\nparent: p\ntype: not-a-type\n---\n\nbody\n',
      'utf8',
    );

    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(1);
    expect(stdout).toContain('failed no-fm.md: no frontmatter sections found');
    expect(stdout).toContain('failed unterminated.md: no complete frontmatter sections found');
    expect(stdout).toContain('failed bad-value.md: malformed');
    expect(stdout).toContain('failed bad-type.md: block 1: invalid type');
    expect(fs.readdirSync(path.join(staging, 'fail')).sort()).toEqual([
      'bad-type.md', 'bad-value.md', 'no-fm.md', 'unterminated.md',
    ]);

    const db = openDb();
    expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toMatchObject({ n: 0 });
    db.close();
  });

  it('ignores non-markdown files in the staging directory', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'notes.txt'), 'not frontmatter\n', 'utf8');
    fs.writeFileSync(
      path.join(staging, 'good.md'),
      '---\nkey: good\ntitle: Good title\nparent: global\ntype: fact\n---\n\ngood body\n',
      'utf8',
    );

    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('import 1 imported, 0 skipped, 0 failed');
    expect(fs.existsSync(path.join(staging, 'notes.txt'))).toBe(true);
    expect(fs.readdirSync(path.join(staging, 'success'))).toEqual(['good.md']);
  });

  it('reports when the staging directory has no markdown files', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    const { code, stdout } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(0);
    expect(stdout).toContain(`no markdown files in ${staging}`);
  });

  it('accepts an explicit empty tags list', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(
      path.join(staging, 'empty-tags.md'),
      '---\nkey: tagged\ntitle: tagged title\nparent: global\ntype: fact\ntags: []\n---\n\nbody\n',
      'utf8',
    );
    const { code } = await runCli(['import', staging], dbEnv());
    expect(code).toBe(0);
    const db = openDb();
    const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get('tagged') as { tags: string | null };
    expect(JSON.parse(row.tags ?? '[]')).toEqual([]);
    db.close();
  });
});

describe('cli reindex', () => {
  const seedVector = (db: Database.Database, id: string): void => {
    const value = new Float32Array(384);
    for (let i = 0; i < value.length; i += 1) value[i] = ((i % 9) + 1) / 10;
    const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
      BigInt(rowid),
      Buffer.from(value.buffer),
    );
  };

  const seedContent = (db: Database.Database): void => {
    createMemory(db, {
      id: 'alpha', title: 'alpha', content: 'alpha zebra crossing', type: 'fact', tier: 'long', source: 'user-stated',
    });
    createMemory(db, {
      id: 'bravo', title: 'bravo', content: 'bravo zebra crossing', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(db, 'alpha');
    seedVector(db, 'bravo');
  };

  it.skipIf(!HAS_MODEL_CACHE)('rebuilds FTS and vector indexes from stored content', async () => {
    const db = openDb();
    seedContent(db);
    db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')").run();
    db.prepare('DELETE FROM memories_vec').run();
    db.close();

    const before = openDatabase(dbPath);
    runMigrations(before, MIGRATIONS);
    expect(before.prepare('SELECT count(*) AS n FROM memories_vec').get()).toMatchObject({ n: 0 });
    expect(
      before.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'zebra'").get(),
    ).toMatchObject({ n: 0 });
    before.close();

    const { code, stdout, stderr } = await runCli(['reindex'], {
      MEMORY_DB_PATH: dbPath,
      MEMORY_EMBEDDING_CACHE_DIR: MODEL_CACHE_DIR,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('reindexed 2 memories (FTS + vectors)');
    expect(stderr).toBe('');

    const after = openDatabase(dbPath);
    runMigrations(after, MIGRATIONS);
    expect(after.prepare('SELECT count(*) AS n FROM memories_vec').get()).toMatchObject({ n: 2 });
    const hits = after
      .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rowid')
      .all('"zebra"') as { rowid: number }[];
    expect(hits).toHaveLength(2);
    const alphaRow = after.prepare('SELECT rowid FROM memories WHERE id = ?').get('alpha') as { rowid: number };
    expect(hits.some((h) => h.rowid === alphaRow.rowid)).toBe(true);
    after.close();
  });

  it('reports a vector rebuild failure while keeping the FTS rebuild', async () => {
    const db = openDb();
    seedContent(db);
    db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')").run();
    db.prepare('DELETE FROM memories_vec').run();
    db.close();

    const missingCache = path.join(dir, 'does-not-exist', 'models');
    const { code, stderr } = await runCli(['reindex'], {
      MEMORY_DB_PATH: dbPath,
      MEMORY_EMBEDDING_CACHE_DIR: missingCache,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('vector rebuild failed');

    const after = openDatabase(dbPath);
    runMigrations(after, MIGRATIONS);
    expect(
      after.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'zebra'").get(),
    ).toMatchObject({ n: 2 });
    expect(after.prepare('SELECT count(*) AS n FROM memories_vec').get()).toMatchObject({ n: 0 });
    after.close();
  });
});
