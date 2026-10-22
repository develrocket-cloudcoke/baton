/**
 * CLO-110(보안 검토 M-4): 에이전트 자식 프로세스 환경변수 화이트리스트.
 *
 * 데몬이 셸에서 실행될 때 상위 환경의 `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN`, `OPENAI_API_KEY` 등
 * 데몬 프로세스 자체의 시크릿이 자식 에이전트 프로세스로 그대로 흘러 들어가는 것을 방지한다.
 *
 * 엄격한 화이트리스트 방식을 취하며, 각 에이전트 CLI별로 필요한 최소한의 변수만 통과시킨다.
 */

export type AdapterKind = 'claude-code' | 'codex' | 'agy' | 'common';

/** 모든 어댑터 자식 프로세스에 공통으로 허용되는 기본 시스템 및 런타임 환경변수 */
const COMMON_ENV_KEYS: readonly string[] = [
  // 1. 기본 시스템 및 사용자 식별
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',

  // 2. 터미널 및 로캘 (한글 입출력 및 UTF-8 보장)
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'TERM',
  'COLORTERM',

  // 3. Node 및 런타임 / 시스템 인증서
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',

  // 4. Git 설정
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

/** 어댑터별 CLI가 필요로 하는 전용 환경변수 */
const ADAPTER_SPECIFIC_KEYS: Record<AdapterKind, readonly string[]> = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
  ],
  codex: [
    'OPENAI_API_KEY',
    'CODEX_HOME',
    'CODEX_API_KEY',
    'CODEX_MODEL',
  ],
  agy: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AGY_HOME',
    'AGY_CONFIG_DIR',
    'AGY_MODEL',
  ],
  common: [],
};

/**
 * 기본 시스템 경로를 보장하는 PATH 생성
 */
export function normalizePath(existingPath?: string): string {
  const standardDirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const currentDirs = existingPath ? existingPath.split(':').filter(Boolean) : [];
  const merged: string[] = [];
  for (const dir of [...standardDirs, ...currentDirs]) {
    if (!merged.includes(dir)) {
      merged.push(dir);
    }
  }
  return merged.join(':');
}

/**
 * 어댑터 자식 프로세스용 격리된 환경변수 객체를 생성한다.
 *
 * @param adapter 어댑터 종류 ('claude-code' | 'codex' | 'agy' | 'common')
 * @param baseEnv 기준 환경변수 (기본값: process.env)
 * @param overrides 추가로 주입하거나 덮어쓸 변수들
 */
export function buildChildEnv(
  adapter: AdapterKind,
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const allowedExact = new Set<string>([
    ...COMMON_ENV_KEYS,
    ...(ADAPTER_SPECIFIC_KEYS[adapter] ?? []),
  ]);

  const result: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;

    // 정확히 화이트리스트에 있는 키
    if (allowedExact.has(key)) {
      result[key] = value;
      continue;
    }

    // Baton 전용 환경변수 (BATON_*) 통과
    if (key.startsWith('BATON_')) {
      result[key] = value;
      continue;
    }

    // 테스트 픽스처/페이크 러너용 환경변수 (FAKE_*) 통과
    if (key.startsWith('FAKE_')) {
      result[key] = value;
      continue;
    }
  }

  // PATH 기본 경로 보장
  result.PATH = normalizePath(overrides.PATH ?? result.PATH ?? baseEnv.PATH);

  // overrides 병합
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    } else {
      delete result[key];
    }
  }

  // Node 테스트 실행 문맥이 자식 프로세스로 전파되지 않도록 무조건 삭제
  delete result.NODE_TEST_CONTEXT;

  return result;
}
