import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../src/adapter/claude-code/adapter';
import { registrationCapabilities } from '../src/adapter/interface';
import { Daemon } from '../src/daemon';
import { deviceInfo } from '../src/transport/device-info';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { serializeProjects } from '../src/settings/projects';
import { agentIdOf, fakeClaudePath, hookCommand, makeProject, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

// 02 §7.4 heartbeat: 주기적으로 디바이스 정보 + 현재 실행 상태를 보낸다. pairing 도 같은 정보를 보낸다.
test('heartbeat: 주기마다 디바이스 정보와 실행 상태를 보내고, pairing 에도 같은 정보를 보낸다', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), deviceName: 'test-mac', projects: serializeProjects([{ name: 'p', path: project, projectIds: {} }]) });
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, claudePath: fakeClaudePath, statusIntervalMs: 60_000, heartbeatIntervalMs: 200 });
  const info = deviceInfo();
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');

    // pairing 요청에 디바이스 정보가 들어간다
    const paired = serverLog.find((l) => l.startsWith('PAIRED'));
    assert.ok(paired, 'PAIRED 로그');
    assert.match(paired!, new RegExp(`platform=${info.platform}`));
    assert.match(paired!, new RegExp(`host=${info.hostname.replace(/\./g, '\\.')}`));
    const st0 = await (await fetch(`${fake.url()}/__test/state`)).json();
    assert.equal(st0.devices[0].platform, info.platform);
    assert.equal(st0.devices[0].osVersion, info.osVersion);
    // 제품 버전 형식은 macOS 에서만 확인한다(CI 는 Linux runner). 전달 경로 검사는 위에서 모든 환경에서 한다.
    if (process.platform === 'darwin')
      assert.ok(info.osVersion.startsWith('macOS '), 'osVersion 은 커널 버전이 아니라 macOS 제품 버전이어야 함');
    assert.equal(st0.devices[0].appVersion, info.appVersion);
    assert.equal(st0.devices[0].hostname, os.hostname());

    // 200ms 주기로 여러 번 온다 (제품 기본값은 60초)
    await waitFor(() => fake.state.heartbeats.length >= 3, 5_000);
    const hb = fake.state.heartbeats[fake.state.heartbeats.length - 1];
    assert.equal(hb.platform, info.platform);
    assert.equal(hb.osVersion, info.osVersion);
    if (process.platform === 'darwin')
      assert.ok(hb.osVersion.startsWith('macOS '), 'heartbeat osVersion 도 macOS 제품 버전이어야 함');
    assert.equal(hb.appVersion, info.appVersion);
    assert.equal(hb.hostname, info.hostname);
    assert.equal(hb.deviceId, store.all().deviceId);
    assert.equal(hb.agentId, agentIdOf(store.all()));
    const capabilities = registrationCapabilities(new ClaudeCodeAdapter({ hook: hookCommand() }));
    assert.deepEqual(hb.capabilities, capabilities);
    assert.deepEqual(st0.agents[0].capabilities, capabilities);
    assert.equal(st0.agents[0].provider, 'CLAUDE_CODE');
    assert.equal(hb.state, 'connected');
    assert.deepEqual(hb.activeExecutionIds, []);
    assert.ok(serverLog.some((l) => l.startsWith('HEARTBEAT') && l.includes('state=connected')));

    // 서버가 heartbeat 를 모르는(404) 경우에도 데몬은 계속 돈다
    await fake.close();
    const before = fake.state.heartbeats.length;
    await daemon.sendHeartbeat();
    assert.equal(fake.state.heartbeats.length, before, '서버가 죽어도 예외로 죽지 않는다');
    assert.equal(daemon.isStopped, false);
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

test('heartbeat: 실행 중이면 activeExecutionIds 에 실행 id 가 담긴다', async () => {
  const home = tmpDir('home');
  const project = makeProject(tmpDir('proj'));
  const fake = await startFakeServer();
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl: fake.url(), deviceName: 'test-mac', projects: serializeProjects([{ name: 'p', path: project, projectIds: {} }]) });
  const services = new LocalShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'],
    services,
    hook: hookCommand(),
    home,
    claudePath: fakeClaudePath,
    statusIntervalMs: 60_000,
    heartbeatIntervalMs: 150
  });
  process.env.FAKE_CLAUDE_MODE = 'hang';
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123');
    await waitFor(() => agentIdOf(store.all()) !== undefined);
    const cmd = await postJson(`${fake.url()}/__test/command`, { title: '오래 걸리는 작업' });
    await waitFor(() => fake.state.heartbeats.some((h: any) => (h.activeExecutionIds || []).includes(cmd.executionId)), 15_000);
    const hb = fake.state.heartbeats.filter((h: any) => (h.activeExecutionIds || []).includes(cmd.executionId)).pop();
    assert.equal(hb.state, 'running');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    await daemon.shutdown();
    await fake.close();
  }
});
