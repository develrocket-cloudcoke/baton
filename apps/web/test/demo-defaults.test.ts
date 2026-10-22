import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  inheritedPolicyNotice,
  policyDifferencesFromDefault,
  policyFromExecution,
} from '../lib/execution-policy';
import {
  generateTempPassword,
  isUsableTempPassword,
  MIN_TEMP_PASSWORD_LENGTH,
} from '../lib/temp-password';
import { DEFAULT_STRUCTURED_POLICY, StructuredPolicy } from '../lib/types';

// 2026-09-21 전수조사: "사람이 시킨 적 없는 값이 조용히 서버·에이전트까지 가는" 결함들.
// 결함 3(임시 비밀번호)·4(실행 정책)·5(시뮬레이터)를 각각 고정한다.

const APPROVED: StructuredPolicy = {
  ...DEFAULT_STRUCTURED_POLICY,
  network_outbound: 'allow',
  outside_write: 'allow',
  git_write: 'local',
};
const execWith = (policy: unknown) => ({ agentCapabilitiesSnapshot: { policy } });

test('결함 4: 이전 실행이 승인받은 정책을 그대로 읽어 온다', () => {
  assert.deepEqual(policyFromExecution(execWith(APPROVED)), APPROVED);
  // 스냅샷에 남는 자리는 Execution 의 컬럼이 아니라 agentCapabilitiesSnapshot.policy 다.
  assert.equal(policyFromExecution({ policy: APPROVED } as any), null);
});

test('결함 4: 반쯤 읽힌 정책을 기본값으로 메우지 않는다', () => {
  // 한 항목이라도 비거나 모르는 값이면 null 이다. 기본값으로 채우면 사람이 승인한 적 없는
  // 조합이 만들어지는데, 그게 바로 이번에 고치는 결함과 같은 종류다.
  const { network_outbound, ...missing } = APPROVED;
  assert.equal(policyFromExecution(execWith(missing)), null);
  assert.equal(policyFromExecution(execWith({ ...APPROVED, shell_execution: 'yolo' })), null);
  assert.equal(policyFromExecution(execWith({ ...APPROVED, git_write: null })), null);
  for (const bogus of [null, undefined, 'policy', 42, [APPROVED]])
    assert.equal(policyFromExecution(execWith(bogus)), null);
  for (const bogus of [null, undefined, {}, { agentCapabilitiesSnapshot: null }])
    assert.equal(policyFromExecution(bogus), null);
});

test('결함 4: 승계한 정책 중 기본값과 다른 것만 사람에게 보여 준다', () => {
  const differences = policyDifferencesFromDefault(APPROVED);
  assert.deepEqual(differences.map((d) => d.key).sort(), [
    'git_write',
    'network_outbound',
    'outside_write',
  ]);
  const notice = inheritedPolicyNotice(APPROVED);
  assert.ok(notice.includes('외부 네트워크 통신 허용'));
  assert.ok(notice.includes('프로젝트 외 쓰기 허용'));
  // 기본값과 같으면 늘어놓지 않는다. 여섯 줄을 다 적으면 오히려 안 읽힌다.
  assert.deepEqual(policyDifferencesFromDefault(DEFAULT_STRUCTURED_POLICY), []);
  assert.ok(inheritedPolicyNotice(DEFAULT_STRUCTURED_POLICY).includes('기본 정책'));
  // 못 읽었을 때는 서버 기본값으로 간다는 사실을 숨기지 않는다.
  assert.ok(inheritedPolicyNotice(null).includes('서버 기본 정책'));
});

const source = (relative: string) => readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('결함 4: 요청 상세 화면에 하드코딩된 정책 객체와 mock ID 가 남아 있지 않다', () => {
  const page = source('app/requests/[id]/page.tsx');
  // 재실행·추가 작업이 보내던 고정 정책 객체. 있으면 사람이 승인한 권한이 리셋된다.
  assert.equal(page.includes("deployment_apply: 'deny'"), false);
  assert.equal(page.includes("network_outbound: 'deny'"), false);
  // 실서버에 존재하지 않는 외래키(결함 8). 실행이 성립하지 않으므로 메울 값이 아니다.
  assert.equal(page.includes('agent_b_id'), false);
  assert.equal(page.includes('proj_backend_id'), false);
  // 정책을 모를 때 클라이언트가 기본값을 흉내 내지 않는다.
  const client = source('lib/api-client.ts');
  assert.ok(client.includes('...(dto.policy ? { policy: dto.policy } : {})'));
});

test('결함 5: 실행 시뮬레이터가 실서버를 부르던 경로와 가짜 결과가 사라졌다', () => {
  const client = source('lib/api-client.ts');
  // 브라우저 번들에 실려 나가던 디바이스 토큰과 가짜 결과 문장들.
  assert.equal(client.includes('seed-device-token'), false);
  assert.equal(client.includes('verify.sh 테스트 실패'), false);
  assert.equal(client.includes('REDIS_HOST 오타'), false);
  assert.equal(client.includes('/v1/desktop/executions/'), false);
});

test('결함 5: real 모드에서 시뮬레이터를 부르면 즉시 막힌다', async () => {
  // 모듈이 API_MODE 를 import 시점에 정한다. 기본값이 real 이므로 그대로 불러 온다.
  const { apiClient, API_MODE } = await import('../lib/api-client');
  assert.equal(API_MODE, 'real');
  await assert.rejects(() => apiClient.simulateExecutionStep('any-execution-id'), /mock 모드 전용/);
});

test('결함 3: 임시 비밀번호는 매번 다른 무작위 값이고 짧으면 거부된다', () => {
  const first = generateTempPassword();
  const second = generateTempPassword();
  assert.notEqual(first, second);
  assert.ok(first.length >= MIN_TEMP_PASSWORD_LENGTH);
  // 헷갈리는 글자는 빼 둔다 — 사람이 눈으로 읽고 한 번 받아 적는 값이다.
  assert.equal(/[0O1lI]/.test(first + second), false);
  assert.equal(isUsableTempPassword('short'), false);
  assert.equal(isUsableTempPassword('   '), false);
  assert.equal(isUsableTempPassword(first), true);
});

test('결함 3: 관리자 화면에 고정 비밀번호가 남아 있지 않고 초기값이 비어 있다', async () => {
  const page = source('app/admin/users/page.tsx');
  assert.equal(page.includes('baton-temp-pass-123'), false);
  // createOrgUser 가 비밀번호를 스스로 메우지 않는다.
  // (같은 파일의 getUsers 는 seed 계정 로그인에 아직 같은 상수를 쓴다 — 별건으로 보고했다.)
  const createOrgUser = source('lib/api-client.ts')
    .split('async createOrgUser(')[1]
    .split('\n  },')[0];
  assert.equal(createOrgUser.includes("|| 'baton-dev-password'"), false);
  assert.ok(createOrgUser.includes('isUsableTempPassword'));
  // 초기 state 는 반드시 빈 문자열이다. 무작위 값을 여기서 만들면 서버 렌더와 값이 달라
  // hydration 이 어긋나므로, 생성은 마운트 뒤 effect 에서만 한다.
  assert.ok(page.includes("const [tempPassword, setTempPassword] = useState('');"));
  assert.ok(page.includes('useEffect(() => setTempPassword(generateTempPassword()), []);'));

  // 실제로 그려 봐도 고정 문자열이 없다. 관리자 세션이 아니면 폼 대신 권한 안내가 뜬다.
  const { AuthProvider } = await import('../components/auth-provider');
  const { default: AdminUsersPage } = await import('../app/admin/users/page');
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(AuthProvider, null, React.createElement(AdminUsersPage, {})),
      ),
    );
    assert.equal(html.includes('baton-temp-pass-123'), false);
    assert.equal(html.includes('baton-dev-password'), false);
  } finally {
    client.clear();
  }
});

test('결함 3: 임시 비밀번호 없이 계정을 만들 수 없다', async () => {
  const { apiClient } = await import('../lib/api-client');
  for (const bad of ['', '   ', 'short7'])
    await assert.rejects(
      () => apiClient.createOrgUser('new@baton.local', '새 사용자', bad),
      /임시 비밀번호/,
    );
});
