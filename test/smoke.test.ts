import { describe, expect, it } from 'vitest';
import { appName } from '../src/index.js';

describe('scaffold smoke', () => {
  it('imports the src entry under TypeScript ESM', () => {
    expect(appName).toBe('@jommar/memory-mcp');
  });

  it('runs on a Node version satisfying engines >=22', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
