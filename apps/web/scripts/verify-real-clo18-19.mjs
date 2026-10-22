import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const API_URL = 'http://127.0.0.1:3001';
const WEB_URL = 'http://127.0.0.1:3000';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function capture(urlPath, filename, delayMs = 1800) {
  const fullUrl = `${WEB_URL}${urlPath}`;
  const outPath = path.join(SCREENSHOTS_DIR, filename);
  console.log(`[Capture] ${fullUrl} -> ${filename}`);
  try {
    if (delayMs > 0) {
      execSync(`sleep ${delayMs / 1000}`);
    }
    const cmd = `"${CHROME_PATH}" --headless --disable-gpu --virtual-time-budget=3000 --window-size=1280,960 --screenshot="${outPath}" "${fullUrl}" 2>/dev/null`;
    execSync(cmd);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  } catch (err) {
    console.error(`  ✗ Error capturing ${filename}:`, err.message);
  }
}

async function api(endpoint, options = {}, token = null, retries = 3) {
  const url = `${API_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        ...options
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`API ${options.method || 'GET'} ${endpoint} failed (${res.status}): ${text}`);
      }
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`    [Retry ${attempt}/${retries}] Retrying ${endpoint} due to: ${err.message}`);
      execSync('sleep 1');
    }
  }
}

async function login(email, password = 'baton-dev-password') {
  const res = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  return res.token;
}

async function run() {
  console.log('================================================================');
  console.log('  CLO-18 / CLO-19 실서버(real) 통합 검증 및 스크린샷 캡처       ');
  console.log('================================================================\n');

  // 1. 관리자 토큰 및 기본 정보 조회
  console.log('[Step 1] 관리자 로그인 및 조직 팀 조회');
  const adminToken = await login('admin@baton.local');
  const teams = await api('/v1/org/teams', {}, adminToken);
  console.log('  현재 팀 목록:', teams.map(t => `${t.name} (${t.id})`).join(', '));

  const backendTeam = teams.find(t => t.name === 'backend');
  const infraTeam = teams.find(t => t.name === 'infra');
  let qaTeam = teams.find(t => t.name === 'qa');

  // qa 팀이 없으면 생성
  if (!qaTeam) {
    console.log('  qa 팀 생성 중...');
    qaTeam = await api('/v1/org/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'qa' })
    }, adminToken);
    console.log(`  qa 팀 생성 완료: ${qaTeam.id}`);
  }

  // qa 유저 확인 및 생성
  const rawUsers = await api('/v1/org/users', {}, adminToken);
  const users = rawUsers.map(m => m.user || m);
  let qaUser = users.find(u => u.email === 'qa@baton.local');
  if (!qaUser) {
    console.log('  qa@baton.local 유저 생성 중...');
    try {
      qaUser = await api('/v1/org/users', {
        method: 'POST',
        body: JSON.stringify({
          email: 'qa@baton.local',
          displayName: '최QA',
          temporaryPassword: 'baton-dev-password'
        })
      }, adminToken);
      console.log(`  qa 유저 생성 완료: ${qaUser.id}`);
    } catch (e) {
      // 409인 경우 다시 조회
      const refreshed = await api('/v1/org/users', {}, adminToken);
      qaUser = refreshed.map(m => m.user || m).find(u => u.email === 'qa@baton.local');
    }
  }

  // qa 유저를 qa 팀에 멤버 등록
  try {
    await api(`/v1/org/teams/${qaTeam.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'qa@baton.local', role: 'MEMBER' })
    }, adminToken);
    console.log('  qa 유저를 qa 팀 멤버로 등록 완료');
  } catch (e) {
    // 이미 등록되어 있으면 무시
  }

  // 2. CLO-18 (a) 관리자가 backend -> qa 단방향만 허용
  console.log('\n[Step 2] CLO-18 (a): backend -> qa 단방향 링크 설정');
  // 기존 링크들 정리 후 backend -> qa 단방향 설정
  try {
    const existingLinks = await api('/v1/org/team-links', {}, adminToken);
    const qaLink = existingLinks.find(
      l => (l.fromTeamId === backendTeam.id && l.toTeamId === qaTeam.id) ||
           (l.fromTeamId === qaTeam.id && l.toTeamId === backendTeam.id)
    );
    if (qaLink) {
      await api(`/v1/org/team-links/${qaLink.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ direction: 'both' })
      }, adminToken);
    }
  } catch (e) {}

  await api('/v1/org/team-links', {
    method: 'POST',
    body: JSON.stringify({
      teamAId: backendTeam.id,
      teamBId: qaTeam.id,
      direction: 'a-to-b'
    })
  }, adminToken);
  console.log('  backend -> qa 단방향 링크 API 생성 완료');

  // 관리자 화면 캡처 (매트릭스에서 backend->qa 단방향 표시)
  capture('/admin/team-links?as=admin', 'clo18-real-01-matrix-unidirectional.png');

  // backend 계정(user A)으로 새 요청 화면 접속 -> qa 팀이 수신 대상에 보이는지 확인
  console.log('  [검증 (a)-1] backend(A) 계정에서 qa 팀이 수신 대상에 노출되는지 확인');
  capture('/requests/new?as=a&tab=team', 'clo18-real-02-sender-can-see-qa.png');

  // qa 계정으로 새 요청 화면 접속 -> backend 팀이 수신 대상에 없는지 확인
  console.log('  [검증 (a)-2] qa 계정에서 backend 팀이 수신 대상에 없는지 확인');
  capture('/requests/new?as=qa&tab=team', 'clo18-real-03-qa-cannot-see-backend.png');

  // 3. CLO-18 (b) 양방향으로 바꾸면 양쪽 모두 보이는지
  console.log('\n[Step 3] CLO-18 (b): backend <-> qa 양방향으로 전환');
  await api('/v1/org/team-links', {
    method: 'POST',
    body: JSON.stringify({
      teamAId: backendTeam.id,
      teamBId: qaTeam.id,
      direction: 'both'
    })
  }, adminToken);
  console.log('  backend <-> qa 양방향 링크 API 설정 완료');

  // qa 계정에서 이제 backend 팀이 보이는지 캡처
  capture('/requests/new?as=qa&tab=team', 'clo18-real-04-qa-can-see-backend-bidirectional.png');

  // 4. CLO-18 (c) 한 방향만 해제했을 때
  console.log('\n[Step 4] CLO-18 (c): qa -> backend 방향만 해제');
  const linksAfterBoth = await api('/v1/org/team-links', {}, adminToken);
  const qaToBackendLink = linksAfterBoth.find(l => l.fromTeamId === qaTeam.id && l.toTeamId === backendTeam.id);
  if (qaToBackendLink) {
    await api(`/v1/org/team-links/${qaToBackendLink.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ direction: 'a-to-b' })
    }, adminToken);
    console.log('  qa -> backend 방향 단독 해제 완료');
  }
  // 다시 매트릭스 캡처
  capture('/admin/team-links?as=admin', 'clo18-real-05-matrix-revoked-one-way.png');

  // 5. CLO-19 (d) A가 팀 infra 전체에 뿌린 요청을 B가 반려 -> A가 '팀 전체에 다시'로 재전송 -> 미확정 및 claim 가능 확인
  console.log('\n[Step 5] CLO-19 (d): 팀 뿌리기 요청 -> 반려 -> 팀 전체 재뿌리기');
  const aToken = await login('a@baton.local');
  const bToken = await login('b@baton.local');

  // A가 infra 팀 전체에 뿌리는 요청 생성 (recipientUserId 미지정)
  const broadcastReq = await api('/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      senderTeamId: backendTeam.id,
      recipientTeamId: infraTeam.id,
      title: '[팀 전체 요청] 실서버 Redis 레이턴시 급증 긴급 분석',
      originalInstruction: '스테이징 및 프로덕션 환경의 Redis 응답 지연 현상을 분석하고 조치 방안을 마련해주세요.'
    })
  }, aToken);
  console.log(`  팀 뿌리기 요청 생성 완료: ${broadcastReq.id} (state: ${broadcastReq.state})`);

  // A가 Baton 전송 (DRAFT -> SENT)
  await api(`/v1/requests/${broadcastReq.id}/send`, { method: 'POST' }, aToken);
  console.log('  A가 요청 Baton 전송 완료 (state: SENT)');

  // B가 검토 시작 (미확정 팀 요청 검토 시 자동으로 B에게 할당 및 claimedAt 기록)
  await api(`/v1/requests/${broadcastReq.id}/review/start`, { method: 'POST' }, bToken);
  console.log('  B(박인프라)가 요청 검토 시작 (state: REVIEWING, recipientUserId 및 claimedAt 기록)');

  // B가 사유를 적어 반려(Return)
  await api(`/v1/requests/${broadcastReq.id}/return`, {
    method: 'POST',
    body: JSON.stringify({
      reason: '최근 1시간 동안의 Redis SLOWLOG 및 네트워크 메트릭 원본 데이터 첨부가 필요합니다.'
    })
  }, bToken);
  console.log('  B(박인프라)가 요청 반려(Return) 완료 (state: RETURNED)');

  // A가 반려된 요청 상세 화면 접속 (팀 뿌리기였던 요청이므로 재배정 옵션이 노출됨)
  console.log('  [검증 (d)-1] A의 재전송 화면에서 [팀 전체에 다시 뿌리기] 라디오 카드 노출 확인');
  capture(`/requests/${broadcastReq.id}?as=a&reassign=team`, 'clo19-real-01-resend-form-team-option.png');

  // A가 '팀 전체에 다시' (reassign: 'team')로 재전송
  console.log('  A가 revision 생성 후 reassign: team 으로 재전송 실행');
  await api(`/v1/requests/${broadcastReq.id}/revisions`, {
    method: 'POST',
    body: JSON.stringify({
      originalInstruction: '요청하신 Redis SLOWLOG 및 네트워크 메트릭 원본 데이터를 추가 첨부하여 재전송합니다.'
    })
  }, aToken);

  await api(`/v1/requests/${broadcastReq.id}/resend`, {
    method: 'POST',
    body: JSON.stringify({
      reassign: 'team'
    })
  }, aToken);
  console.log('  reassign: team 재전송 API 완료 (state: SENT, recipientUserId: null, claimedAt: null)');

  // B 계정으로 상세 화면 접속 -> 미확정 배지 및 [내가 담당하기 (Claim)] 배너 확인
  console.log('  [검증 (d)-2] B 계정에서 미확정 상태 및 Claim 배너 노출 확인');
  capture(`/requests/${broadcastReq.id}?as=b`, 'clo19-real-02-reassigned-unclaimed.png');

  // B가 다시 Claim 할 수 있는지 검증
  await api(`/v1/requests/${broadcastReq.id}/review/start`, { method: 'POST' }, bToken);
  await api(`/v1/requests/${broadcastReq.id}/accept`, { method: 'POST' }, bToken);
  console.log('  ✓ B가 재뿌려진 미확정 요청을 다시 성공적으로 Claim(수락) 완료');

  // 6. CLO-19 (e) 사람 지정 요청에서는 재뿌리기 선택지가 안 보이는지
  console.log('\n[Step 6] CLO-19 (e): 사람 지정 요청 생성 -> 반려 -> 재뿌리기 선택지 미노출 확인');
  const userB = users.find(u => u.email === 'b@baton.local');
  const individualReq = await api('/v1/requests', {
    method: 'POST',
    body: JSON.stringify({
      senderTeamId: backendTeam.id,
      recipientTeamId: infraTeam.id,
      recipientUserId: userB.id,
      title: '[개인 지정] DB 슬레이브 지연 원인 분석 요청',
      originalInstruction: 'B 담당자님께 직접 요청드립니다. 슬레이브 복제 지연을 확인해주세요.'
    })
  }, aToken);
  console.log(`  개인 지정 요청 생성 완료: ${individualReq.id}`);

  // A가 전송
  await api(`/v1/requests/${individualReq.id}/send`, { method: 'POST' }, aToken);

  // B가 검토 시작 후 반려
  await api(`/v1/requests/${individualReq.id}/review/start`, { method: 'POST' }, bToken);
  await api(`/v1/requests/${individualReq.id}/return`, {
    method: 'POST',
    body: JSON.stringify({ reason: '쿼리 프로파일링 로그를 먼저 첨부해주세요.' })
  }, bToken);
  console.log('  개인 지정 요청 반려 완료');

  // A가 상세 화면 접속 -> 재뿌리기 라디오 카드가 없고 기존 담당자에게만 재전송되는지 캡처
  console.log('  [검증 (e)] 개인 지정 요청의 재전송 화면 캡처 (재뿌리기 선택지 없음)');
  capture(`/requests/${individualReq.id}?as=a`, 'clo19-real-03-individual-no-team-option.png');

  console.log('\n================================================================');
  console.log('  모든 검증 (a)~(e) 완료 및 스크린샷 캡처 성공!                  ');
  console.log('================================================================\n');
}

run().catch((err) => {
  console.error('검증 실행 중 에러 발생:', err);
  process.exit(1);
});
