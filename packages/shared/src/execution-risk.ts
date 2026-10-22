import { z } from 'zod';
import { AgentCapabilitiesSchema, type AgentCapabilities } from './agent-capabilities';
import { ExecutionPolicySchema } from './desktop-api';

/**
 * CLO-108: 이 Agent 가 "강제할 수 없는 보호" 한 항목.
 *
 * 설계 06 §5.4 의 선택지 B 결정(2026-09-11)에 따른 계약이다.
 * 강제할 수 없는 보호가 있어도 조용히 막지 않는다. 대신 무엇을 못 막는지 항목으로 세어서
 * 사람에게 그대로 보여 주고, 사람이 항목 키를 하나씩 짚어 승인해야 실행한다.
 */
export const UnenforceableProtectionKeySchema = z.enum([
  'credential_path_read',
  'network_outbound',
  'deployment_apply',
  'repository_edit',
  'shell_execution',
  'outside_write',
  'git_write',
  'git_remote_write',
]);
export type UnenforceableProtectionKey = z.infer<typeof UnenforceableProtectionKeySchema>;

export const UnenforceableProtectionSchema = z.object({
  // 승인 시 그대로 되돌려 보내야 하는 기계 판독용 키
  key: UnenforceableProtectionKeySchema,
  // 'critical' 은 되돌릴 수 없는 유출 위험이다. 웹은 이 항목을 나머지와 다르게 강조한다.
  severity: z.enum(['critical', 'high']),
  // 사람이 읽는 한 줄 제목
  title: z.string(),
  // 왜 강제할 수 없는지 (어떤 capability 가 없어서인지 포함)
  description: z.string(),
  // 승인하면 무엇이 일어날 수 있는지
  risk: z.string(),
  // 'baseline' 은 정책과 무관한 기본 안전 기준, 'policy' 는 이번 실행에서 고른 정책 때문에 생긴 항목
  source: z.enum(['baseline', 'policy']),
  // 이 항목을 만든 실행 정책 필드 (baseline 이면 null)
  policyField: z.string().nullable(),
  // 부족한 capability 경로. 명시적 원격 쓰기 위험처럼 역량 부족이 아닌 항목은 빈 문자열.
  missingCapability: z.string(),
});
export type UnenforceableProtection = z.infer<typeof UnenforceableProtectionSchema>;

type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;
/** 정규화 전 정책. 일부 필드를 생략하거나 아예 넘기지 않아도 된다 — 함수가 기본값을 채운다. */
export type ExecutionPolicyInput = z.input<typeof ExecutionPolicySchema> | null | undefined;

/**
 * 요청한 정책과 기본 안전 기준이 요구하는 보호 중 이 Agent 가 강제할 수 없는 것들을 계산한다.
 *
 * 보호 부족은 같은 규칙으로 평가한다: "요구된 보호"인데 "강제 수단이 없다"면 목록에 담는다.
 * 자격증명 읽기 차단은 기본 안전 기준에서 요구한다(기획서 §27).
 * git_write=push는 역량 부족과 별개로 되돌릴 수 없는 원격 부작용을 이 승인 경로에서 확인한다.
 * 서버와 웹이 같은 목록을 보도록 `@baton/shared` 에 두고 양쪽에서 이 함수만 쓴다.
 * 순서는 아래 배열 순서로 고정이다 — 승인 비교는 집합으로 하지만 화면 열거 순서는 항상 같다.
 *
 * CLO-110(보안 검토 M-2): `policy` 를 **함수 안에서** 정규화한다.
 * 예전에는 정규화된 정책을 받는다고 가정했고, 그 보장이 서버 호출부 한 줄에만 있었다.
 * 빈 객체를 넘기면 목록이 줄어드는 게 아니라 *달라졌다* — `deployment_apply` 가 빠지고
 * `shell_execution` 이 들어왔다(`=== 'deny'` 와 `!== 'allow'` 의 비교 방향이 반대라서다).
 * 이제는 누가 무엇을 넘기든 같은 입력 의미면 같은 목록이 나온다. 승인 목록의 결정성이 여기서 보장된다.
 */
export function unenforceableProtections(
  capabilities: AgentCapabilities,
  policyInput: ExecutionPolicyInput | ExecutionPolicy,
): UnenforceableProtection[] {
  const policy = ExecutionPolicySchema.parse(policyInput ?? {});
  const enforcement = capabilities.supportedPolicyEnforcements;
  const items: (UnenforceableProtection & { required: boolean })[] = [
    {
      key: 'credential_path_read',
      severity: 'critical',
      title: '자격증명 파일 읽기 차단',
      description:
        '이 Agent 는 작업 폴더 밖 파일의 읽기를 막을 수단이 없습니다(supportedPolicyEnforcements.credentialPathDeny=false). ' +
        '실행 중인 에이전트가 ~/.aws/credentials, ~/.ssh/id_rsa, ~/.kube/config, ~/.config 아래 CLI 토큰, 프로젝트 밖 .env 파일을 그대로 읽을 수 있습니다. ' +
        'Codex 의 workspace-write 샌드박스가 대표적인 경우로, 작업 폴더 밖 쓰기만 막고 읽기는 열려 있습니다 — 설계 06 §3.3 실측에서 작업 폴더 밖 cat 은 성공하고 touch 만 차단되었습니다.',
      risk:
        '요청자가 보낸 지시나 첨부 문서에 숨어 있는 프롬프트 인젝션 한 번으로, 읽힌 자격증명이 결과 요약·결과 문서·첨부 파일에 실려 요청자에게 그대로 전달될 수 있습니다. ' +
        '유출된 키는 회수할 수 없습니다. 승인하기 전에 이 컴퓨터의 자격증명을 회전할 수 있는지, 요청자를 신뢰할 수 있는지 먼저 확인하십시오.',
      source: 'baseline',
      policyField: null,
      missingCapability: 'supportedPolicyEnforcements.credentialPathDeny',
      required: !enforcement.credentialPathDeny,
    },
    {
      key: 'network_outbound',
      severity: 'high',
      title: '아웃바운드 네트워크 차단',
      description:
        '실행 정책에서 network_outbound=deny 를 골랐지만 이 Agent 는 네트워크를 끊을 수단이 없습니다(supportedPolicyEnforcements.networkDeny=false).',
      risk: '작업 폴더의 소스 코드나 실행 중 읽은 파일 내용이 외부로 전송될 수 있고, 외부에서 받아 온 코드가 그대로 실행될 수 있습니다.',
      source: 'policy',
      policyField: 'network_outbound',
      missingCapability: 'supportedPolicyEnforcements.networkDeny',
      required: policy.network_outbound === 'deny' && !enforcement.networkDeny,
    },
    {
      key: 'deployment_apply',
      severity: 'high',
      title: '배포·파괴적 명령 차단',
      description:
        '실행 정책에서 deployment_apply=deny 를 골랐지만 이 Agent 는 명령 단위로 가로채 막을 지점이 없습니다(supportedPolicyEnforcements.destructiveCommandDeny=false).',
      risk: 'kubectl apply, terraform apply, aws cli 같은 명령이 실제 운영 환경에 적용될 수 있습니다. 적용된 변경은 사람이 직접 롤백해야 합니다.',
      source: 'policy',
      policyField: 'deployment_apply',
      missingCapability: 'supportedPolicyEnforcements.destructiveCommandDeny',
      required: policy.deployment_apply === 'deny' && !enforcement.destructiveCommandDeny,
    },
    {
      key: 'repository_edit',
      severity: 'high',
      title: '저장소 편집 차단',
      description:
        '실행 정책에서 repository_edit=deny 를 골랐지만 이 Agent 는 편집 도구를 차단할 수단이 없습니다(supportedPolicyEnforcements.toolDeny=false).',
      risk: '읽기만 시키려던 실행이 작업 폴더의 파일을 수정하거나 지울 수 있습니다. 커밋되지 않은 변경은 되돌리기 어렵습니다.',
      source: 'policy',
      policyField: 'repository_edit',
      missingCapability: 'supportedPolicyEnforcements.toolDeny',
      required: policy.repository_edit === 'deny' && !enforcement.toolDeny,
    },
    {
      key: 'shell_execution',
      severity: 'high',
      title: '셸 명령 제한',
      description:
        `실행 정책에서 shell_execution=${policy.shell_execution} 를 골랐지만 이 Agent 는 도구 단위 allow/deny 수단이 없어 셸 사용을 제한할 수 없습니다` +
        '(supportedPolicyEnforcements.toolDeny=false).',
      risk: '셸을 금지하거나 읽기 전용으로 묶으려던 실행에서 임의의 명령이 그대로 실행될 수 있습니다.',
      source: 'policy',
      policyField: 'shell_execution',
      missingCapability: 'supportedPolicyEnforcements.toolDeny',
      required: policy.shell_execution !== 'allow' && !enforcement.toolDeny,
    },
    {
      key: 'outside_write',
      severity: 'high',
      title: '작업 폴더 밖 쓰기 차단',
      description:
        '실행 정책에서 outside_write=deny 를 골랐지만 이 Agent 는 securityTier=tier_c_unrestricted 로 등록되어 파일 시스템 격리가 전혀 없습니다.',
      risk: '작업 폴더 밖의 파일이 생성·수정·삭제될 수 있습니다. 홈 디렉터리 설정 파일이나 다른 프로젝트가 영향을 받습니다.',
      source: 'policy',
      policyField: 'outside_write',
      missingCapability: 'securityTier',
      required:
        policy.outside_write === 'deny' && capabilities.securityTier === 'tier_c_unrestricted',
    },
    {
      key: 'git_write',
      severity: 'high',
      title: 'Git 쓰기 단계 제한',
      description: `실행 정책 git_write=${policy.git_write}의 명령 제한을 이 Agent는 강제할 수 없습니다. 명령 차단 hook이 없어 시스템 규약으로만 전달합니다.`,
      risk: '커밋·브랜치·태그·merge/rebase 또는 원격 푸시·PR 생성이 정책 범위를 넘어 실행될 수 있습니다.',
      source: 'policy',
      policyField: 'git_write',
      missingCapability: 'supportedPolicyEnforcements.destructiveCommandDeny',
      required: policy.git_write !== 'push' && !enforcement.destructiveCommandDeny,
    },
    {
      key: 'git_remote_write',
      severity: 'critical',
      title: '원격 푸시·PR 생성 허용',
      description:
        'git_write=push는 실행자의 Git/gh 인증으로 원격 저장소에 변경을 전송하고 PR을 생성할 수 있도록 허용합니다. 자격증명 파일 읽기 차단과 별개로 기존 CLI 인증이 사용될 수 있습니다.',
      risk: '전송된 코드·원격 기록은 회수할 수 없고 CI·알림이 이미 실행될 수 있습니다. 실행자가 대상 저장소와 요청 내용을 신뢰하는지 확인하십시오. 네트워크·자격증명 제한은 이 승인으로 해제되지 않습니다.',
      source: 'policy',
      policyField: 'git_write',
      missingCapability: '',
      // 원격 부작용은 되돌릴 수 없으므로 capability가 충분해도 명시적으로 승인받는다.
      required: policy.git_write === 'push',
    },
  ];
  return items.filter((item) => item.required).map(({ required: _required, ...item }) => item);
}

/**
 * 승인 배열이 서버가 계산한 목록과 정확히 일치하는지 본다.
 * 뭉뚱그린 boolean 승인을 받지 않기 위해, 하나라도 빠지거나 목록에 없는 키가 오거나 중복이 있으면 실패다.
 */
export function acknowledgementMatches(
  required: UnenforceableProtectionKey[],
  acknowledged: string[],
): boolean {
  if (acknowledged.length !== required.length) return false;
  if (new Set(acknowledged).size !== acknowledged.length) return false;
  const needed = new Set<string>(required);
  return acknowledged.every((key) => needed.has(key));
}

/** Execution 에 저장하고 Timeline 에 남기는 승인 기록. 결과 화면이 그대로 읽는다. */
export const ExecutionRiskAcknowledgementSchema = z.object({
  acknowledgedRisks: z.array(UnenforceableProtectionKeySchema),
  protections: z.array(UnenforceableProtectionSchema),
  agentProvider: z.string(),
  securityTier: z.string(),
});
export type ExecutionRiskAcknowledgement = z.infer<typeof ExecutionRiskAcknowledgementSchema>;

/**
 * CLO-110(보안 검토 M-6-1): 실행 시점의 capability 스냅샷.
 *
 * 승인 항목이 **0 건인 실행에도** 남긴다. 예전에는 항목이 0 건이면 `acknowledgedRisks`·타임라인 이벤트가
 * 아예 만들어지지 않아, "capability 가 충분했다"와 "capability 가 조작돼 항목이 사라졌다"가 같은 모습(`null`)이었다.
 * 이 스냅샷이 사후 조사의 단서다 — 그때 서버가 무엇을 근거로 승인을 요구하지 않았는지 읽을 수 있다.
 *
 * `capabilities` 는 서버 상한으로 깎은 뒤 실제 계산에 쓴 값이고, `declaredCapabilities` 는 데몬이 보낸 원본이다.
 * 둘이 다르면 그 실행 시점에 과대 선언이 있었다는 뜻이다.
 */
export const ExecutionCapabilitySnapshotSchema = z.object({
  agentId: z.string(),
  agentProvider: z.string(),
  securityTier: z.string(),
  capabilities: AgentCapabilitiesSchema,
  declaredCapabilities: z.unknown().nullable(),
  overDeclaredCapabilities: z.array(z.string()),
  unenforceableProtectionKeys: z.array(UnenforceableProtectionKeySchema),
  policy: ExecutionPolicySchema,
  capturedAt: z.string(),
});
export type ExecutionCapabilitySnapshot = z.infer<typeof ExecutionCapabilitySnapshotSchema>;

/** 보안 검토 §4·M-3: 이번 능력 판정에 세션에 남은 이전 위험을 합쳐 재승인한다. */
export function executionApprovalProtections(
  capabilities: AgentCapabilities,
  policy: ExecutionPolicyInput,
  inherited: UnenforceableProtection[] = [],
): UnenforceableProtection[] {
  const current = unenforceableProtections(capabilities, policy);
  const keys = new Set(current.map((item) => item.key));
  return [...current, ...inherited.filter((item) => !keys.has(item.key))];
}

/** 데몬은 서버 선언을 재사용하지 않고 로컬 어댑터 능력으로 현재 목록을 독립 계산한다. */
export function executionCapabilityMismatch(
  capabilities: AgentCapabilities,
  policy: ExecutionPolicyInput,
  acknowledged: string[] = [],
  inherited: string[] = [],
): {
  code: 'execution.capability_mismatch';
  localRequiredKeys: string[];
  serverApprovedKeys: string[];
  inheritedRiskKeys: string[];
} | null {
  const local = unenforceableProtections(capabilities, policy).map((item) => item.key);
  const required = [...new Set([...local, ...inherited])];
  const validHistory =
    inherited.every((key) => UnenforceableProtectionKeySchema.safeParse(key).success) &&
    new Set(inherited).size === inherited.length;
  return validHistory &&
    acknowledgementMatches(required as UnenforceableProtectionKey[], acknowledged)
    ? null
    : {
        code: 'execution.capability_mismatch',
        localRequiredKeys: local,
        serverApprovedKeys: acknowledged,
        inheritedRiskKeys: inherited,
      };
}
