#!/usr/bin/env node
// docs/design/04-shell-daemon-ipc.md 를 그대로 따르는 가짜 데몬 (서버 통신 없음, 시나리오 재생).
// 셸 검증용. 실제 데몬(apps/desktop-agent) 이 생기면 대체된다.
//
// 환경변수:
//   FAKE_DAEMON_LOG      받은 메시지·이벤트를 append 할 파일 (없으면 stderr 만)
//   FAKE_NOTIFY_DELAY_MS connected 후 request.notify 를 보내기까지 지연 (기본 2000)
//   FAKE_WEB_PORT        webUrl 용 미니 HTTP 서버 포트 (기본 4171, 0 이면 서버 없음)
//   FAKE_STATUS_INTERVAL_MS daemon.status 주기 (계약 60000, 테스트용으로 줄일 수 있음)
//   FAKE_STEP_DELAY_MS   execution.progress 단계 사이 간격 (기본 400). 늘리면 running 상태를 오래 잡아 둘 수 있다
//   FAKE_CRASH_AFTER_MS  지정 시 그 시간 뒤 exit 3 (셸의 백오프 재시작 검증용)
//   FAKE_PAIRING_CODE    pair.start 에서 받아들일 코드 (기본 BATON-PAIR-123). `EXPD-0000` 은 만료, `USED-0000` 은 재사용 사유로 거절(05 §3.4 표시 검증)
//   SIGUSR2              팀 뿌리기 시나리오(05 §3.2): "팀 infra 에 새 요청" 알림 → 4초 뒤 다른 팀원 claim → notification.dismiss("처리 중: 박인프라")
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const PROTOCOL = 1;
const VERSION = '0.0.0-fake';
const logPath = process.env.FAKE_DAEMON_LOG;
const notifyDelay = Number(process.env.FAKE_NOTIFY_DELAY_MS ?? 2000);
const webPort = Number(process.env.FAKE_WEB_PORT ?? 4171);
const statusInterval = Number(process.env.FAKE_STATUS_INTERVAL_MS ?? 60000);
const crashAfter = Number(process.env.FAKE_CRASH_AFTER_MS ?? 0);
const stepDelay = Number(process.env.FAKE_STEP_DELAY_MS ?? 400);
const pairingCode = process.env.FAKE_PAIRING_CODE ?? 'BATON-PAIR-123';

let seq = 0;
const pending = new Map(); // id → resolve
const now = () => new Date().toISOString();
function log(line) {
  const text = `[${now()}] ${line}\n`;
  process.stderr.write(text); // stdout 은 JSON Lines 전용 (계약 §1)
  if (logPath) fs.appendFileSync(logPath, text);
}
function send(type, payload = {}, replyTo) {
  const env = { v: PROTOCOL, type, id: `d-${++seq}`, ts: now(), payload };
  if (replyTo) env.replyTo = replyTo;
  process.stdout.write(JSON.stringify(env) + '\n');
  return env.id;
}
function request(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = send(type, payload);
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timeout`)); }, timeoutMs);
    pending.set(id, (env) => { clearTimeout(t); resolve(env); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 상태
let settings = {};
let token = null;
let state = 'idle';
let deviceId = null;
function status(next, lastError = null) {
  state = next;
  send('daemon.status', { state, since: now(), deviceId, lastError, activeExecutionId: state === 'running' ? 'exe_fake_1' : null });
}

// 미니 웹 서버: webUrl 클릭 시 브라우저에 뜨는 페이지
let webBase = null;
if (webPort > 0) {
  const server = http.createServer((req, res) => {
    log(`WEB_HIT ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>Baton fake web</h1><p>${req.url}</p><p>이 페이지는 apps/desktop-macos/scripts/fake-daemon.mjs 가 띄운 것입니다.</p>`);
  });
  server.listen(webPort, '127.0.0.1', () => { webBase = `http://127.0.0.1:${webPort}`; log(`WEB_LISTENING ${webBase}`); });
  server.on('error', (e) => log(`WEB_ERROR ${e.message}`));
}

// stdin: 바이트 기반 줄 분리
let buf = Buffer.alloc(0);
let helloDone = false;
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let nl;
  while ((nl = buf.indexOf(0x0a)) >= 0) {
    let line = buf.subarray(0, nl); buf = buf.subarray(nl + 1);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (!line.length) continue;
    let env;
    try { env = JSON.parse(line.toString('utf8')); } catch { log(`ipc.malformed ${line.toString('utf8').slice(0, 80)}`); continue; }
    handle(env).catch((e) => log(`HANDLE_ERROR ${e.message}`));
  }
});
process.stdin.on('end', () => { log('STDIN_EOF → exit'); setTimeout(() => process.exit(0), 100); }); // 계약 §6-8

async function handle(env) {
  if (!env || typeof env !== 'object' || env.v !== PROTOCOL || !env.type || !env.id) { log(`ipc.invalid_envelope ${JSON.stringify(env).slice(0, 120)}`); if (env?.id) send('error', { code: 'invalid_envelope', message: 'bad envelope', retryable: false }, env.id); return; }
  log(`RECV ${env.type} id=${env.id}${env.replyTo ? ' replyTo=' + env.replyTo : ''} ${JSON.stringify(env.payload).slice(0, 200)}`);
  if (env.replyTo) { const r = pending.get(env.replyTo); if (r) { pending.delete(env.replyTo); r(env); } else log(`ipc.unknown_reply ${env.replyTo}`); return; }
  switch (env.type) {
    case 'shell.hello': // daemon.hello 의 reply 이므로 replyTo 로 위에서 처리됨. 방어적으로 둔다.
      return;
    case 'settings.changed':
      settings = env.payload.settings ?? settings; log(`SETTINGS_CHANGED ${JSON.stringify(settings)}`); return;
    case 'pair.start': {
      const code = String(env.payload.pairingCode ?? '').trim().toUpperCase();
      // 실서버(PairingService)의 403 사유를 그대로 흉내낸다 — 셸이 팝오버에 표시하는지 검증용
      const reject = (message) => send('pair.result', { ok: false, deviceId: null, error: { code: 'invalid_pairing_code', message } }, env.id);
      if (code === 'EXPD-0000') { reject('만료된 pairing 코드입니다.'); return; }
      if (code === 'USED-0000') { reject('이미 사용한 pairing 코드입니다.'); return; }
      if (code !== pairingCode.toUpperCase()) { reject('유효하지 않은 pairing 코드입니다.'); return; }
      status('connecting');
      await sleep(300);
      token = 'fake-token-' + Math.random().toString(36).slice(2);
      deviceId = 'dev_fake_' + os.hostname().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      await request('token.set', { deviceToken: token });                 // 저장 완료를 기다린 뒤
      await request('settings.set', { patch: { deviceId } });
      send('pair.result', { ok: true, deviceId, error: null }, env.id);  // pair.result (계약 §3.4)
      status('connected');
      scheduleScenario();
      return;
    }
    case 'notification.clicked':
      log(`NOTIFICATION_CLICKED notificationId=${env.payload.notificationId} requestId=${env.payload.requestId} action=${env.payload.action} webUrl=${env.payload.webUrl}`);
      send('ack', {}, env.id); return;
    case 'daemon.shutdown':
      log(`SHUTDOWN reason=${env.payload.reason}`); send('ack', {}, env.id); setTimeout(() => process.exit(0), 50); return;
    default:
      send('error', { code: 'unknown_type', message: env.type, retryable: false }, env.id);
  }
}

let scenarioStarted = false;
async function scheduleScenario() {
  if (scenarioStarted) return; scenarioStarted = true;
  await sleep(notifyDelay);
  const requestId = 'req_fake_' + Date.now().toString(36);
  const notificationId = 'ntf_' + requestId;
  const webUrl = webBase ? `${webBase}/requests/${requestId}` : null;
  await request('request.notify', { notificationId, kind: 'request.delivered', requestId, title: '새로운 Baton 요청', body: 'A → 나 · 로그인 API 오류 해결 요청', webUrl });
  log(`NOTIFY_ACKED ${notificationId}`);
  await sleep(1500);
  status('running');
  const steps = [['started', '작업 시작 (model=claude-haiku)'], ['reading_input', 'login-error-analysis.md 읽는 중'], ['exploring', '프로젝트 구조 확인'], ['editing', '코드 수정: src/auth/login.ts'], ['testing', '테스트 실행'], ['test_passed', '테스트 성공 (12 passed)'], ['writing_result', '결과 문서 작성: result.md'], ['finished', '작업 완료 (turns=9)']];
  for (const [phase, message] of steps) { send('execution.progress', { executionId: 'exe_fake_1', requestId, phase, message, at: now() }); await sleep(stepDelay); }
  await request('settings.set', { patch: { lastEventId: String(Date.now() % 1000) } });
  // 토큰 갱신 시나리오: 셸이 Keychain 값을 바꿔 저장하는지 검증 (security find-generic-password 로 확인 가능)
  token = 'fake-token-rotated-' + Date.now().toString(36);
  const tv = await request('token.set', { deviceToken: token });
  log(`TOKEN_ROTATED stored=${tv.payload.deviceToken === token}`);
  status('connected');
  await request('request.notify', { notificationId: 'ntf_done_' + requestId, kind: 'execution.finished', requestId, title: '작업 완료 · 결과 검토 필요', body: '로그인 API 오류 해결 요청 · 변경 파일 1 · 12 passed', webUrl });
}

// 테스트 보조: SIGUSR2 → 팀 뿌리기(05 §3.2). 팀원 전원에게 온 요청 알림 뒤 다른 팀원이 claim 하면 배너를 지우고 알림 탭을 "처리 중: 이름" 으로 바꾼다.
process.on('SIGUSR2', async () => {
  const requestId = 'req_team_' + Date.now().toString(36);
  const notificationId = 'ntf_req_' + requestId;
  const webUrl = webBase ? `${webBase}/requests/${requestId}` : null;
  try {
    await request('request.notify', { notificationId, kind: 'request.delivered', requestId, title: '팀 infra 에 새 요청', body: '김백엔드 → 팀 infra · 로그인 API 오류 해결 요청', webUrl });
    log(`NOTIFY_ACKED ${notificationId} (team broadcast)`);
    await sleep(Number(process.env.FAKE_CLAIM_DELAY_MS ?? 4000));
    const ack = await request('notification.dismiss', { notificationId, requestId, reason: 'claimed', note: '처리 중: 박인프라', claimedBy: '박인프라' });
    log(`DISMISS_ACKED ${notificationId} reply=${ack.type}`);
  } catch (e) { log(`TEAM_SCENARIO_ERROR ${e.message}`); }
});

// 테스트 보조: SIGUSR1 을 받으면 request.notify 를 한 건 더 보낸다 (배너 클릭 검증용)
process.on('SIGUSR1', () => {
  const requestId = 'req_usr1_' + Date.now().toString(36);
  request('request.notify', { notificationId: 'ntf_' + requestId, kind: 'request.delivered', requestId, title: '새로운 Baton 요청 (USR1)', body: 'A → 나 · 배너 클릭 검증', webUrl: webBase ? `${webBase}/requests/${requestId}` : null })
    .then(() => log(`NOTIFY_ACKED ntf_${requestId}`)).catch((e) => log(`NOTIFY_ERROR ${e.message}`));
});

async function main() {
  const shellHello = await request('daemon.hello', { protocol: PROTOCOL, daemonVersion: VERSION, pid: process.pid, capabilities: ['pairing', 'sse', 'claude-code'] }, 10000);
  helloDone = true;
  settings = shellHello.payload.settings ?? {};
  token = shellHello.payload.deviceToken ?? null;
  deviceId = settings.deviceId ?? null;
  log(`HANDSHAKE shell=${shellHello.payload.shellVersion} platform=${shellHello.payload.platform} hasToken=${!!token} settings=${JSON.stringify(settings)}`);
  send('settings.schema', { fields: [
    { key: 'serverUrl', label: '서버 URL', type: 'url', required: true, default: 'https://baton.example.com', help: 'Baton 서버 주소' },
    { key: 'projectPath', label: '프로젝트 경로', type: 'path', required: false, default: null, help: 'Claude Code 를 실행할 로컬 프로젝트' },
    { key: 'deviceName', label: '디바이스 이름', type: 'string', required: false, default: os.hostname() },
    { key: 'deviceId', label: '디바이스 ID', type: 'string', required: false, readonly: true, default: null },
    { key: 'lastEventId', label: '마지막 이벤트', type: 'string', required: false, hidden: true, default: '0' },
  ] });
  // token.get 으로 다시 읽는 경로도 한 번 검증
  const tv = await request('token.get', {});
  token = tv.payload.deviceToken ?? token;
  if (token) { status('connecting'); await sleep(500); status('connected'); scheduleScenario(); }
  else { status('idle', { code: 'not_paired', message: 'pairing code 를 입력해 주세요', at: now() }); }
  setInterval(() => send('daemon.status', { state, since: now(), deviceId, lastError: null, activeExecutionId: null }), statusInterval);
  if (crashAfter > 0) setTimeout(() => { log('CRASH (test)'); process.exit(3); }, crashAfter);
}
main().catch((e) => { log(`FATAL ${e.message}`); process.exit(2); });
