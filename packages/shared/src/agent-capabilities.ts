import { z } from 'zod';
import { AgentModelsSchema } from './agent-models';

export const AgentProviderSchema = z.enum(['CLAUDE_CODE', 'CODEX', 'AGY']);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

// 설계 06 §2.2의 이름을 사용한다. 일부만 보고하여 지원 여부를 오인하지 않도록 전체 객체를 검증한다.
export const AgentCapabilitiesSchema = z.object({
  supportsResume: z.boolean(),
  supportsStructuredProgress: z.boolean(),
  supportsCancel: z.boolean(),
  supportsLayer1Patch: z.boolean(),
  securityTier: z.enum(['tier_a_hardened', 'tier_b_sandboxed', 'tier_c_unrestricted']),
  supportedPolicyEnforcements: z.object({
    toolDeny: z.boolean(),
    networkDeny: z.boolean(),
    destructiveCommandDeny: z.boolean(),
    credentialPathDeny: z.boolean(),
  }),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/**
 * CLO-110(보안 검토 H-2-1): provider 별 capability 상한.
 *
 * `capabilities` 는 데몬의 자기 선언이고 서버에는 상한이 없었다. 과대 선언 한 번이면
 * 강제 불가 항목이 통째로 사라져 승인 화면 자체가 뜨지 않는다(보안 검토 §2 H-2, probe C).
 * 그래서 설계 06 §4.4 의 **실측 선언값을 그대로 상한**으로 둔다.
 *
 * - 데몬이 상한보다 **낮게** 선언하는 것은 허용한다. 정직한 하향은 안전한 방향이고 항목이 늘 뿐이다.
 * - 상한보다 **높게** 선언한 값만 깎는다. CODEX 가 credentialPathDeny=true 를 보내도 서버는 false 로 본다.
 * - 표에 없는 provider 의 상한은 전부 false·tier_c 다. 새 provider 는 실측으로 이 표를 갱신하기 전까지
 *   어떤 강제 능력도 인정받지 못한다(fail-closed).
 *
 * AGY 의 tier 는 CLO-109 통합 인수에서 tier_c 로 재판정한 값을 쓴다(설계 06 §3.3 ②).
 */
export const PROVIDER_CAPABILITY_CEILINGS: Record<AgentProvider, AgentCapabilities> = {
  CLAUDE_CODE: {
    supportsResume: true,
    supportsStructuredProgress: true,
    supportsCancel: true,
    supportsLayer1Patch: true,
    securityTier: 'tier_a_hardened',
    supportedPolicyEnforcements: {
      toolDeny: true,
      networkDeny: true,
      destructiveCommandDeny: true,
      credentialPathDeny: true,
    },
  },
  CODEX: {
    supportsResume: true,
    supportsStructuredProgress: true,
    supportsCancel: true,
    supportsLayer1Patch: false,
    securityTier: 'tier_b_sandboxed',
    supportedPolicyEnforcements: {
      toolDeny: false,
      // sandbox_workspace_write.network_access=false 로 실제 차단을 확인한 값만 true 다(설계 06 §4.4).
      networkDeny: true,
      destructiveCommandDeny: false,
      credentialPathDeny: false,
    },
  },
  AGY: {
    supportsResume: true,
    supportsStructuredProgress: true,
    supportsCancel: true,
    supportsLayer1Patch: false,
    securityTier: 'tier_c_unrestricted',
    supportedPolicyEnforcements: {
      toolDeny: false,
      networkDeny: false,
      destructiveCommandDeny: false,
      credentialPathDeny: false,
    },
  },
};

/** 표에 없는 provider 의 상한. 어떤 강제 능력도 인정하지 않는다. */
const UNKNOWN_PROVIDER_CEILING: AgentCapabilities = {
  supportsResume: false,
  supportsStructuredProgress: false,
  supportsCancel: false,
  supportsLayer1Patch: false,
  securityTier: 'tier_c_unrestricted',
  supportedPolicyEnforcements: {
    toolDeny: false,
    networkDeny: false,
    destructiveCommandDeny: false,
    credentialPathDeny: false,
  },
};

export function providerCapabilityCeiling(provider: string): AgentCapabilities {
  const known = AgentProviderSchema.safeParse(provider);
  return known.success ? PROVIDER_CAPABILITY_CEILINGS[known.data] : UNKNOWN_PROVIDER_CEILING;
}

// 격리가 강한 쪽이 큰 값이다. 상한은 min(선언, 상한) 이므로 더 강한 등급을 주장하면 깎인다.
const SECURITY_TIER_RANK: Record<AgentCapabilities['securityTier'], number> = {
  tier_c_unrestricted: 0,
  tier_b_sandboxed: 1,
  tier_a_hardened: 2,
};

/**
 * 데몬이 선언한 capability 를 provider 상한으로 깎는다.
 * 깎인 필드는 `overDeclared` 에 경로로 담아 돌려준다 — 호출자가 로그로 남겨 이상 징후로 본다.
 */
export function clampAgentCapabilities(
  provider: string,
  declared: AgentCapabilities,
): { capabilities: AgentCapabilities; overDeclared: string[] } {
  const ceiling = providerCapabilityCeiling(provider);
  const overDeclared: string[] = [];
  const flag = <
    K extends
      'supportsResume' | 'supportsStructuredProgress' | 'supportsCancel' | 'supportsLayer1Patch',
  >(
    key: K,
  ) => {
    if (declared[key] && !ceiling[key]) overDeclared.push(key);
    return declared[key] && ceiling[key];
  };
  const enforcement = <K extends keyof AgentCapabilities['supportedPolicyEnforcements']>(
    key: K,
  ) => {
    const allowed =
      declared.supportedPolicyEnforcements[key] && ceiling.supportedPolicyEnforcements[key];
    if (declared.supportedPolicyEnforcements[key] && !allowed)
      overDeclared.push(`supportedPolicyEnforcements.${key}`);
    return allowed;
  };
  const securityTier =
    SECURITY_TIER_RANK[declared.securityTier] > SECURITY_TIER_RANK[ceiling.securityTier]
      ? ceiling.securityTier
      : declared.securityTier;
  if (securityTier !== declared.securityTier) overDeclared.push('securityTier');
  return {
    capabilities: {
      supportsResume: flag('supportsResume'),
      supportsStructuredProgress: flag('supportsStructuredProgress'),
      supportsCancel: flag('supportsCancel'),
      supportsLayer1Patch: flag('supportsLayer1Patch'),
      securityTier,
      supportedPolicyEnforcements: {
        toolDeny: enforcement('toolDeny'),
        networkDeny: enforcement('networkDeny'),
        destructiveCommandDeny: enforcement('destructiveCommandDeny'),
        credentialPathDeny: enforcement('credentialPathDeny'),
      },
    },
    overDeclared,
  };
}

/**
 * 저장된 선언값을 실제로 쓸 값으로 바꾼다.
 * 스키마 검증 → provider 상한 clamp 순서다. 저장 시점에 이미 깎였더라도(권장) 여기서 한 번 더 깎아
 * 옛 행·직접 DB 수정·상한 표 갱신 뒤의 행까지 같은 규칙을 받게 한다.
 */
export function effectiveAgentCapabilities(
  provider: string,
  capabilities: unknown,
): AgentCapabilities {
  const parsed = AgentCapabilitiesSchema.safeParse(capabilities);
  if (parsed.success) return clampAgentCapabilities(provider, parsed.data).capabilities;
  // 기존 Claude Code의 null 필드만 하위 호환한다. 새 provider·잘못된 저장값은 지원을 추정하지 않는다.
  const legacy = provider === 'CLAUDE_CODE' && capabilities == null;
  return {
    supportsResume: legacy,
    supportsStructuredProgress: legacy,
    supportsCancel: legacy,
    supportsLayer1Patch: legacy,
    securityTier: legacy ? 'tier_a_hardened' : 'tier_c_unrestricted',
    supportedPolicyEnforcements: {
      toolDeny: legacy,
      networkDeny: legacy,
      destructiveCommandDeny: legacy,
      credentialPathDeny: legacy,
    },
  };
}

export const RegisterAgentSchema = z.object({
  provider: AgentProviderSchema.default('CLAUDE_CODE'),
  displayName: z.string().trim().min(1).max(120).optional(),
  capabilities: AgentCapabilitiesSchema.optional(),
  // 쓸 수 있는 모델. capability 와 달리 보안 상한이 없는 정보성 값이라 clamp 하지 않는다.
  models: AgentModelsSchema.optional(),
});
export type RegisterAgent = z.infer<typeof RegisterAgentSchema>;
