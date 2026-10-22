import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Daemon } from '../src/daemon';
import { NotificationDismissPayload, RequestNotifyPayload } from '../src/ipc/messages';
import { LocalShellServices } from '../src/services/shell-services';
import { LocalSettingsStore } from '../src/settings/store';
import { hookCommand, postJson, startFakeServer, tmpDir, waitFor } from './helpers';

// 셸 대신 알림·제거 호출을 기록한다 (05 §6 데스크톱 동작 검증용)
class RecordingShellServices extends LocalShellServices {
  notifications: RequestNotifyPayload[] = [];
  dismissals: NotificationDismissPayload[] = [];
  override async notify(payload: RequestNotifyPayload): Promise<void> {
    this.notifications.push(payload);
  }
  override async dismiss(payload: NotificationDismissPayload): Promise<void> {
    this.dismissals.push(payload);
  }
}

function makeDaemon(serverUrl: string) {
  const home = tmpDir('home');
  const store = new LocalSettingsStore(home);
  store.apply({ serverUrl, deviceName: 'test-mac' });
  const services = new RecordingShellServices(store);
  const daemon = new Daemon({ providers: ['CLAUDE_CODE'], services, hook: hookCommand(), home, statusIntervalMs: 60_000 });
  return { store, services, daemon };
}

test('pairing (05 §3.4): 사용자별 코드를 { code, deviceName } 으로 보내고, 만료·재사용·미발급은 403 사유를 그대로 전달한다', async () => {
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const { store, daemon } = makeDaemon(fake.url());
  try {
    await daemon.start();
    const issued = await postJson(`${fake.url()}/__test/pairing-codes`, {
      userId: 'user_b',
      displayName: '박인프라',
    });
    assert.match(issued.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // 소문자·공백 입력도 서버 형식(XXXX-XXXX)으로 정규화해 보낸다
    const typed = issued.code.toLowerCase().replace('-', ' ');
    const paired = await daemon.pair(typed);
    assert.ok(paired.deviceId);
    assert.ok(
      serverLog.some((l) => l === `PAIR_ATTEMPT code=${issued.code} deviceName=test-mac`),
      'body.code 가 정규화된 코드',
    );
    assert.equal(store.all().userId, 'user_b', 'fake-server 가 준 userId 저장');
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    // 재사용 → 403 "이미 사용한 pairing 코드입니다." (연결은 유지: 상태가 idle 로 떨어지지 않는다)
    await assert.rejects(
      () => daemon.pair(issued.code),
      (e: any) =>
        e.code === 'invalid_pairing_code' && e.message === '이미 사용한 pairing 코드입니다.',
    );
    assert.equal(daemon.currentState, 'connected', '재-pairing 실패 후에도 connected 유지');
    // 만료 → 403 "만료된 pairing 코드입니다."
    const expired = await postJson(`${fake.url()}/__test/pairing-codes`, { expiresInMs: -1 });
    await assert.rejects(
      () => daemon.pair(expired.code),
      (e: any) => e.code === 'invalid_pairing_code' && e.message === '만료된 pairing 코드입니다.',
    );
    // 미발급 → 403 "유효하지 않은 pairing 코드입니다."
    await assert.rejects(
      () => daemon.pair('ZZZZ-9999'),
      (e: any) =>
        e.code === 'invalid_pairing_code' && e.message === '유효하지 않은 pairing 코드입니다.',
    );
    // 옛 필드(pairingCode)만 보내는 클라이언트는 400
    const legacy = await fetch(`${fake.url()}/v1/devices/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: issued.code, deviceName: 'old' }),
    });
    assert.equal(legacy.status, 400);
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});

test('팀 뿌리기 (05 §3.2): 팀 알림 제목 → 다른 팀원이 claim 하면 알림 제거·"처리 중: 이름", 본인 claim 은 유지', async () => {
  const serverLog: string[] = [];
  const fake = await startFakeServer({ log: (l) => serverLog.push(l) });
  const { store, services, daemon } = makeDaemon(fake.url());
  try {
    await daemon.start();
    await daemon.pair('BATON-PAIR-123'); // 기본 재사용 코드 → user_b(박인프라)
    await waitFor(() => serverLog.some((l) => l.startsWith('SSE_CONNECTED')));

    // 1) 팀 infra 전체에 뿌린 요청
    const first = await postJson(`${fake.url()}/__test/notify`, {
      title: '로그인 API 오류 해결 요청',
      senderName: '김백엔드',
      recipientTeam: { id: 'team_infra', name: 'infra' },
      recipientUserId: null,
      webUrl: 'http://127.0.0.1:3000/requests/x',
    });
    assert.equal(first.broadcast, true);
    await waitFor(() => services.notifications.length === 1);
    const team = services.notifications[0];
    assert.equal(team.title, '팀 infra 에 새 요청');
    assert.equal(team.body, '김백엔드 → 팀 infra · 로그인 API 오류 해결 요청');
    assert.equal(team.kind, 'request.delivered');
    assert.equal(team.notificationId, `ntf_req_${first.requestId}`);
    assert.equal(team.requestId, first.requestId);

    // 2) 다른 팀원(김디)이 claim → 같은 notificationId 를 제거하고 "처리 중: 김디"
    await postJson(`${fake.url()}/__test/claim`, {
      requestId: first.requestId,
      claimedBy: { userId: 'user_d', displayName: '김디' },
    });
    await waitFor(() => services.dismissals.length === 1);
    const dismissed = services.dismissals[0];
    assert.equal(dismissed.notificationId, `ntf_req_${first.requestId}`);
    assert.equal(dismissed.requestId, first.requestId);
    assert.equal(dismissed.reason, 'claimed');
    assert.equal(dismissed.note, '처리 중: 김디');
    assert.equal(dismissed.claimedBy, '김디');

    // 3) 사람 지정 요청은 기존 제목 그대로
    const personal = await postJson(`${fake.url()}/__test/notify`, {
      title: '개인 요청',
      senderName: '김백엔드',
      recipientTeam: { id: 'team_infra', name: 'infra' },
      recipientUserId: 'user_b',
    });
    assert.equal(personal.broadcast, false);
    await waitFor(() => services.notifications.length === 2);
    assert.equal(services.notifications[1].title, '새로운 Baton 요청');
    assert.equal(services.notifications[1].body, '김백엔드 → 나 · 개인 요청');

    // 3b) recipientTeam 만 있고 recipientUserId 필드가 없으면(구버전 서버) 사람 지정으로 본다
    const noField = await postJson(`${fake.url()}/__test/notify`, {
      title: '필드 없음',
      recipientTeam: { id: 'team_infra', name: 'infra' },
      recipientUserId: 'user_b',
      deviceId: (await (await fetch(`${fake.url()}/__test/state`)).json()).devices[0].id,
    });
    assert.equal(noField.broadcast, false);
    await waitFor(() => services.notifications.length === 3);
    assert.equal(services.notifications[2].title, '새로운 Baton 요청');

    // 4) 본인(user_b)이 claim 한 이벤트가 오면 알림을 지우지 않는다 (서버는 원래 보내지 않지만 방어)
    const second = await postJson(`${fake.url()}/__test/notify`, {
      title: '두 번째 팀 요청',
      recipientTeam: 'infra',
      recipientUserId: null,
    });
    await waitFor(() => services.notifications.length === 4);
    assert.equal(services.notifications[3].title, '팀 infra 에 새 요청');
    await postJson(`${fake.url()}/__test/claim`, {
      requestId: second.requestId,
      claimedBy: { userId: 'user_b', displayName: '박인프라' },
      includeSelf: true,
    });
    // 이벤트가 처리될 때까지(lastEventId 전진) 기다린 뒤 dismiss 가 늘지 않았는지 확인
    const st = await (await fetch(`${fake.url()}/__test/state`)).json();
    const lastId = st.outbox.at(-1).id;
    await waitFor(() => store.all().lastEventId === lastId);
    assert.equal(services.dismissals.length, 1, '본인 claim 은 제거하지 않음');
  } finally {
    await daemon.shutdown();
    await fake.close();
  }
});
