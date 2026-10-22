import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 3006;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, width = 1280, height = 1100, delayMs = 1500) {
  const fullUrl = `${BASE_URL}${urlPath}`;
  const outPath = path.join(SCREENSHOTS_DIR, filename);
  console.log(`[Capture] ${fullUrl} -> ${filename} (${width}x${height})`);
  try {
    if (delayMs > 0) {
      execSync(`sleep ${delayMs / 1000}`);
    }
    const cmd = `"${CHROME_PATH}" --headless --disable-gpu --window-size=${width},${height} --screenshot="${outPath}" "${fullUrl}" 2>/dev/null`;
    execSync(cmd);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  } catch (err) {
    console.error(`  ✗ Error capturing ${filename}:`, err.message);
  }
}

async function api(pathStr, options = {}, retries = 5) {
  const url = `${BASE_URL}/api/mock${pathStr}`;
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
      console.log(`    [Retry ${attempt}/${retries}] Retrying ${pathStr}...`);
      execSync('sleep 0.5');
    }
  }
}

async function run() {
  console.log('===========================================================');
  console.log('  Baton Web (CLO-8c) 결과 검토 추가 작업 요청 검증 & 스크린샷  ');
  console.log('===========================================================\n');

  const reqId = 'req_sample_review_03';

  // 0. Mock 데이터 리셋
  console.log('[Step 0] Mock 데이터 초기화');
  await api('/v1/reset', { method: 'POST' });

  // 1. followup-01-result-review-1st.png
  // 1차 결과 검토 화면: 'Agent에게 추가 작업 요청' 버튼 활성화 상태 및 1차 결과 확인
  console.log('\n[화면 1] ① 1차 결과 검토 화면 (추가 작업 요청 버튼 활성화)');
  capture(`/requests/${reqId}?as=b`, 'followup-01-result-review-1st.png', 1280, 1100);

  // 2. followup-02-modal-input.png
  // 추가 지시 입력 모달 (window.confirm 금지, 모달 입력 폼)
  console.log('\n[화면 2] ② 추가 지시 입력 모달 폼');
  capture(`/requests/${reqId}?as=b&modal=followup`, 'followup-02-modal-input.png', 1280, 1100, 2500);

  // 3. 추가 작업 요청 전송 (POST /v1/requests/:id/executions with followUpInstruction)
  console.log('\n[Step 3] 추가 작업 요청 API 전송 (followUpInstruction 실어 전송)');
  const exec2 = await api(`/v1/requests/${reqId}/executions`, {
    method: 'POST',
    body: JSON.stringify({
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      followUpInstruction: 'verify.sh 외에 curl 기반 엔드포인트 헬스체크 및 로그인 API 테스트 케이스도 추가해줘.',
      policy: {
        repository_edit: 'allow',
        deployment_apply: 'deny',
        network_outbound: 'deny',
        outside_write: 'deny',
        shell_execution: 'allow'
      }
    })
  });
  console.log(`  ✓ 2차 Execution 생성 완료: ${exec2.id} (status: ${exec2.status})`);

  // 4. followup-03-execution-progress.png
  // 추가 실행 진행 화면으로 전환된 상태
  console.log('\n[화면 3] ③ 추가 실행 진행 화면 전환');
  capture(`/requests/${reqId}?as=b`, 'followup-03-execution-progress.png', 1280, 1100, 2000);

  // 5. 2차 실행 단계 시뮬레이션 완료
  console.log('\n[Step 5] 2차 에이전트 실행 단계 시뮬레이션 (completed 까지)');
  let done = false;
  let round2Result = null;
  while (!done) {
    const step = await api(`/v1/executions/${exec2.id}/simulate-step`, {
      method: 'POST',
      body: JSON.stringify({ forceFail: false })
    });
    if (step.isDone) {
      done = true;
      round2Result = step.result;
    }
  }
  console.log(`  ✓ 2차 실행 완료 및 2차 Result 생성: ${round2Result?.id}`);

  // 6. followup-04-result-review-2nd.png
  // 2차 결과 검토 화면 (회차 탭, 2차 추가 지시사항 표시, 2차 변경 diff)
  console.log('\n[화면 4] ④ 2차 결과 검토 화면 (회차 이력 탭, 추가 지시 표시, 2차 diff)');
  capture(`/requests/${reqId}?as=b`, 'followup-04-result-review-2nd.png', 1280, 1300, 2000);

  // 7. followup-05-timeline-followup.png
  // 감사 타임라인에 '에이전트에게 추가 작업 요청' 이벤트 및 추가 지시 표시
  console.log('\n[화면 5] ⑤ 타임라인에 추가 작업 요청 이벤트 표시');
  capture(`/requests/${reqId}?as=b&tab=timeline`, 'followup-05-timeline-followup.png', 1280, 4200, 2500);

  // 8. B의 최종 결과 승인
  console.log('\n[Step 8] B의 최종 결과 승인 및 전달 (approve-and-send)');
  if (round2Result) {
    await api(`/v1/results/${round2Result.id}/approve-and-send`, {
      method: 'POST',
      body: JSON.stringify({ reviewedByUserId: 'user_b_id' })
    });
  }

  // 9. followup-06-completed-approved.png
  // COMPLETED 상태 화면: 회차별 이력 유지, 추가 작업 요청 버튼 숨김
  console.log('\n[화면 6] ⑥ 최종 완료 화면 (COMPLETED, 회차 이력 유지, 추가 작업 버튼 숨김)');
  capture(`/requests/${reqId}?as=a`, 'followup-06-completed-approved.png', 1280, 1250);

  console.log('\n===========================================================');
  console.log('  6개 화면 스크린샷 캡처 및 검증 완료!  ');
  console.log('===========================================================');
}

run().catch((err) => {
  console.error('검증 중 오류 발생:', err);
  process.exit(1);
});
