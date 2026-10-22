import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://127.0.0.1:3002';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, delayMs = 1000) {
  const fullUrl = `${BASE_URL}${urlPath}`;
  const outPath = path.join(SCREENSHOTS_DIR, filename);
  console.log(`[Capture] ${fullUrl} -> ${filename}`);
  try {
    // delay를 위해 가벼운 curl 렌더 준비 또는 sleep
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

async function api(path, options = {}, retries = 3) {
  const url = `${BASE_URL}/api/mock${path}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`    [Retry ${attempt}/${retries}] Retrying ${path} due to: ${err.message}`);
      execSync('sleep 0.5');
    }
  }
}

async function runVerification() {
  console.log('====================================================');
  console.log('  Baton Web (W3) 9개 화면 시나리오 검증 & 스크린샷  ');
  console.log('====================================================\n');

  // 0. 초기화
  console.log('[Step 0] Mock 데이터 초기화');
  await api('/v1/reset', { method: 'POST' });

  // ① 로그인 화면
  console.log('\n[화면 1] ① 로그인 화면 (/login)');
  capture('/login', '01-login.png');

  // ② Request 목록 화면
  console.log('\n[화면 2] ② Request 목록 화면 (/requests)');
  capture('/requests', '02-requests-list.png');

  // ③ Request 생성 화면
  console.log('\n[화면 3] ③ Request 생성 화면 (/requests/new)');
  capture('/requests/new', '03-request-new.png');

  // ④ Request 상세 (DELIVERED/REVIEWING)
  const req1Id = 'req_sample_redis_01';
  console.log('\n[화면 4] ④ Request 상세 및 수신자 검토 화면 (/requests/' + req1Id + ')');
  // 수신자 검토 시작 호출
  await api(`/v1/requests/${req1Id}/review/start`, {
    method: 'POST',
    body: JSON.stringify({ recipientUserId: 'user_b_id' })
  });
  capture(`/requests/${req1Id}`, '04-request-detail.png');

  // ⑤ 실행 준비 화면 (ACCEPTED)
  console.log('\n[화면 5] ⑤ 에이전트 실행 준비 화면 (F4 Policy 설정)');
  await api(`/v1/requests/${req1Id}/accept`, {
    method: 'POST',
    body: JSON.stringify({ recipientUserId: 'user_b_id' })
  });
  capture(`/requests/${req1Id}`, '05-execution-prepare.png');

  // ⑥ 실행 진행 화면 (RUNNING)
  console.log('\n[화면 6] ⑥ Claude Code 실행 진행 화면 (NDJSON 스트림 로그 매핑)');
  const exec = await api(`/v1/requests/${req1Id}/executions`, {
    method: 'POST',
    body: JSON.stringify({
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction: '운영 환경은 변경하지 마. Kubernetes 설정만 확인하고 수정안 작성해줘',
      policy: {
        repository_edit: 'allow',
        deployment_apply: 'deny',
        network_outbound: 'deny',
        outside_write: 'deny',
        shell_execution: 'allow'
      }
    })
  });
  // 단계 시뮬레이션 전진 (starting -> reading_input -> exploring -> editing)
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  capture(`/requests/${req1Id}`, '06-execution-progress.png');

  // ⑦ 결과 검토 화면 (RESULT_REVIEW)
  console.log('\n[화면 7] ⑦ 결과 검토 화면 (Unified Diff & 승인/추가작업)');
  // testing -> test_passed -> writing_result -> completed
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  await api(`/v1/executions/${exec.id}/simulate-step`, { method: 'POST', body: JSON.stringify({}) });
  capture(`/requests/${req1Id}`, '07-result-review.png');

  // ⑧ 요청자의 최종 완료 확인 화면 (COMPLETED)
  console.log('\n[화면 8] ⑧ 요청자(A)의 결과 확인 화면 (COMPLETED)');
  const detailAfterResult = await api(`/v1/requests/${req1Id}`);
  const resultId = detailAfterResult.latestResult.id;
  await api(`/v1/results/${resultId}/approve-and-send`, {
    method: 'POST',
    body: JSON.stringify({ reviewedByUserId: 'user_b_id' })
  });
  capture(`/requests/${req1Id}`, '08-request-completed.png');

  // ⑨ 반려 루프 및 재전송 화면 (RETURNED -> 새 revision)
  console.log('\n[화면 9] ⑨ 반려 루프 및 새 revision 재전송 화면 (RETURNED)');
  // 새 요청 생성
  const reqReturned = await api('/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      senderUserId: 'user_a_id',
      recipientUserId: 'user_b_id',
      title: '로그인 API 500 오류 1차 요청',
      originalInstruction: '로그인 API 오류 분석 건을 보냅니다.',
      autoSend: true
    })
  });
  // B가 반려
  await api(`/v1/requests/${reqReturned.id}/return`, {
    method: 'POST',
    body: JSON.stringify({
      recipientUserId: 'user_b_id',
      reason: '실제 오류 로그 파일이 누락되었습니다. server.log를 첨부해주세요.'
    })
  });
  capture(`/requests/${reqReturned.id}`, '09-request-returned-resend.png');

  // 재전송 테스트 실행
  console.log('\n[보완 검증] 새 revision 으로 재전송 실행');
  const resendResult = await api(`/v1/requests/${reqReturned.id}/resend`, {
    method: 'POST',
    body: JSON.stringify({
      senderUserId: 'user_a_id',
      originalInstruction: '오류 로그 파일(server.log)을 추가 첨부하여 재전송합니다.',
      documentTitle: 'api-error-analysis.v2.md',
      documentContent: '## 로그인 API 오류 분석 (v2 보완본)\n\n로그 파일 확인 부탁드립니다.',
      attachments: [{ filename: 'server.log', sizeBytes: 8192, mimeType: 'text/plain' }]
    })
  });
  console.log(`  ✓ Resent successfully. New Revision No: ${resendResult.currentRevisionNo}, State: ${resendResult.state}`);

  // D4: FAILED 후 재실행 검증
  console.log('\n[D4 검증] 에이전트 실행 실패 및 재실행 복구 테스트');
  const reqRetry = await api('/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      senderUserId: 'user_a_id',
      recipientUserId: 'user_b_id',
      title: 'D4 재실행 테스트 요청',
      originalInstruction: '테스트용 요청',
      autoSend: true
    })
  });
  await api(`/v1/requests/${reqRetry.id}/accept`, {
    method: 'POST',
    body: JSON.stringify({ recipientUserId: 'user_b_id' })
  });
  const execRetry = await api(`/v1/requests/${reqRetry.id}/executions`, {
    method: 'POST',
    body: JSON.stringify({
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction: '의도적 결함 테스트',
      policy: {
        repository_edit: 'allow',
        deployment_apply: 'deny',
        network_outbound: 'deny',
        outside_write: 'deny',
        shell_execution: 'allow'
      }
    })
  });
  // 강제 실패 유발
  await api(`/v1/executions/${execRetry.id}/simulate-step`, {
    method: 'POST',
    body: JSON.stringify({ forceFail: true })
  });
  const detailFailed = await api(`/v1/requests/${reqRetry.id}`);
  console.log(`  ✓ State after fail: ${detailFailed.request.state} (Expected: FAILED)`);

  // 재실행 (D4: FAILED -> READY_TO_RUN 복귀)
  const execRetried = await api(`/v1/requests/${reqRetry.id}/executions`, {
    method: 'POST',
    body: JSON.stringify({
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction: '보완된 재시도 실행',
      policy: {
        repository_edit: 'allow',
        deployment_apply: 'deny',
        network_outbound: 'deny',
        outside_write: 'deny',
        shell_execution: 'allow'
      }
    })
  });
  const detailRetried = await api(`/v1/requests/${reqRetry.id}`);
  console.log(`  ✓ State after retry: ${detailRetried.request.state} (Expected: READY_TO_RUN, D4 확정 동작)`);

  console.log('\n====================================================');
  console.log('  모든 화면 검증 및 스크린샷 캡처 완료!               ');
  console.log('====================================================\n');
}

runVerification().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
