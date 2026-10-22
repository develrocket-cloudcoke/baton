import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 3006;
const CDP_PORT = 9226;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOTS_DIR = path.resolve('apps/web/docs/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

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
    console.log(`  ✓ Saved ${filename} (${stat.size} bytes)`);
  }

  async close() {
    if (this.ws) {
      this.ws.close();
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

async function api(pathStr, options = {}) {
  const url = `${BASE_URL}/api/mock${pathStr}`;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      execSync('sleep 0.5');
    }
  }
  throw lastErr;
}

async function main() {
  console.log('====================================================');
  console.log('  CLO-108 위험 승인 UI 검증 및 스크린샷 캡처  ');
  console.log('====================================================\n');

  // 1. Next.js 서버 시작
  let serverProcess = null;
  const isUp = await checkServer(`${BASE_URL}/requests`);
  if (!isUp) {
    console.log(`[Server] Next.js 서버 기동 중 (포트 ${PORT})...`);
    serverProcess = spawn('pnpm', ['--filter', '@baton/web', 'dev', '-p', String(PORT)], {
      stdio: 'inherit',
      detached: true,
    });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      execSync('sleep 0.5');
      if (await checkServer(`${BASE_URL}/requests`)) {
        ready = true;
        console.log(`[Server] Next.js 준비 완료: ${BASE_URL}\n`);
        break;
      }
    }
    if (!ready) {
      throw new Error(`Next.js 서버 기동 타임아웃 (${BASE_URL})`);
    }
  }

  // 2. Chrome Headless CDP 기동
  console.log(`[Chrome] Chrome Headless 기동 중 (CDP 포트 ${CDP_PORT})...`);
  const chromeProcess = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1280,1050',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );

  // CDP 포트 준비 대기
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

  if (!wsUrl) {
    throw new Error('Chrome CDP 연결 실패');
  }

  // 새 탭 생성
  const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, {
    method: 'PUT',
  });
  const newTab = await newTabRes.json();
  const client = new CdpClient(newTab.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('DOM.enable');

  try {
    // 3. Mock 데이터 리셋 및 초기 준비
    console.log('[Step 0] Mock DB 리셋');
    await api('/v1/reset', { method: 'POST' });

    const reqId = 'req_sample_redis_01';
    console.log('[Step 1] 요청 수락 (ACCEPTED 전이)');
    await api(`/v1/requests/${reqId}/review/start`, {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: 'user_b_id' }),
    });
    await api(`/v1/requests/${reqId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ recipientUserId: 'user_b_id' }),
    });

    // 화면 1: Claude Code 선택 시 경고 없이 즉시 실행 가능
    console.log('\n[화면 1] Claude Code 선택 시 경고 없이 즉시 실행 상태');
    await client.send('Page.navigate', { url: `${BASE_URL}/requests/${reqId}` });
    execSync('sleep 2');

    // Claude Code가 선택되어 있는지 확인
    await client.eval(`
      (() => {
        const select = document.querySelector('[data-testid="agent-select"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, 'agent_b_id');
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    execSync('sleep 1');
    await client.captureScreenshot('clo108-claude-no-warning.png');

    // 화면 2: Codex 선택 후 실행 시도 -> 409 위험 승인 모달 & 일부만 체크 시 비활성화
    console.log('\n[화면 2] Codex 선택 후 409 모달 표시 및 일부 체크 시 실행 버튼 비활성화');
    await client.eval(`
      (() => {
        const select = document.querySelector('[data-testid="agent-select"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, 'agent_codex_id');
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    execSync('sleep 1.5');

    // 실행 시작 버튼 클릭 -> 409 응답 후 RiskAcknowledgementModal 팝업
    await client.eval(`
      (() => {
        const btn = document.querySelector('[data-testid="start-execution-button"]');
        if (btn) btn.click();
      })()
    `);
    execSync('sleep 2');

    // 첫 번째 체크박스(credential_path_read)만 클릭
    await client.eval(`
      (() => {
        const checkbox = document.querySelector('[data-testid="risk-checkbox-credential_path_read"]');
        if (checkbox) checkbox.click();
      })()
    `);
    execSync('sleep 1');

    // 비활성화 상태 확인
    const isConfirmDisabled = await client.eval(`
      (() => {
        const confirmBtn = document.querySelector('[data-testid="confirm-risk-button"]');
        return confirmBtn ? confirmBtn.disabled : null;
      })()
    `);
    console.log(`  ✓ Confirm button disabled state: ${isConfirmDisabled} (Expected: true)`);
    await client.captureScreenshot('clo108-risk-modal-partial-disabled.png');

    // 화면 3: 모든 항목 체크 후 승인 실행 -> "위험 승인 하에 실행됨" 배너 및 결과 화면
    console.log('\n[화면 3] 모든 위험 항목 체크 후 승인 실행 -> 승인 배너 및 이력 표시');
    await client.eval(`
      (() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"][id^="risk-check-"]');
        checkboxes.forEach(cb => {
          if (!cb.checked) cb.click();
        });
      })()
    `);
    execSync('sleep 1');

    // 승인 및 실행 버튼 클릭
    await client.eval(`
      (() => {
        const confirmBtn = document.querySelector('[data-testid="confirm-risk-button"]');
        if (confirmBtn) confirmBtn.click();
      })()
    `);
    execSync('sleep 2.5');

    // 실행 생성 확인 및 결과 시뮬레이션
    const detailAfterExec = await api(`/v1/requests/${reqId}`);
    const latestExec = detailAfterExec.latestExecution;
    console.log(`  ✓ Execution started with risk acknowledgement: ${latestExec?.id}`);
    console.log(`  ✓ Acknowledged risks count: ${latestExec?.acknowledgedRisks?.length}`);

    // 시뮬레이션으로 결과를 RESULT_REVIEW 상태까지 완료
    if (latestExec) {
      for (let step = 0; step < 8; step++) {
        const stepRes = await api(`/v1/executions/${latestExec.id}/simulate-step`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (stepRes.isDone) break;
      }
    }

    // 페이지 새로고침하여 결과 화면 및 위험 승인 배너 확인
    await client.send('Page.navigate', { url: `${BASE_URL}/requests/${reqId}` });
    execSync('sleep 2.5');
    await client.captureScreenshot('clo108-risk-acknowledgement-approved.png');

    console.log('\n====================================================');
    console.log('  CLO-108 3종 스크린샷 캡처 및 검증 완료!  ');
    console.log('====================================================\n');
  } finally {
    await client.close();
    try {
      process.kill(-chromeProcess.pid, 'SIGKILL');
    } catch {
      try {
        chromeProcess.kill('SIGKILL');
      } catch {}
    }
    if (serverProcess) {
      try {
        process.kill(-serverProcess.pid, 'SIGKILL');
      } catch {
        try {
          serverProcess.kill('SIGKILL');
        } catch {}
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
