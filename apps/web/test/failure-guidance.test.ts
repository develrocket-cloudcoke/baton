import assert from 'node:assert/strict';
import test from 'node:test';
import { canPrepareExecution, failureGuidance } from '../lib/failure-guidance';

test('실패 코드별 해결 방법과 알 수 없는 코드의 재시도 안내', () => {
  assert.match(failureGuidance('project_not_git'), /git 저장소로 만들기/);
  assert.match(failureGuidance('project_not_git'), /Claude Code/);
  assert.match(failureGuidance('git_missing'), /xcode-select --install/);
  for (const code of [undefined, null, 'future_code']) {
    assert.match(failureGuidance(code), /다시 실행/);
  }
});

test('FAILED도 새 설정으로 실행할 수 있지만 활성 실행 중에는 폼을 열지 않는다', () => {
  for (const state of ['ACCEPTED', 'READY_TO_RUN', 'FAILED']) {
    assert.equal(canPrepareExecution(state, false, true), true);
    assert.equal(canPrepareExecution(state, true, true), false);
  }
  assert.equal(canPrepareExecution('FAILED', false, false), false);
  for (const state of ['DRAFT', 'RUNNING', 'RESULT_REVIEW', 'COMPLETED', 'REJECTED']) {
    assert.equal(canPrepareExecution(state, false, true), false);
  }
});
