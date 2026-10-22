import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DAEMON_VERSION } from '../util/version';

// 01 §5.3 DeviceMetadata (packages/shared DeviceMetadataSchema). pairing 과 heartbeat 가 같은 값을 보낸다.
export interface DeviceInfo {
  platform: string;
  osVersion: string;
  appVersion: string;
  hostname: string;
}

/**
 * 04 §3.2 & CLO-15 설계 결정:
 * `platform` 필드는 시스템 간(API, DB, 웹 클라이언트 라우팅, 어댑터 레지스트리)의 기계용 식별자(machine-readable token)로
 * 'macos' | 'windows' | 'linux' 소문자 정규화 값을 유지한다.
 *
 * [결정 근거]:
 * 1. 내부 아키텍처 및 하위 호환성:
 *    - 서버(NestJS) 및 웹(Next.js) 전반에서 `platform === 'macos'` 같은 소문자 토큰을 기준으로 플랫폼을 판별하고 동작을 분기함.
 *    - 웹(`apps/web/app/me/devices/page.tsx`)의 `platformLabel()` 함수 역시 소문자 토큰을 입력받아 'macOS', 'Windows', 'Linux' 등
 *      사람이 읽기 좋은 라벨로 변환하여 렌더링하고 있음.
 * 2. 역할 분리:
 *    - `platform`: 기계적 판정 및 통신 프로토콜용 불변 식별자 ('macos', 'windows', 'linux')
 *    - `osVersion`: 사용자가 웹 UI 등에서 직관적으로 식별할 수 있는 OS 제품 및 버전 문자열 ('macOS 26.5.2', 'Ubuntu 22.04 LTS' 등)
 *    따라서 `platform` 필드는 기계용으로 정규화하여 유지하고, 사람이 읽는 제품 버전은 `osVersion`에 명확히 표기한다.
 */
function platformName(): string {
  const fromShell = process.env.BATON_SHELL?.trim();
  if (fromShell) return fromShell.toLowerCase();
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return process.platform;
  }
}

/**
 * 단위 테스트 및 의존성 주입을 위한 오버라이드 옵션 인터페이스
 */
export interface OsDetectionOverrides {
  envOsVersion?: string;
  platform?: NodeJS.Platform;
  swVersRunner?: () => string;
  osReleaseReader?: () => string | null;
  osType?: () => string;
  osRelease?: () => string;
}

/**
 * Linux 배포판 식별 (/etc/os-release 파싱)
 */
function parseLinuxOsRelease(content: string): string | null {
  const lines = content.split('\n');
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    kv[key] = val;
  }

  if (kv['PRETTY_NAME']) {
    return kv['PRETTY_NAME'];
  }
  if (kv['NAME']) {
    return kv['VERSION'] ? `${kv['NAME']} ${kv['VERSION']}` : kv['NAME'];
  }
  return null;
}

/**
 * macOS 제품 버전 감지 (/usr/bin/sw_vers -productVersion)
 */
function getMacOsProductVersion(runner?: () => string): string | null {
  try {
    if (runner) {
      const v = runner().trim();
      return v || null;
    }
    // execFileSync를 사용하여 셸을 통하지 않고 안전하게 sw_vers 호출
    const output = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * 04 §11.4 & CLO-15:
 * 데몬이 콘솔에서 단독 실행될 때도 커널 버전(Darwin 25.5.0)이 아닌
 * 제품 버전(macOS X.Y.Z)을 보고하도록 플랫폼별로 제품 버전을 감지한다.
 */
export function detectOsVersion(overrides?: OsDetectionOverrides): string {
  // 1. 셸(Baton Desktop macOS) 등에서 환경변수로 제품 버전을 주입한 경우 최우선 사용
  const envVal = overrides?.envOsVersion ?? process.env.BATON_OS_VERSION?.trim();
  if (envVal) {
    return envVal;
  }

  const currentPlatform = overrides?.platform ?? process.platform;
  const getRelease = overrides?.osRelease ?? os.release;
  const getType = overrides?.osType ?? os.type;

  switch (currentPlatform) {
    case 'darwin': {
      const prodVersion = getMacOsProductVersion(overrides?.swVersRunner);
      if (prodVersion) {
        return `macOS ${prodVersion}`;
      }
      // sw_vers 실패 시 커널 대신 플랫폼 이름을 명시하여 반환
      return `macOS ${getRelease()}`;
    }
    case 'linux': {
      try {
        let content: string | null = null;
        if (overrides?.osReleaseReader) {
          content = overrides.osReleaseReader();
        } else if (fs.existsSync('/etc/os-release')) {
          content = fs.readFileSync('/etc/os-release', 'utf8');
        } else if (fs.existsSync('/usr/lib/os-release')) {
          content = fs.readFileSync('/usr/lib/os-release', 'utf8');
        }
        if (content) {
          const linuxName = parseLinuxOsRelease(content);
          if (linuxName) return linuxName;
        }
      } catch {
        // 무시하고 fallback으로 이동
      }
      return `Linux ${getRelease()}`;
    }
    case 'win32': {
      return `Windows ${getRelease()}`;
    }
    default: {
      return `${getType()} ${getRelease()}`;
    }
  }
}

// OS 버전은 프로세스 실행 중에 변경되지 않으므로 최초 1회 캐싱
let cachedOsVersion: string | null = null;

export function getCachedOsVersion(): string {
  if (!cachedOsVersion) {
    cachedOsVersion = detectOsVersion();
  }
  return cachedOsVersion;
}

export function resetCachedOsVersionForTesting(): void {
  cachedOsVersion = null;
}

export function deviceInfo(): DeviceInfo {
  return {
    platform: platformName(),
    osVersion: getCachedOsVersion(),
    appVersion: process.env.BATON_SHELL_VERSION?.trim() || DAEMON_VERSION,
    hostname: os.hostname()
  };
}

