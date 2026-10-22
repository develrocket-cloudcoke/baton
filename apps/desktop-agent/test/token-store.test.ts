import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { IpcError } from '../src/ipc/envelope';
import { DaemonStatusPayload, SettingsMap } from '../src/ipc/messages';
import { ShellServices } from '../src/services/shell-services';
import { hookCommand, startFakeServer, tmpDir, waitFor } from './helpers';

// 셸의 Keychain 읽기가 실패하는 상황을 흉내 낸다 (ad-hoc 재빌드 후 ACL 프롬프트 → token.get keychain_error).
class FlakyShellServices implements ShellServices {
  failToken = true;
  token: string | null = null;
  settings: SettingsMap = {};
  readonly statuses: DaemonStatusPayload[] = [];

  async getSettings(): Promise<SettingsMap> {
    return this.settings;
  }
  async setSettings(patch: SettingsMap): Promise<SettingsMap> {
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }
  async getToken(): Promise<string | null> {
    if (this.failToken) throw new IpcError('keychain_error', 'Keychain 읽기가 6초 안에 끝나지 않았습니다', true);
    return this.token;
  }
  async setToken(token: string | null): Promise<void> {
    this.token = token;
    this.failToken = false;
  }
  status(payload: DaemonStatusPayload): void {
    this.statuses.push(payload);
  }
  async notify(): Promise<void> {}
  async dismiss(): Promise<void> {}
  progress(): void {}
  log(): void {}
  sendSchema(): void {}

  last(): DaemonStatusPayload {
    return this.statuses[this.statuses.length - 1];
  }
}

// CLO-9 ①: token.get 이 실패해도 데몬은 죽지 않고 사유와 함께 not_paired(idle) 로 떨어진다.
// 예전에는 start() 밖으로 오류가 나가 CLI 가 exit 1 → 셸이 백오프 재시작 → Keychain 프롬프트 재발 루프였다.
test('token.get 실패: 데몬이 죽지 않고 사유와 함께 idle 로 떨어지고, 셸이 다시 알려 주면 회복한다', async () => {
  const home = tmpDir('tokenfail');
  const fake = await startFakeServer();
  const services = new FlakyShellServices();
  services.settings = { serverUrl: fake.url(), deviceName: 'test-mac' };
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, statusIntervalMs: 60_000 });
  try {
    // 1) 읽기 실패 → 예외가 나가지 않는다 (죽지 않는다)
    await daemon.start();
    assert.equal(services.last().state, 'idle');
    assert.equal(services.last().lastError?.code, 'token_unavailable');
    assert.match(services.last().lastError?.message ?? '', /디바이스 토큰을 읽지 못했습니다/);

    // 2) 셸이 settings.changed 로 다시 알려 주지만 아직 토큰이 없다 → not_paired 로만 바뀐다
    services.failToken = false;
    await daemon.applySettings(services.settings);
    assert.equal(services.last().state, 'idle');
    assert.equal(services.last().lastError?.code, 'not_paired');

    // 3) pairing 하면 평소대로 연결된다
    const paired = await daemon.pair('BATON-PAIR-123');
    assert.ok(paired.deviceId);
    await waitFor(() => services.last().state === 'connected');
    assert.equal(services.last().lastError, null);

  } finally {
    await daemon.shutdown();
  }

  // 4) 프롬프트에 늦게 응답한 경우: 토큰은 이미 있는데 첫 token.get 만 실패한 새 데몬이
  //    재시작 없이 settings.changed 한 번으로 연결된다 (셸 TokenService.onLateSuccess 경로)
  const late = new FlakyShellServices();
  late.settings = { ...services.settings };
  late.token = services.token;
  late.failToken = true;      // 첫 읽기는 실패
  const daemon2 = new Daemon({ providers: ['CLAUDE_CODE'], services: late, hook: hookCommand(), home: tmpDir('tokenlate'), statusIntervalMs: 60_000 });
  try {
    await daemon2.start();
    assert.equal(late.last().state, 'idle');
    assert.equal(late.last().lastError?.code, 'token_unavailable');
    late.failToken = false;   // 사용자가 프롬프트에 응답 → 셸이 settings.changed 로 알린다
    await daemon2.applySettings(late.settings);
    await waitFor(() => late.last().state === 'connected');
  } finally {
    await daemon2.shutdown();
    await fake.close();
  }
});
