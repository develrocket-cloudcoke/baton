import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLabel } from '../lib/agent-label';

test('제공자 표시는 실행 제공자를 따르고 모르면 중립 이름을 사용한다', () => {
  assert.equal(agentLabel('CLAUDE_CODE'), 'Claude Code');
  assert.equal(agentLabel('CODEX'), 'Codex');
  assert.equal(agentLabel('AGY'), 'Antigravity');
  for (const value of [null, undefined, '', 'UNKNOWN']) {
    assert.equal(agentLabel(value), 'AI 에이전트');
  }
});
