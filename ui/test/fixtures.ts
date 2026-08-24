import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, insertLink, updateMemory } from '../../src/db/queries.js';

const cleanupFns: (() => void)[] = [];

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-mcp-ui-'));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const cleanupAll = (): void => {
  for (const fn of cleanupFns.splice(0)) fn();
};

export const makeDb = (): Database.Database => {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS);
  return db;
};

export interface SeedIds {
  preferenceId: string;
  procedureId: string;
  archivedId: string;
}

export interface SeedResult {
  ids: SeedIds;
  fileDbPath?: string;
}

export const seedGraph = (db: Database.Database): SeedIds => {
  const preferenceId = createMemory(db, {
    title: 'Prefers dark mode',
    content: 'User prefers dark UI themes in all tools',
    type: 'preference',
    tier: 'long',
    source: 'user-stated',
  }).id;
  const procedureId = createMemory(db, {
    title: 'Deploy runbook',
    content: 'Steps to deploy the service to production',
    type: 'procedure',
    tier: 'long',
    source: 'agent-inferred',
    scope: 'memory-mcp',
  }).id;
  const archivedId = createMemory(db, {
    title: 'Old deploy notes',
    content: 'Deprecated deployment notes kept for reference',
    type: 'fact',
    tier: 'long',
    source: 'agent-guessed',
  }).id;
  insertLink(db, preferenceId, procedureId, 'related');
  insertLink(db, archivedId, procedureId, 'supersedes');
  updateMemory(db, procedureId, {
    content: 'Updated steps to deploy the service to production',
    reason: 'runbook revision after incident review',
  });
  updateMemory(db, archivedId, { status: 'archived' });
  return { preferenceId, procedureId, archivedId };
};
