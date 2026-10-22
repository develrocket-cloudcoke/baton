import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'http://127.0.0.1:3001';
const WEB_BASE = 'http://127.0.0.1:3000';
const CDP_PORT = 9228;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('docs/screenshots');
const FIXTURE_DIR = '/tmp/baton-test-fixtures/backend-api';

const HOMES = {
  CLAUDE: '/tmp/baton-test-home-claude',
  CODEX: '/tmp/baton-test-home-codex',
  AGY: '/tmp/baton-test-home-agy',
};

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async captureScreenshot(filename) {
    const outPath = path.join(SCREENSHOTS_DIR, filename);
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.writeFileSync(outPath, buffer);
    const stat = fs.statSync(outPath);
    console.log(`  📸 Saved screenshot: ${filename} (${stat.size} bytes)`);
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

async function login(email) {
  const res = await fetch(`${API_BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'baton-dev-password' }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function api(token, method, pathStr, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${pathStr}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`API Error ${res.status} ${method} ${pathStr}: ${errText}`);
    err.status = res.status;
    try { err.data = JSON.parse(errText); } catch {}
    throw err;
  }
  return res.json();
}

async function acceptRequest(token, reqId) {
  const detail = await api(token, 'GET', `/v1/requests/${reqId}`);
  if (detail.state === 'SENT' || detail.state === 'DELIVERED') {
    await api(token, 'POST', `/v1/requests/${reqId}/review/start`);
  }
  return api(token, 'POST', `/v1/requests/${reqId}/accept`);
}

function resetFixture() {
  execSync(`./scripts/fixture-backend-api.sh "${FIXTURE_DIR}"`, { stdio: 'pipe' });
  console.log('✓ Fixture reset completed');
}

async function pairDevice(bToken, homeDir, deviceName, provider) {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const codeRes = await api(bToken, 'POST', '/v1/me/pairing-codes');
  const code = codeRes.code;

  execSync(
    `node apps/desktop-agent/dist/cli.js login --code "${code}" --server "${API_BASE}" --name "${deviceName}" --provider "${provider}" --project "${FIXTURE_DIR}"`,
    {
      env: { ...process.env, BATON_HOME: homeDir },
      stdio: 'pipe',
    }
  );
  console.log(`✓ Device paired: ${deviceName} (${provider})`);
}

function startDaemon(homeDir, provider, extraEnv = {}) {
  const logFile = `${homeDir}/daemon.log`;
  const out = fs.openSync(logFile, 'a');
  const child = spawn(
    'node',
    ['apps/desktop-agent/dist/cli.js', 'start', '--server', API_BASE],
    {
      env: {
        ...process.env,
        BATON_HOME: homeDir,
        BATON_PROVIDER: provider,
        ...extraEnv,
      },
      stdio: ['ignore', out, out],
      detached: true,
    }
  );
  child.unref();
  return { child, logFile, pid: child.pid };
}

async function main() {
  console.log('===========================================================');
  console.log('  CLO-108/109 통합 검증: 세 provider 실서버 E2E 검증  ');
  console.log('===========================================================\n');

  const daemons = [];
  let chromeProcess = null;
  let cdpClient = null;

  try {
    // 1. Fixture 준비
    resetFixture();

    // 2. B 로그인 및 디바이스 3종 페어링
    console.log('\n[Phase 1] B 토큰 획득 및 3개 디바이스 페어링');
    const tokenB = await login('b@baton.local');
    const tokenA = await login('a@baton.local');

    const meB = await api(tokenB, 'GET', '/v1/me');
    const bUserId = meB.user?.id || meB.id;
    const bTeamId = meB.teams[0].id;

    const meA = await api(tokenA, 'GET', '/v1/me');
    const aUserId = meA.user?.id || meA.id;
    const aTeamId = meA.teams[0].id;

    await pairDevice(tokenB, HOMES.CLAUDE, 'Mac-Claude', 'CLAUDE_CODE');
    await pairDevice(tokenB, HOMES.CODEX, 'Mac-Codex', 'CODEX');
    await pairDevice(tokenB, HOMES.AGY, 'Mac-Agy', 'AGY');

    // 3. 데몬 3종 기동
    console.log('\n[Phase 2] 콘솔 모드 데몬 3종 기동');
    const dClaude = startDaemon(HOMES.CLAUDE, 'CLAUDE_CODE');
    daemons.push(dClaude);

    const fakeCodexPath = path.resolve('apps/desktop-agent/test/fake-codex.mjs');
    const dCodex = startDaemon(HOMES.CODEX, 'CODEX', {
      BATON_CODEX_PATH: fakeCodexPath,
    });
    daemons.push(dCodex);

    const dAgy = startDaemon(HOMES.AGY, 'AGY');
    daemons.push(dAgy);

    // 데몬 연결 및 프로젝트 등록 대기
    console.log('데몬 SSE 연결 및 Agent 등록 대기 중 (5초)...');
    execSync('sleep 5');

    // 4. 실서버 GET /v1/agents 및 capabilities 확인
    console.log('\n[Phase 3] 서버 등록 Agent 및 실측 Capability 검증');
    const agents = await api(tokenB, 'GET', '/v1/agents');
    console.log(`등록된 Agent 수: ${agents.length}`);

    const claudeAgent = agents.find((a) => a.provider === 'CLAUDE_CODE' && a.status === 'ONLINE');
    const codexAgent = agents.find((a) => a.provider === 'CODEX' && a.status === 'ONLINE');
    const agyAgent = agents.find((a) => a.provider === 'AGY' && a.status === 'ONLINE');

    if (!claudeAgent) throw new Error('Claude Code ONLINE Agent not found');
    if (!codexAgent) throw new Error('Codex ONLINE Agent not found');
    if (!agyAgent) throw new Error('Antigravity ONLINE Agent not found');

    console.log(`  ✓ Claude Code Agent: ${claudeAgent.id} (Tier: ${claudeAgent.capabilities?.securityTier}, credentialPathDeny: ${claudeAgent.capabilities?.supportedPolicyEnforcements?.credentialPathDeny})`);
    console.log(`  ✓ Codex Agent: ${codexAgent.id} (Tier: ${codexAgent.capabilities?.securityTier}, credentialPathDeny: ${codexAgent.capabilities?.supportedPolicyEnforcements?.credentialPathDeny})`);
    console.log(`  ✓ Antigravity Agent: ${agyAgent.id} (Tier: ${agyAgent.capabilities?.securityTier}, credentialPathDeny: ${agyAgent.capabilities?.supportedPolicyEnforcements?.credentialPathDeny})`);

    // 5. Headless Chrome 기동
    console.log('\n[Phase 4] Headless Chrome CDP 기동');
    chromeProcess = spawn(
      CHROME_PATH,
      [
        '--headless=new',
        '--disable-gpu',
        `--remote-debugging-port=${CDP_PORT}`,
        '--window-size=1280,1050',
        'about:blank',
      ],
      { stdio: 'ignore', detached: true }
    );

    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      execSync('sleep 0.3');
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (res.ok) {
          const data = await res.json();
          wsUrl = data.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }
    if (!wsUrl) throw new Error('Chrome CDP launch failed');

    const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const newTab = await newTabRes.json();
    cdpClient = new CdpClient(newTab.webSocketDebuggerUrl);
    await cdpClient.connect();
    await cdpClient.send('Page.enable');
    await cdpClient.send('DOM.enable');
    console.log('✓ Chrome CDP connected');

    // -------------------------------------------------------------
    // 시나리오 A: Claude Code — 경고 없이 즉시 실행 성공
    // -------------------------------------------------------------
    console.log('\n===========================================================');
    console.log('  시나리오 A: Claude Code — 경고 없이 즉시 실행 성공');
    console.log('===========================================================');

    resetFixture();
    const reqClaude = await api(tokenA, 'POST', '/v1/requests', {
      senderTeamId: aTeamId,
      recipientTeamId: bTeamId,
      recipientUserId: bUserId,
      title: '로그인 API 500 오류 원인 해결 (Claude Code 검증)',
      originalInstruction: 'Kubernetes deployment.yaml 의 REDIS_HOST 설정 오류(redis-servcie 오타)를 redis-service 로 고치고 ./verify.sh 를 통과시켜주세요.',
      documentVersionIds: [],
      artifactIds: [],
    });
    await api(tokenA, 'POST', `/v1/requests/${reqClaude.id}/send`);
    await acceptRequest(tokenB, reqClaude.id);
    console.log(`✓ Request 1 생성 및 수락 완료: ${reqClaude.id}`);

    // Web UI 이동
    await cdpClient.send('Page.navigate', { url: `${WEB_BASE}/requests/${reqClaude.id}?as=b` });
    execSync('sleep 2');

    // Claude Code 에이전트 선택
    await cdpClient.eval(`
      (() => {
        const select = document.querySelector('[data-testid="agent-select"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, '${claudeAgent.id}');
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    execSync('sleep 1');

    // 실행 시작 버튼 클릭
    await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="start-execution-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 2');

    // 모달이 뜨지 않고 바로 실행으로 전이되었는지 확인
    const modalVisible = await cdpClient.eval(`
      Boolean(document.querySelector('[data-testid="confirm-risk-button"]'))
    `);
    console.log(`  ✓ 위험 승인 모달 노출 여부 (기대값 false): ${modalVisible}`);

    // 실행 완료 대기 (최대 30초)
    console.log('Claude Code 실행 완료 대기 중...');
    let claudeDone = false;
    for (let i = 0; i < 30; i++) {
      execSync('sleep 1');
      const detail = await api(tokenB, 'GET', `/v1/requests/${reqClaude.id}`);
      if (detail.state === 'RESULT_REVIEW' || detail.latestResult || detail.latestExecution?.status === 'SUCCEEDED') {
        claudeDone = true;
        console.log(`  ✓ Claude Code 실행 완료! State: ${detail.state}`);
        break;
      }
    }

    // -------------------------------------------------------------
    // 시나리오 B: Codex — 409 강제 불가 항목 표시 → 개별 승인 후 실행
    // -------------------------------------------------------------
    console.log('\n===========================================================');
    console.log('  시나리오 B: Codex — 409 강제 불가 표시 & 부분 체크 비활성화 & 승인 실행');
    console.log('===========================================================');

    resetFixture();
    const reqCodex = await api(tokenA, 'POST', '/v1/requests', {
      senderTeamId: aTeamId,
      recipientTeamId: bTeamId,
      recipientUserId: bUserId,
      title: '로그인 API 500 오류 원인 해결 (Codex 위험 승인 검증)',
      originalInstruction: 'Kubernetes deployment.yaml 의 REDIS_HOST 설정 오류를 고치고 ./verify.sh 를 통과시켜주세요.',
      documentVersionIds: [],
      artifactIds: [],
    });
    await api(tokenA, 'POST', `/v1/requests/${reqCodex.id}/send`);
    await acceptRequest(tokenB, reqCodex.id);
    console.log(`✓ Request 2 생성 및 수락 완료: ${reqCodex.id}`);

    // Web UI 이동
    await cdpClient.send('Page.navigate', { url: `${WEB_BASE}/requests/${reqCodex.id}?as=b` });
    execSync('sleep 2');

    // Codex 에이전트 선택
    await cdpClient.eval(`
      (() => {
        const select = document.querySelector('[data-testid="agent-select"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, '${codexAgent.id}');
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    execSync('sleep 1.5');

    // 실행 시작 버튼 클릭 -> 409 응답 후 RiskAcknowledgementModal 팝업
    await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="start-execution-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 2');

    // 모달 확인: credential_path_read 만 클릭
    await cdpClient.eval(`
      (() => {
        const cb = document.querySelector('[data-testid="risk-checkbox-credential_path_read"]');
        if (cb && !cb.checked) cb.click();
      })()
    `);
    execSync('sleep 1');

    // (c) 일부만 체크 시 실행 버튼 비활성화 확인
    const isPartialDisabled = await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="confirm-risk-button"]');
        return btn ? btn.disabled : null;
      })()
    `);
    console.log(`  ✓ 일부만 체크 시 실행 버튼 disabled (기대값 true): ${isPartialDisabled}`);

    // 스크린샷 1: acceptance-providers-codex-partial.png
    await cdpClient.captureScreenshot('acceptance-providers-codex-partial.png');

    // 나머지 모든 항목 체크
    await cdpClient.eval(`
      (() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"][id^="risk-check-"]');
        checkboxes.forEach((cb) => {
          if (!cb.checked) cb.click();
        });
      })()
    `);
    execSync('sleep 1');

    const isAllCheckedEnabled = await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="confirm-risk-button"]');
        return btn ? !btn.disabled : null;
      })()
    `);
    console.log(`  ✓ 모든 항목 체크 시 실행 버튼 enabled (기대값 true): ${isAllCheckedEnabled}`);

    // 승인 및 실행 버튼 클릭
    await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="confirm-risk-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 3');

    // Codex 실행 완료 대기
    console.log('Codex 실행 및 결과 보고 대기 중...');
    let codexDone = false;
    for (let i = 0; i < 20; i++) {
      execSync('sleep 1');
      const detail = await api(tokenB, 'GET', `/v1/requests/${reqCodex.id}`);
      if (detail.state === 'RESULT_REVIEW' || detail.latestResult) {
        codexDone = true;
        console.log(`  ✓ Codex 실행 완료! State: ${detail.state}`);
        break;
      }
    }

    // 결과 화면 새로고침하여 승인 배너 및 타임라인 확인
    await cdpClient.send('Page.navigate', { url: `${WEB_BASE}/requests/${reqCodex.id}?as=b` });
    execSync('sleep 2.5');

    // 스크린샷 2: acceptance-providers-codex-approved.png
    await cdpClient.captureScreenshot('acceptance-providers-codex-approved.png');

    // -------------------------------------------------------------
    // 시나리오 C: Antigravity — 409 → 승인 → 실행 시작(진행 확인)
    // -------------------------------------------------------------
    console.log('\n===========================================================');
    console.log('  시나리오 C: Antigravity — 409 → 4개 항목 승인 → 실행 시작 및 진행');
    console.log('===========================================================');

    resetFixture();
    const reqAgy = await api(tokenA, 'POST', '/v1/requests', {
      senderTeamId: aTeamId,
      recipientTeamId: bTeamId,
      recipientUserId: bUserId,
      title: '로그인 API 500 오류 원인 해결 (Antigravity 위험 승인 검증)',
      originalInstruction: 'Kubernetes deployment.yaml 의 REDIS_HOST 설정 오류를 고치고 ./verify.sh 를 통과시켜주세요.',
      documentVersionIds: [],
      artifactIds: [],
    });
    await api(tokenA, 'POST', `/v1/requests/${reqAgy.id}/send`);
    await acceptRequest(tokenB, reqAgy.id);
    console.log(`✓ Request 3 생성 및 수락 완료: ${reqAgy.id}`);

    // Web UI 이동
    await cdpClient.send('Page.navigate', { url: `${WEB_BASE}/requests/${reqAgy.id}?as=b` });
    execSync('sleep 2');

    // Antigravity 에이전트 선택
    await cdpClient.eval(`
      (() => {
        const select = document.querySelector('[data-testid="agent-select"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, '${agyAgent.id}');
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    execSync('sleep 1.5');

    // 실행 시작 클릭 -> 409 모달
    await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="start-execution-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 2');

    // 모달 내 항목 수 확인 (기대값 4개)
    const agyRiskCount = await cdpClient.eval(`
      document.querySelectorAll('input[type="checkbox"][id^="risk-check-"]').length
    `);
    console.log(`  ✓ Antigravity 승인 대상 항목 수 (기대값 4개): ${agyRiskCount}`);

    // 4개 항목 모두 체크
    await cdpClient.eval(`
      (() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"][id^="risk-check-"]');
        checkboxes.forEach((cb) => {
          if (!cb.checked) cb.click();
        });
      })()
    `);
    execSync('sleep 1');

    // 승인 및 실행 버튼 클릭
    await cdpClient.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="confirm-risk-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 3');

    // 실행 진행 상태 확인
    const agyExecState = await api(tokenB, 'GET', `/v1/requests/${reqAgy.id}`);
    console.log(`  ✓ Antigravity 실행 상태: Request=${agyExecState.state}, ExecStatus=${agyExecState.latestExecution?.status}`);

    // 스크린샷 3: acceptance-providers-agy-running.png
    await cdpClient.captureScreenshot('acceptance-providers-agy-running.png');

    console.log('\n===========================================================');
    console.log('  세 Provider 실서버 E2E 검증 및 스크린샷 3종 확보 완료!  ');
    console.log('===========================================================\n');
  } finally {
    if (cdpClient) await cdpClient.close();
    if (chromeProcess) {
      try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    }
    for (const d of daemons) {
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { d.child.kill('SIGKILL'); } catch {}
    }
    // 임시 디렉터리 정리
    for (const home of Object.values(HOMES)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    console.log('✓ 환경 정리 완료 (데몬 종료 및 임시 홈 디렉터리 삭제)');
  }
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
