import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 3004;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, delayMs = 1500) {
  const fullUrl = `${BASE_URL}${urlPath}`;
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
  console.log('  CLO-18 & CLO-19 기능 검증 및 스크린샷 캡처        ');
  console.log('====================================================\n');

  // 0. 초기화
  console.log('[Step 0] Mock 데이터 초기화');
  await api('/v1/reset', { method: 'POST' });

  // 1. CLO-18 단방향 팀 링크 검증
  console.log('\n[Step 1] CLO-18: 관리자 팀 링크 방향 선택 메뉴 모달');
  capture(
    '/admin/team-links?modal=direction&as=admin',
    'clo18-01-matrix-direction-menu.png',
    1500
  );

  console.log('\n[Step 2] CLO-18: backend -> infra 단방향 링크 설정 및 매트릭스 캡처');
  await api('/v1/org/team-links', {
    method: 'POST',
    body: JSON.stringify({
      teamAId: 'team_backend_id',
      teamBId: 'team_infra_id',
      direction: 'a-to-b'
    })
  });
  capture(
    '/admin/team-links?as=admin',
    'clo18-02-unidirectional-link.png',
    1500
  );

  // 2. CLO-19 반려 후 팀 재뿌리기 검증
  console.log('\n[Step 3] CLO-19: 팀 뿌리기 요청 선점(Claim) 후 반려(Return) 처리');
  const broadcastReqId = 'req_team_broadcast_01';

  // B가 선점
  await api(`/v1/requests/${broadcastReqId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ userId: 'user_b_id' })
  });

  // B가 반려
  await api(`/v1/requests/${broadcastReqId}/return`, {
    method: 'POST',
    body: JSON.stringify({
      recipientUserId: 'user_b_id',
      reason: 'Redis 클러스터 토폴로지 구성 덤프 파일 추가 첨부 및 노드별 메모리 사용량 보완이 필요합니다.'
    })
  });

  console.log('\n[Step 4] CLO-19: A의 반려 확인 및 재전송 폼 (재뿌리기 옵션 노출)');
  capture(
    `/requests/${broadcastReqId}?as=a&reassign=team`,
    'clo19-01-resend-options.png',
    1500
  );

  console.log('\n[Step 5] CLO-19: 팀 전체에 다시 뿌리기 (reassign: team) 실행');
  await api(`/v1/requests/${broadcastReqId}/resend`, {
    method: 'POST',
    body: JSON.stringify({
      senderUserId: 'user_a_id',
      originalInstruction: 'Redis 토폴로지 덤프 및 노드별 상세 지표 보완본 전달',
      reassign: 'team'
    })
  });

  console.log('\n[Step 6] CLO-19: 팀 재뿌리기 후 상세 화면 (미확정 배지 및 선점 배너)');
  capture(
    `/requests/${broadcastReqId}?as=b`,
    'clo19-02-reassigned-unclaimed.png',
    1500
  );

  console.log('\n====================================================');
  console.log('  검증 및 스크린샷 캡처 완료!                      ');
  console.log('====================================================');
}

runVerification().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
