import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:3001';
const WEB_BASE = 'http://127.0.0.1:3002';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, delayMs = 1500) {
  const fullUrl = `${WEB_BASE}${urlPath}`;
  const outPath = path.join(SCREENSHOTS_DIR, filename);
  console.log(`[Capture] ${fullUrl} -> ${filename}`);
  try {
    if (delayMs > 0) {
      execSync(`sleep ${delayMs / 1000}`);
    }
    const cmd = `"${CHROME_PATH}" --headless --disable-gpu --window-size=1280,960 --screenshot="${outPath}" "${fullUrl}" 2>/dev/null`;
    execSync(cmd);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  } catch (err) {
    console.error(`  ✗ Error capturing ${filename}:`, err.message);
  }
}

async function serverApi(path, options = {}, token = null, retries = 5) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'Connection': 'close',
    ...(options.headers || {})
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error ${res.status} on ${path}: ${text}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`    [Retry ${attempt}/${retries}] ${path}: ${err.message}`);
      execSync('sleep 0.5');
    }
  }
}

async function runRealVerification() {
  console.log('====================================================');
  console.log('  Baton Web Real 모드 실서버 연동 검증 & 스크린샷  ');
  console.log('====================================================\n');

  // 1. 서버 헬스체크
  console.log('[Step 1] apps/server (3001) 헬스체크 확인');
  const health = await serverApi('/health');
  console.log('  ✓ Server health:', health);

  // 2. User A, B 로그인 및 토큰 확보
  console.log('\n[Step 2] User A & B 실서버 인증 토큰 발급');
  const loginA = await serverApi('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@baton.local', password: 'baton-dev-password' })
  });
  const tokenA = loginA.token;
  const userA = loginA.user;
  console.log(`  ✓ User A 로그인 성공: ${userA.id} (${userA.email})`);

  const loginB = await serverApi('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'b@baton.local', password: 'baton-dev-password' })
  });
  const tokenB = loginB.token;
  const userB = loginB.user;
  console.log(`  ✓ User B 로그인 성공: ${userB.id} (${userB.email})`);

  const teamId = '00000000-0000-4000-8000-000000000001';
  const agentId = '00000000-0000-4000-8000-000000000002';
  const projectId = '00000000-0000-4000-8000-000000000003';
  const deviceToken = 'seed-device-token';

  // 스크린샷 1: 로그인 화면
  console.log('\n[화면 1] ① 로그인 화면 (/login)');
  capture('/login', 'real-01-login.png');

  // 스크린샷 2: 요청 목록 화면
  console.log('\n[화면 2] ② 요청 목록 화면 (/requests)');
  capture('/requests?as=a', 'real-02-requests-list.png');

  // 스크린샷 3: 새 요청 작성 화면
  console.log('\n[화면 3] ③ 새 요청 작성 화면 (/requests/new)');
  capture('/requests/new?as=a', 'real-03-request-new.png');

  // 3. User A의 요청 생성 및 파일 업로드 시나리오 실행
  console.log('\n[Step 3] User A의 실서버 요청 생성 (DRAFT)');
  const initialReq = await serverApi(
    '/v1/requests',
    {
      method: 'POST',
      body: JSON.stringify({
        teamId,
        recipientUserId: userB.id,
        title: '로그인 API 500 오류 해결 요청',
        originalInstruction:
          '로그인 API 500 오류를 분석한 문서를 첨부합니다. server.log와 Kubernetes deployment 설정을 확인하고 오타를 수정해주세요.',
        documentVersionIds: [],
        artifactIds: []
      })
    },
    tokenA
  );
  const reqId = initialReq.id;
  console.log(`  ✓ Created Request ID: ${reqId} (State: ${initialReq.state})`);

  // 문서 생성 및 첨부
  console.log('[Step 3.1] 문서 생성 및 요청 연결');
  const doc = await serverApi(
    `/v1/requests/${reqId}/documents`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'api-error-analysis.md',
        content: `## 로그인 API 500 오류 원인 분석\n- 현상: 간헐적 500 에러\n- 원인 추정: redis-servcie 호스트 오타\n- 조치 요청: deployment.yaml 수정 및 검증`,
        changeNote: '초안 작성'
      })
    },
    tokenA
  );
  console.log(`  ✓ Attached Document Version ID: ${doc.currentVersionId}`);

  // 파일 첨부 업로드: POST /v1/uploads -> PUT /v1/storage/local/...
  console.log('[Step 3.2] server.log 파일 업로드 (발급 -> PUT -> 연결)');
  const logContent = Buffer.from(
    `[2026-09-04 12:00:01] ERROR RedisConnectionException: redis-servcie: Name or service not known\n    at RedisClient.connect (/app/node_modules/redis/client.js:42:11)\n    at AuthController.login (/app/src/auth/auth.controller.ts:58:19)`
  );
  const logSha256 = crypto.createHash('sha256').update(logContent).digest('hex');
  const uploadInfo = await serverApi(
    '/v1/uploads',
    {
      method: 'POST',
      body: JSON.stringify({
        teamId,
        requestId: reqId,
        kind: 'REQUEST_ATTACHMENT',
        filename: 'server.log',
        mimeType: 'text/plain',
        sha256: logSha256,
        sizeBytes: logContent.byteLength
      })
    },
    tokenA
  );
  console.log(`  ✓ Upload issued: artifactId=${uploadInfo.artifact.id}`);

  // PUT binary
  const putRes = await fetch(`${API_BASE}${uploadInfo.uploadUrl}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': logContent.byteLength.toString()
    },
    body: logContent
  });
  if (!putRes.ok) throw new Error(`Upload PUT failed: ${putRes.status}`);
  console.log('  ✓ Upload PUT completed successfully');

  // Draft 업데이트로 문서와 첨부파일 링크
  await serverApi(
    `/v1/requests/${reqId}/draft`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        documentVersionIds: [doc.currentVersionId],
        artifactIds: [uploadInfo.artifact.id]
      })
    },
    tokenA
  );

  // 전송: POST /v1/requests/:id/send
  console.log('[Step 3.3] 요청 전송 (DRAFT -> SENT)');
  const sentReq = await serverApi(`/v1/requests/${reqId}/send`, { method: 'POST' }, tokenA);
  console.log(`  ✓ Request State: ${sentReq.state}`);

  // 4. User B의 검토 시작
  console.log('\n[Step 4] User B의 요청 열람 및 검토 시작 (SENT -> REVIEWING)');
  await serverApi(`/v1/requests/${reqId}/review/start`, { method: 'POST' }, tokenB);
  console.log('\n[화면 4] ④ User B의 검토 화면 (/requests/' + reqId + ')');
  capture(`/requests/${reqId}?as=b`, 'real-04-request-detail-review.png');

  // 5. User B의 반려
  console.log('\n[Step 5] User B의 요청 반려 (REVIEWING -> RETURNED)');
  await serverApi(
    `/v1/requests/${reqId}/return`,
    {
      method: 'POST',
      body: JSON.stringify({
        reason: '실제 오류 발생 시점의 로그 파일(server.log) 상세 내역 보완이 필요합니다.'
      })
    },
    tokenB
  );

  // 스크린샷 5: User A가 반려 사유를 확인하고 보완하는 화면
  console.log('\n[화면 5] ⑤ User A의 반려 확인 및 보완 재전송 폼 (/requests/' + reqId + ')');
  capture(`/requests/${reqId}?as=a`, 'real-05-request-returned-resend.png');

  // 6. User A의 Revision 2 생성 및 재전송
  console.log('\n[Step 6] User A의 Revision 2 생성 및 재전송 (RETURNED -> SENT)');
  await serverApi(
    `/v1/requests/${reqId}/revisions`,
    {
      method: 'POST',
      body: JSON.stringify({
        originalInstruction:
          '반려 사유에 따라 상세 server.log 원본을 보강하고 재전송합니다. k8s deployment 설정을 확인해주세요.',
        documentVersionIds: [doc.currentVersionId],
        artifactIds: [uploadInfo.artifact.id]
      })
    },
    tokenA
  );
  await serverApi(`/v1/requests/${reqId}/resend`, { method: 'POST' }, tokenA);
  console.log('  ✓ Resent successfully with Revision 2');

  // 7. User B의 수락 및 실행 준비
  console.log('\n[Step 7] User B의 요청 수락 (SENT -> ACCEPTED)');
  // B가 다시 검토 시작 후 수락
  await serverApi(`/v1/requests/${reqId}/review/start`, { method: 'POST' }, tokenB);
  await serverApi(`/v1/requests/${reqId}/accept`, { method: 'POST' }, tokenB);

  console.log('\n[화면 6] ⑥ User B의 에이전트 실행 준비 화면 (/requests/' + reqId + ')');
  capture(`/requests/${reqId}?as=b`, 'real-06-execution-prepare.png');

  // 8. User B가 에이전트 실행 생성 (ACCEPTED -> READY_TO_RUN)
  console.log('\n[Step 8] User B의 에이전트 실행 시작 (ACCEPTED -> READY_TO_RUN)');
  try {
    execSync(
      'docker compose exec -T mysql mysql -uroot -proot baton -e "UPDATE Execution SET status=\'SUCCEEDED\' WHERE status IN (\'QUEUED\', \'RUNNING\');" 2>/dev/null'
    );
  } catch {}

  const execution = await serverApi(
    `/v1/requests/${reqId}/executions`,
    {
      method: 'POST',
      body: JSON.stringify({
        agentId,
        projectId,
        additionalInstruction: '운영 환경은 변경하지 마. Kubernetes 설정만 확인하고 수정안 작성해줘'
      })
    },
    tokenB
  );
  const execId = execution.id;
  console.log(`  ✓ Created Execution ID: ${execId} (Status: ${execution.status})`);

  // 9. Desktop Agent API 대행 (상태를 RUNNING으로 변경)
  console.log('\n[Step 9] Desktop Agent 대행: 상태 보고 (READY_TO_RUN -> RUNNING)');
  await serverApi(
    `/v1/desktop/executions/${execId}/status`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'RUNNING',
        phase: 'starting',
        message: 'Claude Code 에이전트 작업 시작 및 워크스페이스 분석'
      })
    },
    deviceToken
  );

  console.log('\n[화면 7] ⑦ Claude Code 실행 진행 중 화면 (RUNNING)');
  capture(`/requests/${reqId}?as=b`, 'real-07-execution-running.png');

  // 10. Desktop Agent API 대행 (진행 보고 후 결과 전송 -> RESULT_REVIEW)
  console.log('\n[Step 10] Desktop Agent 대행: 결과 전송 (RUNNING -> RESULT_REVIEW)');
  await serverApi(
    `/v1/desktop/executions/${execId}/status`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'PROGRESS',
        phase: 'editing',
        message: 'Kubernetes deployment.yaml 내 REDIS_HOST 수정 중'
      })
    },
    deviceToken
  );

  const result = await serverApi(
    `/v1/desktop/executions/${execId}/result`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'SUCCEEDED',
        summary:
          'Kubernetes deployment.yaml 내 REDIS_HOST 오타(redis-servcie -> redis-service) 수정 완료 및 verify.sh 테스트 통과',
        changedFiles: ['k8s/deployment.yaml'],
        testSummary: 'verify.sh 3 passed, 0 failed'
      })
    },
    deviceToken
  );
  const resultId = result.id;
  console.log(`  ✓ Result submitted: ${resultId}`);

  console.log('\n[화면 8] ⑧ User B의 결과 검토 화면 (RESULT_REVIEW)');
  capture(`/requests/${reqId}?as=b`, 'real-08-result-review.png');

  // 11. User B의 결과 승인 및 완료 전달
  console.log('\n[Step 11] User B의 결과 승인 (RESULT_REVIEW -> COMPLETED)');
  await serverApi(`/v1/results/${resultId}/approve-and-send`, { method: 'POST' }, tokenB);
  console.log('  ✓ Result approved and sent to User A');

  console.log('\n[화면 9] ⑨ User A의 최종 완료 확인 화면 (COMPLETED)');
  capture(`/requests/${reqId}?as=a`, 'real-09-request-completed.png');

  console.log('\n====================================================');
  console.log('  모든 Real 모드 E2E 시나리오 및 9개 스크린샷 완료!  ');
  console.log('====================================================\n');
}

runRealVerification().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
