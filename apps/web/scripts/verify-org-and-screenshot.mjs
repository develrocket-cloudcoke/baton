import { execSync, spawn } from 'child_process';
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
    const cmd = `"${CHROME_PATH}" --headless --disable-gpu --virtual-time-budget=2000 --window-size=1280,960 --screenshot="${outPath}" "${fullUrl}" 2>/dev/null`;
    execSync(cmd);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  } catch (err) {
    console.error(`  ✗ Error capturing ${filename}:`, err.message);
  }
}

async function checkServer(url) {
  try {
    const res = await fetch(url);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  console.log('====================================================');
  console.log('  Baton Web (W5c) 조직·팀 9종 스크린샷 캡처 검증  ');
  console.log('====================================================\n');

  // Next.js 서버 확인
  let serverProcess = null;
  const isUp = await checkServer(`${BASE_URL}/requests`);
  if (!isUp) {
    console.log(`[Server] Starting Next.js server on port ${PORT}...`);
    serverProcess = spawn('pnpm', ['--filter', '@baton/web', 'start', '-p', String(PORT)], {
      stdio: 'ignore',
      detached: true
    });

    // 서버 준비 대기 (최대 15초)
    for (let i = 0; i < 30; i++) {
      execSync('sleep 0.5');
      if (await checkServer(`${BASE_URL}/requests`)) {
        console.log(`[Server] Next.js is ready at ${BASE_URL}\n`);
        break;
      }
    }
  } else {
    console.log(`[Server] Next.js is already running at ${BASE_URL}\n`);
  }

  try {
    // 1. 관리자: 팀 관리 (/admin/teams)
    console.log('[1/9] 관리자 팀 관리 화면');
    capture('/admin/teams?as=admin', 'org-admin-teams.png');

    // 2. 관리자: 팀 링크 매트릭스 (/admin/team-links)
    console.log('[2/9] 관리자 팀 링크 매트릭스 화면');
    capture('/admin/team-links?as=admin', 'org-admin-team-links.png');

    // 3. 관리자: 팀 링크 해제 확인 모달 (/admin/team-links?modal=confirm)
    console.log('[3/9] 관리자 팀 링크 해제 확인 모달');
    capture('/admin/team-links?as=admin&modal=confirm', 'org-admin-team-links-confirm.png');

    // 4. 관리자: 사용자 관리 및 계정 생성 (/admin/users)
    console.log('[4/9] 관리자 사용자 관리 화면');
    capture('/admin/users?as=admin', 'org-admin-users.png');

    // 5. 내 디바이스 목록 (/me/devices)
    console.log('[5/9] 사용자 디바이스 목록 화면');
    capture('/me/devices?as=b', 'org-user-devices.png');

    // 6. 디바이스 페어링 코드 모달 (/me/devices?modal=pairing)
    console.log('[6/9] 페어링 코드 모달 (8자리 코드 및 10분 타이머)');
    capture('/me/devices?as=b&modal=pairing', 'org-user-device-pairing.png');

    // 7. 새 요청: 사람 탭 (/requests/new?tab=user)
    console.log('[7/9] 새 요청 작성 - 사람 선택 (팀별 그룹화 & 온라인 뱃지)');
    capture('/requests/new?as=a&tab=user', 'org-request-new-user.png');

    // 8. 새 요청: 팀 전체 뿌리기 탭 (/requests/new?tab=team)
    console.log('[8/9] 새 요청 작성 - 팀 전체 뿌리기 선택');
    capture('/requests/new?as=a&tab=team', 'org-request-new-team.png');

    // 9. 요청 목록: 팀 뿌리기 배지 미확정 표시 (/requests)
    console.log('[9/9] 요청 목록 - 팀 뿌리기 배지 및 미확정 표시');
    capture('/requests?as=b', 'org-request-inbox-broadcast.png');

    console.log('\n====================================================');
    console.log('  9종 스크린샷 캡처 완료 검증 결과:');
    const files = [
      'org-admin-teams.png',
      'org-admin-team-links.png',
      'org-admin-team-links-confirm.png',
      'org-admin-users.png',
      'org-user-devices.png',
      'org-user-device-pairing.png',
      'org-request-new-user.png',
      'org-request-new-team.png',
      'org-request-inbox-broadcast.png'
    ];

    let allOk = true;
    for (const f of files) {
      const p = path.join(SCREENSHOTS_DIR, f);
      if (fs.existsSync(p)) {
        const sz = fs.statSync(p).size;
        console.log(`  ✓ ${f} (${sz} bytes)`);
      } else {
        console.error(`  ✗ Missing: ${f}`);
        allOk = false;
      }
    }

    if (allOk) {
      console.log('\n[SUCCESS] 모든 9종 스크린샷이 성공적으로 생성되었습니다.');
    } else {
      process.exit(1);
    }
  } finally {
    if (serverProcess) {
      try {
        process.kill(-serverProcess.pid);
      } catch {
        try {
          serverProcess.kill();
        } catch {
          // ignore
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
