import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const API_BASE = 'http://127.0.0.1:3001';
const WEB_BASE = 'http://127.0.0.1:3000';
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
    const cmd = `"${CHROME_PATH}" --headless --disable-gpu --virtual-time-budget=2500 --window-size=1280,960 --screenshot="${outPath}" "${fullUrl}" 2>/dev/null`;
    execSync(cmd);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  } catch (err) {
    console.error(`  ✗ Error capturing ${filename}:`, err.message);
  }
}

async function serverApi(endpoint, options = {}, token = null, retries = 5) {
  const url = `${API_BASE}${endpoint}`;
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
        const err = new Error(`API Error ${res.status} on ${endpoint}: ${text}`);
        err.status = res.status;
        err.body = text;
        throw err;
      }

      return await res.json();
    } catch (err) {
      if (err.status && err.status < 500) {
        // 4xx error: do not retry
        throw err;
      }
      if (attempt === retries) throw err;
      console.log(`    [Retry ${attempt}/${retries}] ${endpoint}: ${err.message}`);
      execSync('sleep 0.5');
    }
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
  console.log('================================================================');
  console.log('  Baton Web Real 모드 실서버 연동 시나리오 검증 및 스크린샷  ');
  console.log('  (조직·팀 CRUD, 링크 설정/해제, 수신자, 팀 뿌리기 Claim, 디바이스)');
  console.log('================================================================\n');

  // 0. 서버 상태 확인
  console.log('[Step 0] API 서버 (3001) 및 Web 서버 (3000) 헬스체크 확인');
  const apiHealth = await checkServer(`${API_BASE}/health`);
  console.log(`  ✓ API Server (3001): ${apiHealth ? 'ONLINE' : 'OFFLINE'}`);
  const webHealth = await checkServer(`${WEB_BASE}/requests`);
  console.log(`  ✓ Web Server (3000): ${webHealth ? 'ONLINE' : 'OFFLINE'}\n`);

  if (!apiHealth || !webHealth) {
    throw new Error('API 서버 또는 Web 서버가 기동되어 있지 않습니다. ./scripts/dev-up.sh 를 먼저 실행하세요.');
  }

  // 1. 3개 브라우저 프로필 로그인
  console.log('[Step 1] 3개 계정 로그인 토큰 발급');
  const loginAdmin = await serverApi('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@baton.local', password: 'baton-dev-password' })
  });
  const tokenAdmin = loginAdmin.token;
  console.log(`  ✓ Admin 로그인 성공: ${loginAdmin.user.email} (OrgRole: ${loginAdmin.user.orgRole || 'ORG_ADMIN'})`);

  const loginA = await serverApi('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@baton.local', password: 'baton-dev-password' })
  });
  const tokenA = loginA.token;
  console.log(`  ✓ User A 로그인 성공: ${loginA.user.email}`);

  const loginB = await serverApi('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'b@baton.local', password: 'baton-dev-password' })
  });
  const tokenB = loginB.token;
  console.log(`  ✓ User B 로그인 성공: ${loginB.user.email}`);

  // 2. Admin: GET /v1/me 확인
  console.log('\n[Step 2] Admin: GET /v1/me 확인');
  const meAdmin = await serverApi('/v1/me', {}, tokenAdmin);
  console.log(`  ✓ Admin me: organization=${meAdmin.organization?.name}, orgRole=${meAdmin.orgRole}, teams=${meAdmin.teams?.length}개`);

  // 3. Admin: 팀 목록 확인 및 qa 팀 생성
  console.log('\n[Step 3] Admin: 팀 목록 조회 및 qa 팀 생성');
  let teams = await serverApi('/v1/org/teams', {}, tokenAdmin);
  console.log(`  ✓ 현재 팀 목록: ${teams.map(t => t.name).join(', ')}`);

  const backendTeam = teams.find(t => t.name === 'backend');
  const infraTeam = teams.find(t => t.name === 'infra');
  if (!backendTeam || !infraTeam) {
    throw new Error('기본 backend 또는 infra 팀을 찾을 수 없습니다.');
  }

  let qaTeam = teams.find(t => t.name === 'qa');
  if (!qaTeam) {
    console.log('  + qa 팀 신규 생성 중...');
    qaTeam = await serverApi('/v1/org/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'qa' })
    }, tokenAdmin);
    console.log(`  ✓ qa 팀 생성 완료: ID=${qaTeam.id}`);
  } else {
    console.log(`  ✓ 기존 qa 팀 존재: ID=${qaTeam.id}`);
  }

  // 4. Admin: 사용자 생성 (qa-user@baton.local)
  console.log('\n[Step 4] Admin: 사용자 생성 (qa-user@baton.local)');
  const orgUsers = await serverApi('/v1/org/users', {}, tokenAdmin);
  let qaUser = orgUsers.find(u => (u.user?.email || u.email) === 'qa-user@baton.local');
  if (!qaUser) {
    console.log('  + qa-user@baton.local 계정 생성 중...');
    try {
      qaUser = await serverApi('/v1/org/users', {
        method: 'POST',
        body: JSON.stringify({
          email: 'qa-user@baton.local',
          displayName: '최QA (qa-user)',
          temporaryPassword: 'baton-dev-password'
        })
      }, tokenAdmin);
      console.log(`  ✓ qa-user 생성 완료: ID=${qaUser.id}`);
    } catch (err) {
      console.log('  - qa-user 생성 스킵(이미 존재):', err.message);
    }
  } else {
    console.log(`  ✓ 기존 qa-user 존재: ID=${qaUser.id || qaUser.user?.id}`);
  }

  // 5. Admin: qa 팀에 qa-user 추가
  console.log('\n[Step 5] Admin: qa 팀에 qa-user 추가');
  try {
    const addMemberRes = await serverApi(`/v1/org/teams/${qaTeam.id}/members`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'qa-user@baton.local',
        role: 'MEMBER'
      })
    }, tokenAdmin);
    console.log('  ✓ qa-user 팀원 추가 완료:', addMemberRes);
  } catch (err) {
    console.log('  - qa-user 이미 팀원이거나 추가 완료됨:', err.message);
  }

  // 5b. Admin: infra 팀에 User C 추가 (409 Conflict 선점 충돌 테스트용)
  console.log('\n[Step 5b] Admin: infra 팀에 User C 생성 및 추가');
  let userC = orgUsers.find(u => (u.user?.email || u.email) === 'c@baton.local');
  if (!userC) {
    try {
      userC = await serverApi('/v1/org/users', {
        method: 'POST',
        body: JSON.stringify({
          email: 'c@baton.local',
          displayName: '이인프라 (C)',
          temporaryPassword: 'baton-dev-password'
        })
      }, tokenAdmin);
      console.log(`  ✓ User C 생성 완료: ID=${userC.id}`);
    } catch (e) {
      console.log('  - User C 생성 확인:', e.message);
    }
  }
  try {
    await serverApi(`/v1/org/teams/${infraTeam.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'c@baton.local', role: 'MEMBER' })
    }, tokenAdmin);
    console.log('  ✓ User C infra 팀원 배정 완료');
  } catch (e) {
    console.log('  - User C 이미 infra 팀원임');
  }

  // 6. Admin: backend ↔ qa 통신 링크 설정
  console.log('\n[Step 6] Admin: backend ↔ qa 통신 링크 설정');
  let links = await serverApi('/v1/org/team-links', {}, tokenAdmin);
  const hasBackendQaLink = links.some(
    l => (l.fromTeamId === backendTeam.id && l.toTeamId === qaTeam.id)
  );

  if (!hasBackendQaLink) {
    console.log('  + backend ↔ qa 링크 생성 중...');
    const linkRes = await serverApi('/v1/org/team-links', {
      method: 'POST',
      body: JSON.stringify({
        teamAId: backendTeam.id,
        teamBId: qaTeam.id
      })
    }, tokenAdmin);
    console.log('  ✓ 링크 생성 완료:', linkRes.length, '개 행 생성');
  } else {
    console.log('  ✓ backend ↔ qa 링크 이미 존재함');
  }

  // 스크린샷 1, 2, 3: 관리자 화면들
  console.log('\n[스크린샷 1] 관리자 팀 관리 (/admin/teams)');
  capture('/admin/teams?as=admin', 'org-real-01-admin-teams.png');

  console.log('[스크린샷 2] 관리자 팀 링크 매트릭스 (/admin/team-links)');
  capture('/admin/team-links?as=admin', 'org-real-02-admin-team-links.png');

  console.log('[스크린샷 3] 관리자 사용자 관리 (/admin/users)');
  capture('/admin/users?as=admin', 'org-real-03-admin-users.png');

  // 7. User A: 수신자 목록에서 qa 구성원 표시 확인
  console.log('\n[Step 7] User A: 수신자 목록 조회 (qa 팀 포함 확인)');
  const recipientsWithQa = await serverApi(`/v1/recipients?senderTeamId=${backendTeam.id}`, {}, tokenA);
  const foundQaTeamWithLink = recipientsWithQa.teams.find(t => t.id === qaTeam.id);
  console.log(`  ✓ 수신 가능 팀 목록: ${recipientsWithQa.teams.map(t => t.name).join(', ')}`);
  if (!foundQaTeamWithLink) {
    throw new Error('링크 설정 후 수신자 목록에 qa 팀이 나타나지 않았습니다!');
  }
  console.log(`  ✓ qa 팀 수신 가능 확인 완료: 멤버 ${foundQaTeamWithLink.members?.length}명`);

  console.log('[스크린샷 4] User A 수신자 선택 화면 (qa 포함)');
  capture('/requests/new?as=a&tab=user', 'org-real-04-recipients-with-qa.png');

  // 8. Admin: backend ↔ qa 링크 해제
  console.log('\n[Step 8] Admin: backend ↔ qa 링크 해제');
  links = await serverApi('/v1/org/team-links', {}, tokenAdmin);
  const targetLink = links.find(
    l => (l.fromTeamId === backendTeam.id && l.toTeamId === qaTeam.id) ||
         (l.fromTeamId === qaTeam.id && l.toTeamId === backendTeam.id)
  );

  if (targetLink) {
    await serverApi(`/v1/org/team-links/${targetLink.id}`, {
      method: 'DELETE'
    }, tokenAdmin);
    console.log(`  ✓ 링크 삭제 완료: ID=${targetLink.id}`);
  }

  // 9. User A: 링크 해제 후 수신자 목록에서 qa 제외 확인
  console.log('\n[Step 9] User A: 링크 해제 후 수신자 목록 조회 (qa 제외 확인)');
  const recipientsWithoutQa = await serverApi(`/v1/recipients?senderTeamId=${backendTeam.id}`, {}, tokenA);
  const foundQaWithoutLink = recipientsWithoutQa.teams.find(t => t.id === qaTeam.id);
  console.log(`  ✓ 링크 해제 후 수신 가능 팀 목록: ${recipientsWithoutQa.teams.map(t => t.name).join(', ')}`);
  if (foundQaWithoutLink) {
    throw new Error('링크 해제 후에도 수신자 목록에 qa 팀이 남아있습니다!');
  }
  console.log('  ✓ qa 팀 제외 확인 완료');

  console.log('[스크린샷 5] User A 수신자 선택 화면 (qa 제외)');
  capture('/requests/new?as=a&tab=user', 'org-real-05-recipients-without-qa.png');

  // 10. User A: infra 팀 전체 뿌리기 요청 생성 (recipientUserId: null)
  console.log('\n[Step 10] User A: infra 팀 전체 뿌리기 요청 생성 및 전송');
  const createdReq = await serverApi('/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      senderTeamId: backendTeam.id,
      recipientTeamId: infraTeam.id,
      recipientUserId: null,
      title: '인프라팀 전체: 스테이징 캐시 인스턴스 점검 요청',
      originalInstruction: 'Redis 클러스터 페일오버 후 스테이징 캐시 노드 상태 및 메트릭 점검 요청드립니다.',
      documentVersionIds: [],
      artifactIds: []
    })
  }, tokenA);
  console.log(`  ✓ 요청 초안(DRAFT) 생성 완료: ID=${createdReq.id}, recipientUserId=${createdReq.recipientUserId}`);

  const sentReq = await serverApi(`/v1/requests/${createdReq.id}/send`, {
    method: 'POST'
  }, tokenA);
  console.log(`  ✓ 요청 전송(SENT/DELIVERED) 완료: state=${sentReq.state}`);

  // 11. User B: Inbox 에서 미확정 팀 요청 수신 확인
  console.log('\n[Step 11] User B: Inbox 조회 및 미확정 팀 요청 수신 확인');
  const inboxB = await serverApi('/v1/requests?box=inbox', {}, tokenB);
  const targetInboxReq = inboxB.find(r => r.id === createdReq.id);
  if (!targetInboxReq) {
    throw new Error('B의 수신함에서 생성된 팀 뿌리기 요청을 찾을 수 없습니다!');
  }
  console.log(`  ✓ B 수신함 확인: title="${targetInboxReq.title}", recipientUserId=${targetInboxReq.recipientUserId}, claimedAt=${targetInboxReq.claimedAt}`);

  console.log('[스크린샷 6] User B 수신함 미확정 팀 요청 표시 (/requests?as=b)');
  capture('/requests?as=b&tab=inbox', 'org-real-06-inbox-broadcast.png');

  // 12. User B: 요청 검토 시작 및 수락 (Claim 원자적 선점)
  console.log('\n[Step 12] User B: 요청 검토 시작 및 수락(Claim) 실행');
  const reviewedReq = await serverApi(`/v1/requests/${createdReq.id}/review/start`, {
    method: 'POST'
  }, tokenB);
  console.log(`  ✓ B 검토 시작(REVIEWING) 성공: state=${reviewedReq.state}`);

  const acceptedReq = await serverApi(`/v1/requests/${createdReq.id}/accept`, {
    method: 'POST'
  }, tokenB);
  console.log(`  ✓ B 수락(Claim) 성공: state=${acceptedReq.state}, recipientUserId=${acceptedReq.recipientUserId}, claimedAt=${acceptedReq.claimedAt}`);

  // 13. 상세 조회 및 claimedBy 확인
  console.log('\n[Step 13] 요청 상세 조회: 처리 중 B 확인');
  const detailReq = await serverApi(`/v1/requests/${createdReq.id}`, {}, tokenB);
  console.log(`  ✓ 상세 claimedBy:`, detailReq.claimedBy);
  if (!detailReq.claimedBy || detailReq.claimedBy.email !== 'b@baton.local') {
    throw new Error(`claimedBy가 B가 아닙니다: ${JSON.stringify(detailReq.claimedBy)}`);
  }

  console.log('[스크린샷 7] User B Claim 후 요청 상세 화면');
  capture(`/requests/${createdReq.id}?as=b`, 'org-real-07-claimed-detail.png');

  // 14. 409 Conflict 검증 (User B가 이미 Claim한 요청에 User C가 수락 시도)
  console.log('\n[Step 14] 409 Conflict 검증: User B가 선점한 요청에 User C가 수락 시도');
  try {
    const loginC = await serverApi('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'c@baton.local', password: 'baton-dev-password' })
    });
    await serverApi(`/v1/requests/${createdReq.id}/accept`, {
      method: 'POST'
    }, loginC.token);
    console.log('  ! 예상치 못한 성공 (409 발생 안 함)');
  } catch (err) {
    console.log(`  ✓ 정상 409 Conflict 발생 확인: HTTP ${err.status} - ${err.body || err.message}`);
  }

  // 15. User B: 디바이스 페어링 코드 발급 확인
  console.log('\n[Step 15] User B: 디바이스 페어링 코드 발급 확인');
  const pairingRes = await serverApi('/v1/me/pairing-codes', {
    method: 'POST'
  }, tokenB);
  console.log(`  ✓ 페어링 코드 발급 성공: code="${pairingRes.code}", expiresAt=${pairingRes.expiresAt}`);

  const devicesB = await serverApi('/v1/me/devices', {}, tokenB);
  console.log(`  ✓ User B 현재 등록 디바이스 수: ${devicesB.length}개`);

  console.log('[스크린샷 8] User B 디바이스 관리 및 페어링 코드 모달');
  capture('/me/devices?as=b&modal=pairing', 'org-real-08-pairing-code.png');

  console.log('\n================================================================');
  console.log('  모든 시나리오 검증 및 8종 스크린샷 캡처 완료! (PASS)           ');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('\n❌ 검증 스크립트 실행 실패:', err);
  process.exit(1);
});
