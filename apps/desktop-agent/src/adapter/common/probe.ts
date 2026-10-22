import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

// 러너는 `.js`/`.mjs` 경로를 node 로 실행한다(테스트의 가짜 CLI 가 그렇다).
// detect() 도 같은 규칙을 써야 한다 — 다르면 "실행은 되는데 감지는 안 되는" 상태가 된다.
const isScript = (binaryPath: string) => /\.(m?js)$/.test(binaryPath);

/** `<binary> --version` 으로 설치 여부를 확인한다. */
export async function probeVersion(
  binaryPath: string,
  timeoutMs = 5_000
): Promise<{ available: boolean; binaryPath: string; version?: string; reason?: string }> {
  try {
    const { stdout } = await promisify(execFile)(
      isScript(binaryPath) ? process.execPath : binaryPath,
      isScript(binaryPath) ? [binaryPath, '--version'] : ['--version'],
      // 조회 실행은 저장소 밖에서 (models.ts 와 같은 이유)
      { timeout: timeoutMs, cwd: os.tmpdir() }
    );
    return { available: true, binaryPath, version: stdout.trim() };
  } catch (e) {
    return { available: false, binaryPath, reason: String(e) };
  }
}
