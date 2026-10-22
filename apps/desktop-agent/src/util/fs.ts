import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 데몬 홈. 테스트에서는 BATON_HOME 으로 바꾼다.
export function batonHome(): string {
  return process.env.BATON_HOME || path.join(os.homedir(), '.baton');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 비밀값 파일은 0600 으로 쓴다 (D3).
export function writePrivateFile(file: string, content: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 파일 시스템이 권한을 지원하지 않는 경우는 무시
  }
}

export function readTextIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
