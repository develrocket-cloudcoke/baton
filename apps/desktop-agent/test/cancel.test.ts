import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { ExecutionProgressPayload } from '../src/ipc/messages';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { serializeProjects } from '../src/settings/projects';
import { fakeClaudePath, hookCommand, makeProject, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

// 셸 활동 탭에 들어갈 execution.progress 를 기록한다
class RecordingShellServices extends LocalShellServices {
  progressEvents: ExecutionProgressPayload[] = [];
  override progress(payload: ExecutionProgressPayload): void {
    this.progressEvents.push(payload);
    super.progress(payload);
  }
}

function makeDaemon(serverUrl: string, project: string) {
  const home = tmpDir('home');
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl, deviceName: 'test-mac', projects: serializeProjects([{ name: 'p', path: project, projectIds: {} }]) });
  const services = new RecordingShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000, heartbeatIntervalMs: 60_000 });
  return { store, services, daemon };
}

// 01 §5.4 execution.command.cancel_requested → claude SIGTERM → CANCELLED 보고 + 활동 탭 표시.
// hang 모드는 아무것도 고치지 않으므로 수집된 변경이 없고, 그러면 부분 결과도 만들지 않는다(CLO-11).
// 웹은 그 회차를 '취소됨 (수집된 변경 없음)' 으로 보여 준다.
test('실행 취소: 진행 중인 claude 를 종료하고 활동 탭에 cancelled 를 남긴다 (수집된 변경이 없으면 서버 보고 없음)', async () => {
  const project = makeProject(tmpDir('proj'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const { store, services, daemon } = makeDaemon(fake.url(), project);
  process.env.FAKE_CLAUDE_MODE = 'hang';
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    const cmd = await postJson(`${fake.url()}/__test/command`, { title: '취소할 작업' });
    // claude 가 떠서 진행 상태가 흐를 때까지 기다린다
    await waitFor(() => services.progressEvents.some((p) => p.executionId === cmd.executionId && p.phase === 'started'), 15_000);
    assert.equal(daemon.currentState, 'running');

    await postJson(`${fake.url()}/__test/cancel`, { executionId: cmd.executionId, requestId: cmd.requestId, reason: 'B 가 취소함' });
    // 서버가 시킨 취소는 서버가 이미 CANCELLED 로 확정했으므로 상태를 되돌리는 보고는 하지 않는다 (W6d).
    await waitFor(() => services.progressEvents.filter((p) => p.phase === 'cancelled').length >= 2, 15_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fake.state.results.has(cmd.executionId), false, '수집된 변경이 없으면 부분 결과도 보고하지 않는다');

    // 활동 탭: 취소 요청 시점과 종료 시점 두 줄
    const cancelled = services.progressEvents.filter((p) => p.phase === 'cancelled');
    assert.ok(cancelled.length >= 2, `cancelled progress ${cancelled.length}`);
    assert.match(cancelled[0].message, /실행 취소 요청: B 가 취소함/);
    assert.match(cancelled[cancelled.length - 1].message, /실행이 취소되었습니다/);
    // 데몬은 죽지 않고 다시 대기 상태로 돌아온다
    await waitFor(() => daemon.currentState === 'connected');
    assert.equal(store.all().lastEventId, String(Number(cmd.eventId) + 1));
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    await daemon.shutdown();
    await fake.close();
  }
});

// CLO-11 취소된 실행의 부분 결과: 취소 시점까지 수집된 3계층 결과를 status=CANCELLED 로 올린다.
// 서버는 이미 CANCELLED 인 Execution 에 PARTIAL Result 만 붙이고 Request 상태는 바꾸지 않는다 (01 §5.3).
test('실행 취소: 취소 시점까지 수집된 부분 결과(patch·result.md)를 서버에 올린다', async () => {
  const project = makeProject(tmpDir('proj'));
  const fake = await startFakeServer();
  const { services, daemon } = makeDaemon(fake.url(), project);
  process.env.FAKE_CLAUDE_MODE = 'partial';
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    const cmd = await postJson(`${fake.url()}/__test/command`, { title: '중간에 취소할 작업' });
    // 파일을 실제로 고친 뒤에 취소해야 '부분 결과' 가 생긴다
    await waitFor(() => services.progressEvents.some((p) => p.executionId === cmd.executionId && p.phase === 'editing'), 15_000);

    await postJson(`${fake.url()}/__test/cancel`, { executionId: cmd.executionId, requestId: cmd.requestId, reason: 'B 가 취소함' });
    await waitFor(() => fake.state.results.has(cmd.executionId), 15_000);

    const result = fake.state.results.get(cmd.executionId);
    assert.equal(result.status, 'CANCELLED');
    assert.deepEqual(result.changedFiles, ['src/add.js']);
    assert.match(result.summary, /뺄셈 버그까지 고쳤고/, `summary=${result.summary}`);
    // 계층1·2 patch 와 계층3 result.md 가 산출물로 올라간다
    const uploaded = [...fake.state.uploads.values()].filter((u) => result.artifactIds.includes(u.id));
    assert.equal(uploaded.length, result.artifactIds.length);
    assert.deepEqual(uploaded.map((u) => u.kind).sort(), ['PATCH', 'RESULT_ATTACHMENT']);
    assert.ok(uploaded.every((u) => u.completed && u.data.length > 0), '업로드 본문이 비어 있다');
    assert.match(uploaded.find((u) => u.kind === 'PATCH').data.toString('utf8'), /src\/add\.js/);
    // 활동 탭에도 부분 결과 보고가 한 줄 남는다
    assert.ok(services.progressEvents.some((p) => p.message.includes('부분 결과를 보고했습니다')), '부분 결과 progress 없음');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    await daemon.shutdown();
    await fake.close();
  }
});

test('실행 취소: SIGTERM 을 무시하는 자식은 SIGKILL 로 끝낸다', async () => {
  const project = makeProject(tmpDir('proj'));
  const fake = await startFakeServer();
  const { services, daemon } = makeDaemon(fake.url(), project);
  process.env.FAKE_CLAUDE_MODE = 'hang';
  process.env.FAKE_CLAUDE_IGNORE_SIGTERM = '1';
  process.env.BATON_CANCEL_GRACE_MS = '300';
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    const cmd = await postJson(`${fake.url()}/__test/command`, { title: '안 죽는 작업' });
    await waitFor(() => services.progressEvents.some((p) => p.phase === 'started'), 15_000);
    await postJson(`${fake.url()}/__test/cancel`, { executionId: cmd.executionId, requestId: cmd.requestId });
    // SIGTERM 을 무시해도 SIGKILL 로 끝나 실행이 종료된다 (cancelled progress 2줄)
    await waitFor(() => services.progressEvents.filter((p) => p.phase === 'cancelled').length >= 2, 15_000);
    assert.equal(fake.state.results.has(cmd.executionId), false);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_IGNORE_SIGTERM;
    delete process.env.BATON_CANCEL_GRACE_MS;
    await daemon.shutdown();
    await fake.close();
  }
});

test('실행 취소: 명령보다 취소가 먼저 오면 claude 를 아예 띄우지 않는다', async () => {
  const project = makeProject(tmpDir('proj'));
  const fake = await startFakeServer();
  const { services, daemon } = makeDaemon(fake.url(), project);
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    const executionId = '11111111-1111-4111-8111-111111111111';
    await daemon.handleCancel(executionId, null, '선취소');
    const cmd = await postJson(`${fake.url()}/__test/command`, { executionId, title: '취소된 뒤 온 명령' });
    await waitFor(() => services.progressEvents.some((p) => p.executionId === executionId && p.message.includes('시작하지 않습니다')), 10_000);
    assert.ok(!services.progressEvents.some((p) => p.phase === 'started'), 'claude 미실행');
    assert.equal(cmd.executionId, executionId);
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

// 서버가 시킨 취소가 아니라 데몬이 스스로 멈춘 경우(셸 종료·stdin EOF)는 서버가 아직 RUNNING 으로 알고 있으므로
// FAILED 로 알려서 Execution 이 영원히 RUNNING 에 남지 않게 한다 (W6d).
test('데몬 종료로 중단: 서버에 FAILED 와 사유를 알린다', async () => {
  const project = makeProject(tmpDir('proj'));
  const fake = await startFakeServer();
  const { services, daemon } = makeDaemon(fake.url(), project);
  process.env.FAKE_CLAUDE_MODE = 'hang';
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    const cmd = await postJson(`${fake.url()}/__test/command`, { title: '중단될 작업' });
    await waitFor(() => services.progressEvents.some((p) => p.phase === 'started'), 15_000);

    // 셸 종료 경로: 자식에게 SIGINT (취소의 SIGTERM 과 구분)
    await daemon.shutdown();
    await waitFor(() => fake.state.results.has(cmd.executionId), 15_000);
    const result = fake.state.results.get(cmd.executionId);
    assert.equal(result.status, 'FAILED');
    assert.match(result.failureReason, /데몬이 종료되어 실행이 중단되었습니다/);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    await daemon.shutdown();
    await fake.close();
  }
});
