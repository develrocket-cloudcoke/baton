import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionCommandSchema } from '../src/transport/events';

// 2026-09-21 회귀: 서버가 provider 를 안 실으면 데몬이 "등록된 것 중 첫 번째" 로 추측했고,
// Antigravity 를 골라 실행한 요청이 "Agent 와 명령이 일치하지 않습니다" 로 실패했다.
// 명령에 provider 가 없어도 agentId 로 되짚어야 한다.
test('실행 명령 라우팅: provider 가 없으면 agentId 로 provider 를 되짚는다', () => {
  const agents: Record<string, string> = {
    CLAUDE_CODE: 'agent-claude',
    CODEX: 'agent-codex',
    AGY: 'agent-agy',
  };
  const resolve = (cmd: { provider?: string; agentId?: string }) => {
    const byAgentId = cmd.agentId
      ? Object.entries(agents).find(([, id]) => id === cmd.agentId)?.[0]
      : undefined;
    return cmd.provider ?? byAgentId ?? Object.keys(agents)[0];
  };

  assert.equal(resolve({ agentId: 'agent-agy' }), 'AGY', '구버전 서버(provider 없음)');
  assert.equal(resolve({ agentId: 'agent-codex' }), 'CODEX');
  assert.equal(resolve({ provider: 'AGY', agentId: 'agent-agy' }), 'AGY');
  // 명령이 provider 를 주면 그게 우선이다. 어긋나면 호출자가 실패로 처리한다.
  assert.equal(resolve({ provider: 'CODEX', agentId: 'agent-agy' }), 'CODEX');
  assert.equal(resolve({}), 'CLAUDE_CODE', '아무 단서도 없을 때만 첫 등록');
});

// 서버가 보내는 provider 를 데몬 스키마가 받는지도 함께 고정한다.
test('실행 명령 스키마: provider 를 그대로 받는다', () => {
  const uuid = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  const parsed = ExecutionCommandSchema.parse({
    eventName: 'execution.command.requested',
    eventId: uuid('1'),
    executionId: uuid('2'),
    requestId: uuid('3'),
    requestRevisionId: uuid('4'),
    agentId: uuid('5'),
    projectId: uuid('6'),
    originalInstruction: '',
    additionalInstruction: '',
    provider: 'AGY',
  });
  assert.equal(parsed.provider, 'AGY');
});
