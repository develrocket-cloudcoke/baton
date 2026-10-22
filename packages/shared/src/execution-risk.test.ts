import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampAgentCapabilities,
  executionApprovalProtections,
  executionCapabilityMismatch,
  effectiveAgentCapabilities,
  PROVIDER_CAPABILITY_CEILINGS,
  providerCapabilityCeiling,
  unenforceableProtections,
  type AgentCapabilities,
} from './index';

// 설계 06 §4.4 의 Codex 실측 선언값.
const codex: AgentCapabilities = {
  supportsResume: true,
  supportsStructuredProgress: true,
  supportsCancel: true,
  supportsLayer1Patch: false,
  securityTier: 'tier_b_sandboxed',
  supportedPolicyEnforcements: {
    toolDeny: false,
    networkDeny: true,
    destructiveCommandDeny: false,
    credentialPathDeny: false,
  },
};
const defaultPolicy = {
  repository_edit: 'allow',
  deployment_apply: 'deny',
  network_outbound: 'deny',
  outside_write: 'deny',
  shell_execution: 'allow',
} as const;
const keys = (capabilities: AgentCapabilities, policy: unknown) =>
  unenforceableProtections(capabilities, policy as any).map((item) => item.key);

// CLO-110 M-2: 예전에는 빈 policy 를 넘기면 목록이 줄어드는 게 아니라 *달라졌다*.
// deployment_apply 가 빠지고 shell_execution 이 들어왔다(비교 방향이 반대라서).
test('CLO-110 M-2 정규화되지 않은 policy 도 같은 목록을 낸다', () => {
  assert.deepEqual(keys(codex, defaultPolicy), [
    'credential_path_read',
    'deployment_apply',
    'git_write',
  ]);
  // 빈 객체·undefined·null·일부 생략 — 전부 기본값으로 채워져 같은 목록이 된다.
  for (const policy of [{}, undefined, null, { repository_edit: 'allow' }])
    assert.deepEqual(
      keys(codex, policy),
      keys(codex, defaultPolicy),
      `policy=${JSON.stringify(policy)}`,
    );
  // 의미가 다른 정책은 당연히 다른 목록이다 — 정규화가 차이를 지우지는 않는다.
  assert.deepEqual(keys(codex, { ...defaultPolicy, shell_execution: 'read_only' }), [
    'credential_path_read',
    'deployment_apply',
    'shell_execution',
    'git_write',
  ]);
});

// CLO-110 H-2-1: capability 는 데몬의 자기 선언이므로 서버 상한으로 깎는다.
test('CLO-110 H-2-1 과대 선언은 provider 상한으로 깎이고 승인 항목이 사라지지 않는다', () => {
  const lying: AgentCapabilities = {
    ...codex,
    securityTier: 'tier_a_hardened',
    supportedPolicyEnforcements: {
      toolDeny: true,
      networkDeny: true,
      destructiveCommandDeny: true,
      credentialPathDeny: true,
    },
  };
  const { capabilities, overDeclared } = clampAgentCapabilities('CODEX', lying);
  assert.equal(capabilities.securityTier, 'tier_b_sandboxed');
  assert.equal(capabilities.supportedPolicyEnforcements.credentialPathDeny, false);
  assert.deepEqual(overDeclared.sort(), [
    'securityTier',
    'supportedPolicyEnforcements.credentialPathDeny',
    'supportedPolicyEnforcements.destructiveCommandDeny',
    'supportedPolicyEnforcements.toolDeny',
  ]);
  // 깎기 전이면 항목이 통째로 사라진다(보안 검토 probe C). 깎은 뒤에는 정직한 선언과 같다.
  assert.deepEqual(keys(lying, defaultPolicy), []);
  assert.deepEqual(keys(capabilities, defaultPolicy), keys(codex, defaultPolicy));
  assert.deepEqual(
    effectiveAgentCapabilities('CODEX', lying),
    effectiveAgentCapabilities('CODEX', codex),
  );
});

test('CLO-110 H-2-1 정직한 하향 선언은 그대로 두고, 모르는 provider 는 전부 false 다', () => {
  const honest: AgentCapabilities = {
    ...codex,
    securityTier: 'tier_c_unrestricted',
    supportedPolicyEnforcements: { ...codex.supportedPolicyEnforcements, networkDeny: false },
  };
  const { capabilities, overDeclared } = clampAgentCapabilities('CODEX', honest);
  assert.deepEqual(overDeclared, []);
  assert.deepEqual(capabilities, honest);
  // 표에 없는 provider 는 상한이 전부 false·tier_c 다 — 실측으로 표를 갱신하기 전까지 강제 능력을 인정하지 않는다.
  const unknown = providerCapabilityCeiling('SOME_NEW_AGENT');
  assert.equal(unknown.securityTier, 'tier_c_unrestricted');
  assert.deepEqual(Object.values(unknown.supportedPolicyEnforcements), [
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(clampAgentCapabilities('SOME_NEW_AGENT', codex).capabilities, unknown);
  // Claude Code 의 하위 호환 기본값(null capability)은 상한과 같아 깎이지 않는다.
  assert.deepEqual(
    effectiveAgentCapabilities('CLAUDE_CODE', null),
    PROVIDER_CAPABILITY_CEILINGS.CLAUDE_CODE,
  );
});

test('M-1·M-3 독립 승인 비교는 합집합·정확한 승인·잘못된 이력을 검증한다', () => {
  const inherited = unenforceableProtections(codex, defaultPolicy);
  const relaxed = { ...defaultPolicy, deployment_apply: 'allow' as const };
  const union = executionApprovalProtections(codex, relaxed, inherited);
  assert.deepEqual(
    union.map((item) => item.key),
    ['credential_path_read', 'git_write', 'deployment_apply'],
  );
  assert.equal(
    executionCapabilityMismatch(
      codex,
      relaxed,
      ['deployment_apply', 'credential_path_read', 'git_write'],
      inherited.map((item) => item.key),
    ),
    null,
  );
  assert.ok(
    executionCapabilityMismatch(codex, relaxed, ['credential_path_read'], ['deployment_apply']),
  );
  assert.ok(
    executionCapabilityMismatch(codex, relaxed, ['credential_path_read', 'bogus'], ['bogus']),
  );
  assert.ok(
    executionCapabilityMismatch(
      codex,
      relaxed,
      ['credential_path_read'],
      ['credential_path_read', 'credential_path_read'],
    ),
  );
  // 과소 선언 때 서버가 더 많이 승인했어도 로컬 집합과 다르면 다시 동기화한다.
  assert.ok(
    executionCapabilityMismatch(codex, relaxed, ['credential_path_read', 'network_outbound']),
  );
});

test('CLO-131 push는 모든 provider에서 원격 위험 개별 승인이 필요하다', () => {
  for (const capabilities of Object.values(PROVIDER_CAPABILITY_CEILINGS)) {
    const policy = { ...defaultPolicy, git_write: 'push' as const };
    const protections = unenforceableProtections(capabilities, policy);
    const remote = protections.find((p) => p.key === 'git_remote_write');
    assert.equal(remote?.severity, 'critical');
    assert.equal(remote?.policyField, 'git_write');
    const approved = protections.map((p) => p.key);
    assert.ok(
      executionCapabilityMismatch(
        capabilities,
        policy,
        approved.filter((k) => k !== 'git_remote_write'),
      ),
    );
    assert.equal(executionCapabilityMismatch(capabilities, policy, approved), null);
  }
});

test('CLO-131 deny/local의 hook 부재는 별도 위험이며 push 승인을 대체하지 않는다', () => {
  for (const git_write of ['deny', 'local'] as const) {
    assert.ok(keys(codex, { git_write }).includes('git_write'));
    assert.ok(!keys(codex, { git_write }).includes('git_remote_write'));
    assert.ok(!keys(PROVIDER_CAPABILITY_CEILINGS.CLAUDE_CODE, { git_write }).includes('git_write'));
  }
  const inherited = unenforceableProtections(codex, { git_write: 'local' });
  const current = executionApprovalProtections(codex, { git_write: 'push' }, inherited);
  assert.ok(current.some((p) => p.key === 'git_remote_write'));
  assert.ok(current.some((p) => p.key === 'git_write'));
  assert.ok(
    executionCapabilityMismatch(
      codex,
      { git_write: 'push' },
      inherited.map((p) => p.key),
      inherited.map((p) => p.key),
    ),
  );
});
