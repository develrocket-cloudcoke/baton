import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

// 1. fake-server 로드
const fakeServerMod = await import(pathToFileURL(path.join(__dirname, 'fake-server.mjs')).href);
const { createFakeServer } = fakeServerMod;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

async function runVerification() {
  console.log('================================================================');
  console.log('  CLO-15: 콘솔 데몬 vs 셸+데몬 OS 버전 표기 통일 실서버 검증     ');
  console.log('================================================================\n');

  // 테스트 격리 디렉터리 준비
  const testRoot = `/tmp/baton-clo15-verify-${Date.now()}`;
  const consoleHome = path.join(testRoot, 'console-home');
  const shellHome = path.join(testRoot, 'shell-home');
  const shellLogDir = path.join(testRoot, 'shell-logs');
  fs.mkdirSync(consoleHome, { recursive: true });
  fs.mkdirSync(shellHome, { recursive: true });
  fs.mkdirSync(shellLogDir, { recursive: true });

  const testBundleId = `dev.baton.desktop.clo15test.${Date.now()}`;
  console.log(`[환경 준비]`);
  console.log(`  - 작업 루트: ${REPO_ROOT}`);
  console.log(`  - 콘솔 BATON_HOME: ${consoleHome}`);
  console.log(`  - 셸 BATON_HOME: ${shellHome}`);
  console.log(`  - 테스트 번들 ID: ${testBundleId}\n`);

  // fake-server 기동
  const serverLogs = [];
  const fakeServer = createFakeServer({
    port: 0,
    log: (l) => {
      serverLogs.push(l);
      if (l.startsWith('PAIRED') || l.startsWith('HEARTBEAT')) {
        console.log(`  [FakeServer] ${l}`);
      }
    }
  });
  await fakeServer.ready;
  const serverUrl = fakeServer.url();
  console.log(`[Step 0] Fake-Server 기동 완료: ${serverUrl}\n`);

  // -------------------------------------------------------------
  // 경로 1: 콘솔 데몬 단독 실행 (Baton CLI)
  // -------------------------------------------------------------
  console.log('[Step 1] 경로 1: 콘솔 데몬 단독 실행 (BATON_SHELL / BATON_OS_VERSION 없음)');
  const consolePairCode = 'PAIR-CONSOLE-1';
  fakeServer.state.pairingCodes.set(consolePairCode, {
    code: consolePairCode,
    userId: 'user_console',
    displayName: '콘솔유저',
    expiresAt: null,
    usedAt: null,
    reusable: true
  });

  const daemonCliPath = path.resolve(REPO_ROOT, 'apps/desktop-agent/dist/cli.js');
  // settings 저장 (serverUrl, deviceName)
  const consoleConfigFile = path.join(consoleHome, 'config.json');
  fs.writeFileSync(
    consoleConfigFile,
    JSON.stringify({
      serverUrl,
      deviceName: 'console-device',
      projects: []
    }, null, 2)
  );

  // 1) 콘솔 데몬 페어링 실행 (baton login)
  console.log(`  콘솔 데몬 페어링 실행 (code: ${consolePairCode})...`);
  await execAsync(`node "${daemonCliPath}" login --server "${serverUrl}" --code "${consolePairCode}" --name "console-device"`, {
    env: {
      ...process.env,
      BATON_HOME: consoleHome,
      BATON_TOKEN_STORE: 'file',
      BATON_SHELL: '',
      BATON_OS_VERSION: ''
    }
  });
  console.log('  콘솔 데몬 페어링 완료.');

  // 2) 콘솔 데몬 기동 (baton start)
  console.log('  콘솔 데몬 기동 (baton start)...');
  const consoleDaemonProc = spawn('node', [daemonCliPath, 'start'], {
    env: {
      ...process.env,
      BATON_HOME: consoleHome,
      BATON_TOKEN_STORE: 'file',
      BATON_SHELL: '',
      BATON_OS_VERSION: '',
      PATH: process.env.PATH
    },
    stdio: 'ignore'
  });

  // 콘솔 데몬의 heartbeat 대기
  console.log('  콘솔 데몬의 Heartbeat 수신 대기 중...');
  await waitFor(() => fakeServer.state.heartbeats.length >= 1, 10000);
  const consoleHb = fakeServer.state.heartbeats[fakeServer.state.heartbeats.length - 1];
  console.log(`  ✓ 콘솔 데몬 Heartbeat 수신 성공:`);
  console.log(`    - platform:  ${consoleHb.platform}`);
  console.log(`    - osVersion: ${consoleHb.osVersion}`);
  console.log(`    - appVersion:${consoleHb.appVersion}`);
  console.log(`    - hostname:  ${consoleHb.hostname}\n`);

  // 콘솔 데몬 종료
  consoleDaemonProc.kill('SIGTERM');
  await sleep(500);

  // -------------------------------------------------------------
  // 경로 2: 셸(Baton Desktop macOS) + 데몬 실행
  // -------------------------------------------------------------
  console.log('[Step 2] 경로 2: 셸(Baton Desktop macOS) + 데몬 실행 (DaemonSupervisor 경유)');
  const shellDeviceToken = 'token_shell_test_clo15';
  const shellDeviceId = 'dev_shell_test_clo15';
  fakeServer.state.devices.set(shellDeviceToken, {
    id: shellDeviceId,
    token: shellDeviceToken,
    name: 'shell-device',
    userId: 'user_shell',
    displayName: '셸유저'
  });

  // 셸 BATON_HOME 에 device-token 및 config.json 저장 (FileTokenStore 호환)
  fs.writeFileSync(path.join(shellHome, 'device-token'), `${shellDeviceToken}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(shellHome, 'config.json'),
    JSON.stringify({
      serverUrl,
      deviceName: 'shell-device',
      projects: []
    }, null, 2)
  );

  // 번들 빌드: 격리된 번들 ID 지정
  console.log(`  테스트용 Baton.app 빌드 (BUNDLE_ID: ${testBundleId})...`);
  await execAsync(`BATON_BUNDLE_ID="${testBundleId}" bash "${REPO_ROOT}/apps/desktop-macos/build.sh"`, {
    cwd: path.resolve(REPO_ROOT, 'apps/desktop-macos')
  });

  // 셸 defaults 설정 주입 (격리된 testBundleId 도메인)
  const daemonCmd = `node ${daemonCliPath} daemon --ipc stdio`;
  await execAsync(`defaults write "${testBundleId}" settings.serverUrl "${serverUrl}"`);
  await execAsync(`defaults write "${testBundleId}" settings.deviceName "shell-device"`);
  await execAsync(`defaults write "${testBundleId}" shell.daemonCommand "${daemonCmd}"`);

  // 셸 앱 바이너리 실행
  const appPath = path.resolve(REPO_ROOT, 'apps/desktop-macos/build/Baton.app/Contents/MacOS/BatonDesktop');
  console.log(`  BatonDesktop 실행 (BATON_HOME: ${shellHome}, 번들: ${testBundleId})...`);
  const shellProc = spawn(appPath, [], {
    env: {
      ...process.env,
      BATON_HOME: shellHome,
      BATON_TOKEN_STORE: 'file',
      BATON_LOG_DIR: shellLogDir,
      PATH: process.env.PATH
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  shellProc.on('error', (err) => {
    console.error('Shell spawn error:', err);
  });

  // 셸이 데몬을 띄우고 페어링 및 heartbeat 를 전송할 때까지 대기
  const prevHbCount = fakeServer.state.heartbeats.length;
  console.log('  셸이 기동한 데몬의 Heartbeat 수신 대기 중...');
  await waitFor(() => fakeServer.state.heartbeats.length > prevHbCount, 15000);
  const shellHb = fakeServer.state.heartbeats[fakeServer.state.heartbeats.length - 1];
  console.log(`  ✓ 셸+데몬 Heartbeat 수신 성공:`);
  console.log(`    - platform:  ${shellHb.platform}`);
  console.log(`    - osVersion: ${shellHb.osVersion}`);
  console.log(`    - appVersion:${shellHb.appVersion}`);
  console.log(`    - hostname:  ${shellHb.hostname}\n`);

  // 셸 프로세스 종료 및 defaults 정리
  shellProc.kill('SIGTERM');
  try {
    await execAsync(`defaults delete "${testBundleId}" 2>/dev/null || true`);
  } catch {}
  await fakeServer.close();
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}

  // -------------------------------------------------------------
  // Step 3: 두 경로 비교 및 검증 결과 출력
  // -------------------------------------------------------------
  console.log('================================================================');
  console.log('  [비교 검증 결과]');
  console.log(`  경로 1 (콘솔 데몬): platform=${consoleHb.platform}, osVersion=${consoleHb.osVersion}`);
  console.log(`  경로 2 (셸 + 데몬): platform=${shellHb.platform}, osVersion=${shellHb.osVersion}`);
  console.log('----------------------------------------------------------------');

  if (consoleHb.platform !== shellHb.platform) {
    throw new Error(`Platform 불일치! 콘솔: ${consoleHb.platform} vs 셸: ${shellHb.platform}`);
  }
  if (consoleHb.osVersion !== shellHb.osVersion) {
    throw new Error(`OS Version 불일치! 콘솔: ${consoleHb.osVersion} vs 셸: ${shellHb.osVersion}`);
  }
  if (!consoleHb.osVersion.startsWith('macOS ')) {
    throw new Error(`OS Version 표기 형식 오류(제품 버전이 아님): ${consoleHb.osVersion}`);
  }
  if (consoleHb.osVersion.includes('Darwin')) {
    throw new Error(`OS Version 에 여전히 커널 이름(Darwin)이 포함되어 있음: ${consoleHb.osVersion}`);
  }

  console.log('  ✓ 두 경로의 platform 값이 정확히 일치함: "macos"');
  console.log(`  ✓ 두 경로의 osVersion 값이 제품 버전 표기(macOS X.Y.Z)로 완벽히 일치함: "${consoleHb.osVersion}"`);
  console.log('  ✓ 커널 버전(Darwin ...) 대신 제품 버전 표기 통일 검증 성공!');
  console.log('================================================================\n');
}

runVerification().catch((err) => {
  console.error('검증 실패:', err);
  process.exit(1);
});
