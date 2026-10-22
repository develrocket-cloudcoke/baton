import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 3005;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, width = 1280, height = 1000, delayMs = 1500) {
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
  console.log('  Baton Web (W6b) 5개 화면 다듬기 검증 & 스크린샷 캡처  ');
  console.log('===========================================================\n');

  // 0. 초기화
  console.log('[Step 0] Mock 데이터 초기화');
  await api('/v1/reset', { method: 'POST' });

  // 1. polish-01-devices.png
  // /me/devices 화면: 플랫폼, OS, 앱 버전, 마지막 접속 시각 표시, OFFLINE 배지, 접속 기록 없음
  console.log('\n[화면 1] ① 내 디바이스 관리 (/me/devices?as=b)');
  capture('/me/devices?as=b', 'polish-01-devices.png', 1280, 960);

  const reqId = 'req_sample_redis_01';

  // 4. polish-04-document-version-diff.png
  // 문서 뷰어 버전 비교 (v1 ↔ v2 좌우 비교)
  console.log('\n[화면 4] ④ 문서 버전 비교 (v1 ↔ v2 Side-by-Side Diff)');
  capture(`/requests/${reqId}?as=a&docMode=diff&docDiffFormat=side-by-side`, 'polish-04-document-version-diff.png', 1280, 960);

  // 2. polish-05-execution-cancel.png
  // 실행 준비 및 실행 시작 -> 실행 진행 화면에서 '실행 취소' 버튼 표시 확인
  console.log('\n[화면 5] ⑤ 로컬 에이전트 실행 진행 화면 (실행 취소 버튼)');
  await api(`/v1/requests/${reqId}/review/start`, {
    method: 'POST',
    body: JSON.stringify({ recipientUserId: 'user_b_id' })
  });
  await api(`/v1/requests/${reqId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ recipientUserId: 'user_b_id' })
  });
  const exec = await api(`/v1/requests/${reqId}/executions`, {
    method: 'POST',
    body: JSON.stringify({
      executorUserId: 'user_b_id',
      agentId: 'agent_b_id',
      projectId: 'proj_backend_id',
      additionalInstruction: 'Kubernetes 설정 확인 및 오타 수정',
      policy: { repository_edit: 'allow', deployment_apply: 'deny' }
    })
  });
  capture(`/requests/${reqId}?as=b`, 'polish-05-execution-cancel.png', 1280, 1000);

  // 3. 실행 시뮬레이션 완료 및 결과 승인
  console.log('\n[Step 3] 에이전트 실행 단계 시뮬레이션 및 결과 승인 (COMPLETED)');
  let done = false;
  let lastResult = null;
  while (!done) {
    const step = await api(`/v1/executions/${exec.id}/simulate-step`, {
      method: 'POST',
      body: JSON.stringify({ forceFail: false })
    });
    if (step.isDone) {
      done = true;
      lastResult = step.result;
    }
  }

  // B가 결과 승인 및 A에게 전달
  if (lastResult) {
    await api(`/v1/results/${lastResult.id}/approve-and-send`, {
      method: 'POST',
      body: JSON.stringify({ reviewedByUserId: 'user_b_id' })
    });
  }

  // 4. polish-02-request-detail-status.png
  // 완료된 요청 상세: A가 볼 때 '처리 중' 문구 없이 '완료됨 · 처리자: 박인프라' 확정 안내 바 확인
  console.log('\n[화면 2] ② 완료된 요청 상세 상태 문구 (/requests/' + reqId + '?as=a)');
  capture(`/requests/${reqId}?as=a`, 'polish-02-request-detail-status.png', 1280, 960);

  // 5. polish-03-diff-viewer-files.png
  // 결과 화면의 파일별 Unified Diff 뷰어: 파일 헤더, 추가/삭제 수, 접기/펼치기
  console.log('\n[화면 3] ③ 결과 화면 파일별 분리 Diff 뷰어');
  capture(`/requests/${reqId}?as=a`, 'polish-03-diff-viewer-files.png', 1280, 1280);

  console.log('\n===========================================================');
  console.log('  5개 화면 스크린샷 캡처 완료!  ');
  console.log('===========================================================');
}

run().catch((err) => {
  console.error('검증 중 오류 발생:', err);
  process.exit(1);
});
