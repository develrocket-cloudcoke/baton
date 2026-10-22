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

function capture(urlPath, filename, width = 1280, height = 900, delayMs = 2000) {
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

async function run() {
  console.log('===========================================================');
  console.log('  Baton Web (CLO-14) 모달 교체 검증 & 스크린샷 캡처  ');
  console.log('===========================================================\n');

  // 1. 디바이스 연결 해제 확인 모달
  console.log('[1/4] 디바이스 연결 해제 확인 모달');
  capture('/me/devices?as=b&modal=disconnect', 'clo14-01-device-disconnect-modal.png');

  // 2. 관리자 팀 삭제 확인 모달
  console.log('[2/4] 관리자 팀 삭제 확인 모달');
  capture('/admin/teams?as=admin&modal=deleteTeam', 'clo14-02-team-delete-modal.png');

  // 3. Mock 데이터 초기화 확인 모달
  console.log('[3/4] Mock 데이터 초기화 확인 모달');
  capture('/requests?as=b&modal=resetMock', 'clo14-03-reset-mock-modal.png');

  // 4. 문서 뷰어 안내 모달
  console.log('[4/4] 문서 뷰어 안내 모달');
  capture('/requests/req_sample_review_03?as=b&modal=docAlert', 'clo14-04-doc-alert-modal.png');

  console.log('\n모든 CLO-14 스크린샷 캡처 완료.');
}

run();
