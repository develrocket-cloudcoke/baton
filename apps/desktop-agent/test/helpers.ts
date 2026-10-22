import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FakeServer {
  url: () => string;
  ready: Promise<string>;
  close: () => Promise<void>;
  state: Record<string, any>;
  emit: (deviceId: string, eventName: string, payload: Record<string, unknown>) => { id: string };
}

// CJS 테스트에서 ESM fake-server 를 동적으로 불러온다
export async function startFakeServer(options: { pairingCode?: string; log?: (l: string) => void } = {}): Promise<FakeServer> {
  const mod = (await import(pathToFileURL(path.join(__dirname, 'fake-server.mjs')).href)) as { createFakeServer: (o: Record<string, unknown>) => FakeServer };
  const fake = mod.createFakeServer({ port: 0, ...options });
  await fake.ready;
  return fake;
}

export const fakeClaudePath = path.join(__dirname, 'fake-claude.mjs');

// 데몬 CLI 자신을 hook 으로 부른다 (tsx 로 src/cli.ts 실행)
export function hookCommand(): { node: string; cli: string } {
  return { node: path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx'), cli: path.resolve(__dirname, '..', 'src', 'cli.ts') };
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `baton-${prefix}-`));
}

// 작은 git 프로젝트 fixture (poc/adapter 와 동일: add() 버그)
export function makeProject(root: string, withGit = true): string {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'add.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  fs.writeFileSync(path.join(root, 'test', 'add.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n테스트: node --test\n');
  if (withGit) execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m init', { cwd: root });
  return root;
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}

export async function postJson(url: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return res.json();
}

// 설정에 저장된 provider → agentId 맵 (04 §4 `agents`)
export function agentsOf(settings: Record<string, any>): Record<string, string> {
  try {
    const parsed = JSON.parse(String(settings.agents ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function agentIdOf(settings: Record<string, any>, provider = 'CLAUDE_CODE'): string | undefined {
  return agentsOf(settings)[provider];
}
