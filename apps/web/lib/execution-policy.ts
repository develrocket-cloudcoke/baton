import { DEFAULT_STRUCTURED_POLICY, StructuredPolicy } from './types';

// 재실행·추가 작업은 실행 준비 화면을 거치지 않는다. 그렇다고 클라이언트가 정책을
// 지어내면 사람이 1회차에 승인한 권한이 예고 없이 리셋된다(전수조사 결함 4).
// 이전 실행이 실제로 쓴 정책을 읽어 그대로 물려주고, 못 읽으면 **아무것도 보내지 않는다**.
//
// 정책이 남는 곳은 Execution 의 컬럼이 아니라 agentCapabilitiesSnapshot.policy 다
// (CLO-110 M-6-1 스냅샷). 서버가 실행 시점에 파싱한 값을 그대로 담아 둔 곳이라
// "그때 무엇으로 돌았는가" 의 유일한 기록이다.

const ALLOWED: { [K in keyof StructuredPolicy]: ReadonlyArray<StructuredPolicy[K]> } = {
  git_write: ['deny', 'local', 'push'],
  repository_edit: ['allow', 'deny'],
  deployment_apply: ['deny', 'allow'],
  network_outbound: ['deny', 'allow'],
  outside_write: ['deny', 'allow'],
  shell_execution: ['allow', 'deny', 'read_only'],
};

const POLICY_KEYS = Object.keys(ALLOWED) as Array<keyof StructuredPolicy>;

const LABELS: Record<keyof StructuredPolicy, string> = {
  git_write: 'Git 쓰기',
  repository_edit: '로컬 파일 수정',
  deployment_apply: '운영/클러스터 배포',
  network_outbound: '외부 네트워크 통신',
  outside_write: '프로젝트 외 쓰기',
  shell_execution: '셸 명령 실행',
};

const VALUE_LABELS: Record<string, string> = {
  deny: '금지',
  local: '로컬까지',
  push: '원격 푸시까지',
  allow: '허용',
  read_only: '읽기 전용',
};

/**
 * 이전 실행이 실제로 쓴 정책. 여섯 항목이 모두 유효할 때만 돌려준다.
 *
 * 한 항목이라도 비거나 모르는 값이면 **기본값으로 메우지 않고 null** 이다.
 * 반쯤 읽은 정책을 기본값으로 채우면 사람이 승인한 적 없는 조합이 만들어지는데,
 * 그건 지금 고치려는 결함과 같은 종류다.
 */
export function policyFromExecution(execution: unknown): StructuredPolicy | null {
  const snapshot = (execution as any)?.agentCapabilitiesSnapshot;
  const raw = snapshot?.policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const policy: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (!(ALLOWED[key] as ReadonlyArray<unknown>).includes(value)) return null;
    policy[key] = value;
  }
  return policy as unknown as StructuredPolicy;
}

export interface PolicyDifference {
  key: keyof StructuredPolicy;
  label: string;
  value: string;
}

/**
 * 기본 정책과 다른 항목만. 사람에게 보여 줄 것은 "무엇이 특별히 허용돼 있는가" 뿐이고,
 * 여섯 줄을 다 늘어놓으면 오히려 읽히지 않는다.
 */
export function policyDifferencesFromDefault(policy: StructuredPolicy | null): PolicyDifference[] {
  if (!policy) return [];
  return POLICY_KEYS.filter((key) => policy[key] !== DEFAULT_STRUCTURED_POLICY[key]).map((key) => ({
    key,
    label: LABELS[key],
    value: VALUE_LABELS[policy[key]] ?? policy[key],
  }));
}

/** 재실행·추가 작업 버튼 옆에 붙일 한 줄. 무엇으로 돌지 누르기 전에 보여 준다. */
export function inheritedPolicyNotice(policy: StructuredPolicy | null): string {
  if (!policy)
    return '이전 실행의 정책을 읽을 수 없어 서버 기본 정책으로 실행합니다. 권한을 직접 고르려면 실행 준비 화면에서 시작하세요.';
  const differences = policyDifferencesFromDefault(policy);
  if (!differences.length) return '이전 실행과 같은 정책으로 실행합니다 (기본 정책).';
  return `이전 실행에서 승인한 정책을 그대로 씁니다 — ${differences
    .map((item) => `${item.label} ${item.value}`)
    .join(', ')}`;
}
