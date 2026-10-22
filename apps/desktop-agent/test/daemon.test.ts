import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { parseProjects } from '../src/settings/projects';
import { agentIdOf, fakeClaudePath, hookCommand, makeProject, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

test('데몬 콘솔 모드 한 바퀴: pairing → 등록 → SSE → 명령 → fake-claude 실행 → status/result/artifact 보고', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), projectPath: project, deviceName: 'test-mac' });
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000 });
  try {
    await daemon.start();
    assert.equal(store.getToken(), null);
    const paired = await daemon.pair('BATON-PAIR-123');
    assert.ok(paired.deviceId);
    assert.ok(store.getToken(), '토큰 파일 저장');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));
    const settings = store.all();
    assert.ok(agentIdOf(settings), 'agent 등록');
    // 구버전 projectPath 는 시작할 때 프로젝트 목록으로 옮겨지고 키 자체가 사라진다
    assert.equal(settings.projectPath, undefined, '구버전 projectPath 제거');
    const projects = parseProjects(settings);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, project);
    assert.ok(projects[0].projectIds.CLAUDE_CODE, 'project 등록');

    const cmd = await postJson(`${fake.url()}/__test/command`, { title: 'add 버그', originalInstruction: 'add() 를 고쳐주세요', additionalInstruction: '운영 환경은 변경하지 마', policy: { repository_edit: 'allow', deployment_apply: 'deny' } });
    await waitFor(() => fake.state.results.has(cmd.executionId), 30_000);
    const st = await (await fetch(`${fake.url()}/__test/state`)).json();
    const statuses = st.statuses.filter((s: any) => s.executionId === cmd.executionId);
    assert.equal(statuses[0].status, 'RUNNING');
    const phases = statuses.filter((s: any) => s.status === 'PROGRESS').map((s: any) => s.phase);
    for (const p of ['started', 'editing', 'testing', 'finished']) assert.ok(phases.includes(p), `phase ${p}`);
    const result = st.results[cmd.executionId];
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(result.changedFiles, ['src/add.js']);
    assert.ok(result.summary.includes('add()'));
    assert.equal(result.artifactIds.length, 3);
    assert.deepEqual(st.artifacts.map((a: any) => a.kind).sort(), ['PATCH', 'RESULT_ATTACHMENT', 'TEST_OUTPUT']);
    assert.ok(st.artifacts.every((a: any) => a.completed && a.bytes > 0));
    assert.equal(store.all().lastEventId, cmd.eventId);
    assert.ok(serverLog.some((l) => l.includes('PRESENCE') && l.includes('BUSY')));
    assert.ok(serverLog.some((l) => l.includes('PRESENCE') && l.includes('ONLINE')));

    // 같은 이벤트를 다시 받아도 재실행하지 않는다 (멱등)
    await postJson(`${fake.url()}/__test/replay/${cmd.eventId}`, {}, store.getToken()!);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(st.statuses.length, (await (await fetch(`${fake.url()}/__test/state`)).json()).statuses.length);
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});
