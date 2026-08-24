import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/server.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const DIST_SERVER = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const PROTOCOL_VERSION = '2026-07-28';

const run = (command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
      } else {
        resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr });
      }
    });
  });

let tmpRoot: string;
let tarballPath: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-pack-'));
  const build = await run('npm', ['run', 'build'], REPO_ROOT);
  if (build.code !== 0) throw new Error(`build failed: ${build.stderr}`);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const toolsListRequest = (id = 1): string =>
  `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })}\n`;

describe('npm pack tarball', () => {
  it('produces a tarball containing the bin entries, source, docs, README and LICENSE', async () => {
    const pack = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmpRoot], REPO_ROOT);
    expect(pack.code).toBe(0);
    const [manifest] = JSON.parse(pack.stdout) as { filename: string }[];
    tarballPath = path.join(tmpRoot, manifest.filename);
    expect(fs.existsSync(tarballPath)).toBe(true);

    const list = await run('tar', ['-tzf', tarballPath], tmpRoot);
    expect(list.code).toBe(0);
    const entries = list.stdout.split('\n').filter((line) => line !== '');
    for (const required of [
      'package/dist/cli.js',
      'package/dist/src/index.js',
      'package/cli.ts',
      'package/src/config.ts',
      'package/src/server.ts',
      'package/docs/tools.md',
      'package/docs/reliability.md',
      'package/README.md',
      'package/LICENSE',
    ]) {
      expect(entries).toContain(required);
    }
    expect(entries.some((entry) => entry.startsWith('package/test/'))).toBe(false);

    const pkgJson = await run('tar', ['-xOzf', tarballPath, 'package/package.json'], tmpRoot);
    const packaged = JSON.parse(pkgJson.stdout) as { bin: Record<string, string> };
    expect(packaged.bin).toEqual({
      'memory-mcp': './dist/cli.js',
      'memory-mcp-server': './dist/src/index.js',
    });
  });
});

describe('packaged bin launch', () => {
  it('starts the stdio server from the dist bin and serves the ten tools', async () => {
    const dbPath = path.join(tmpRoot, 'server-launch.db');
    const child = spawn(process.execPath, [DIST_SERVER], {
      cwd: REPO_ROOT,
      env: { ...process.env, MEMORY_DB_PATH: dbPath, MEMORY_EMBEDDING_OFFLINE: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      child.stdin.write(toolsListRequest(1));
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no tools/list response within 15s; stderr: ${stderr}`)),
          15000,
        );
        const poll = setInterval(() => {
          const line = stdout.split('\n').find((candidate) => candidate.includes('"tools"'));
          if (line !== undefined) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(line);
          }
        }, 100);
      });
      const parsed = JSON.parse(response) as { result: { tools: { name: string }[] } };
      expect(parsed.result.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('launches the dist CLI bin and prints usage', async () => {
    const { code, stdout } = await run(process.execPath, [DIST_CLI, '--help'], REPO_ROOT);
    expect(code).toBe(0);
    expect(stdout).toContain('usage: memory-mcp');
    expect(stdout).toContain('export');
    expect(stdout).toContain('import');
    expect(stdout).toContain('reindex');
    expect(stdout).toContain('stats');
  });
});
