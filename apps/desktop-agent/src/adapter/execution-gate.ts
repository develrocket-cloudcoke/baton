import { executionCapabilityMismatch } from '@baton/shared';
import type { AgentAdapter, AgentRunner } from './interface';

// 보안 검토 §4: 승인 키가 개별 제약을 해제하지 않는다. 로컬 getCapabilities()로
// 전체 목록을 다시 계산한 뒤 서버가 승인한 집합과 일치할 때만 실제 러너를 호출한다.
// 예외의 구조화된 JSON은 데몬의 기존 FAILED 결과 보고를 통해 서버에 전달된다.
export function independentlyGatedRunner(adapter: Pick<AgentAdapter, 'getCapabilities'>, runner: AgentRunner): AgentRunner {
  return {
    get isCancelled() { return runner.isCancelled; },
    cancel: (graceMs) => runner.cancel(graceMs),
    interrupt: () => runner.interrupt(),
    async run(ctx, callbacks) {
      if (ctx.policy.approval_mode === 'ask' && adapter.getCapabilities().provider !== 'CLAUDE_CODE') {
        throw new Error('execution.approval_unsupported: 이 provider는 실행 중 승인을 지원하지 않습니다.');
      }
      const mismatch = executionCapabilityMismatch(adapter.getCapabilities(), ctx.policy,
        ctx.acknowledgedRisks, ctx.resumeSessionId ? ctx.inheritedRiskKeys : []);
      // failureReason 은 기계가 읽는 JSON 그대로 둔다(서버·테스트가 code 로 분기한다).
      // 사람이 읽을 문장은 같은 객체 안에 message 로 넣고 화면이 그것만 보여 준다.
      if (mismatch) throw new Error(JSON.stringify({ ...mismatch, message: describeMismatch(mismatch) }));
      return runner.run(ctx, callbacks);
    }
  };
}

/**
 * 원인을 사람이 읽을 수 있는 한 문장으로 만든다.
 *
 * 예전에는 키 배열 JSON 만 던져서 "왜 실패했는지" 를 읽을 수 없었다.
 *
 * 원인을 한 가지로 단정하지 않는다. 서버가 더 많이 승인해 보내는 경우가 둘인데
 * (① 데몬이 낡아 그 키를 모른다 ② 서버가 이 실행에 필요 없는 승인을 섞었다),
 * 데몬 쪽에서는 구분할 수 없다. 실제로 ②(다른 에이전트로 넘길 때 이전 실행의 승인이
 * 딸려 오던 버그)를 ① 로 단정해 "앱을 새로 설치하라" 고 잘못 안내했다 (2026-09-21).
 */
function describeMismatch(m: { localRequiredKeys: string[]; serverApprovedKeys: string[]; inheritedRiskKeys: string[] }): string {
  const local = new Set(m.localRequiredKeys);
  const unknown = m.serverApprovedKeys.filter((key) => !local.has(key));
  if (unknown.length && m.localRequiredKeys.every((key) => m.serverApprovedKeys.includes(key))) {
    return `서버가 승인한 항목(${unknown.join(', ')})이 이 컴퓨터의 판정에는 없습니다. 이 실행에 필요 없는 승인이 섞였거나(예: 다른 에이전트로 넘길 때 이전 실행의 승인이 딸려 오는 경우), 데스크톱 앱이 서버보다 낡아 그 항목을 모르는 경우입니다.`;
  }
  const missing = m.localRequiredKeys.filter((key) => !m.serverApprovedKeys.includes(key));
  if (missing.length) {
    return `이 실행에 필요한 승인(${missing.join(', ')})이 빠졌습니다. 실행 준비 화면에서 항목을 모두 확인하고 다시 실행해 주세요.`;
  }
  return '서버가 승인한 항목과 이 컴퓨터가 계산한 항목이 다릅니다.';
}
