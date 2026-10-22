import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { parseProjects, serializeProjects } from '../src/settings/projects';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { fakeClaudePath, hookCommand, makeProject, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

// 04 §11.1 프로젝트 여러 개: 목록 등록 → projectId → 로컬 경로 매핑으로 실행, 매핑 없으면 FAILED
test('다중 프로젝트: 목록의 프로젝트를 각각 등록하고 명령의 projectId 에 해당하는 경로에서 실행한다', async () => {
  const home = tmpDir('home');
  const backend = makeProject(tmpDir('backend'));
  const infra = makeProject(tmpDir('infra'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({
    serverUrl: fake.url(),
    deviceName: 'test-mac',
    projects: serializeProjects([
      { name: 'backend-api', path: backend, projectIds: {} },
      { name: 'infra', path: infra, projectIds: {} }
    ])
  });
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000 });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    // 두 프로젝트 모두 서버에 Project 로 등록되고, projectId 가 설정에 저장된다
    const registered = parseProjects(store.all());
    assert.equal(registered.length, 2);
    assert.ok(registered.every((e) => typeof e.projectIds.CLAUDE_CODE === 'string' && e.projectIds.CLAUDE_CODE!.length > 0), 'projectId 저장');
    assert.deepEqual(
      registered.map((e) => e.path),
      [backend, infra]
    );
    const st0 = await (await fetch(`${fake.url()}/__test/state`)).json();
    assert.equal(st0.projects.length, 2);
    assert.deepEqual(
      st0.projects.map((p: any) => p.displayName).sort(),
      ['backend-api', 'infra']
    );
    assert.deepEqual(
      st0.projects.map((p: any) => p.localPathHint).sort(),
      [backend, infra].sort()
    );
    // 두 번째 프로젝트(infra)로 실행 → infra 경로의 파일이 바뀐다
    const infraId = registered[1].projectIds.CLAUDE_CODE!;
    const cmd = await postJson(`${fake.url()}/__test/command`, { projectId: infraId, title: 'infra 쪽 수정', originalInstruction: 'add() 를 고쳐주세요' });
    await waitFor(() => fake.state.results.has(cmd.executionId), 30_000);
    const st = await (await fetch(`${fake.url()}/__test/state`)).json();
    assert.equal(st.results[cmd.executionId].status, 'SUCCEEDED');
    assert.equal(fs.readFileSync(path.join(infra, 'src', 'add.js'), 'utf8').includes('a + b'), true, 'infra 가 수정됨');
    assert.equal(fs.readFileSync(path.join(backend, 'src', 'add.js'), 'utf8').includes('a - b'), true, 'backend 는 그대로');
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

test('매핑 없는 projectId: 실행하지 않고 FAILED 와 사유를 보고한다', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), deviceName: 'test-mac', projects: serializeProjects([{ name: 'only', path: project, projectIds: {} }]) });
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000 });
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    const unknown = '00000000-0000-4000-8000-0000000000ff';
    const cmd = await postJson(`${fake.url()}/__test/command`, { projectId: unknown, title: '모르는 프로젝트' });
    await waitFor(() => fake.state.results.has(cmd.executionId), 15_000);
    const st = await (await fetch(`${fake.url()}/__test/state`)).json();
    const result = st.results[cmd.executionId];
    assert.equal(result.status, 'FAILED');
    assert.match(result.failureReason, new RegExp(`projectId ${unknown} 에 해당하는 로컬 프로젝트가 이 디바이스에 없습니다`));
    assert.match(result.failureReason, /등록된 프로젝트: only\(/);
    // claude 를 아예 실행하지 않았다 (프로젝트 파일이 그대로)
    assert.ok(fs.readFileSync(path.join(project, 'src', 'add.js'), 'utf8').includes('a - b'));
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

test('구버전 설정 이관: 항목의 단일 projectId 는 그때 등록돼 있던 provider 자리로 옮긴다', () => {
  const list = parseProjects({
    agentProvider: 'CODEX',
    projects: serializeLegacy([{ name: 'a', path: '/tmp/a', projectId: 'p1' }])
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].projectIds.CODEX, 'p1');

  // agentProvider 가 없던 설정은 CLAUDE_CODE 로 본다
  const claude = parseProjects({ projects: serializeLegacy([{ name: 'a', path: '/tmp/a', projectId: 'p1' }]) });
  assert.equal(claude[0].projectIds.CLAUDE_CODE, 'p1');
});

test('망가진 projects 설정은 조용히 무시한다', () => {
  assert.deepEqual(parseProjects({ projects: '{{{' }), []);
  assert.deepEqual(parseProjects({ projects: '[{"name":"a"},{"name":"b","path":"/tmp/b"}]' }).map((e) => e.name), ['b']);
});

function serializeLegacy(list: Array<{ name: string; path: string; projectId: string | null }>): string {
  return JSON.stringify(list);
}
