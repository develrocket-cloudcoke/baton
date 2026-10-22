import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransition, RequestState, TransitionActor } from './request-state';

test('sender can send a draft', () => {
  assert.equal(canTransition(RequestState.DRAFT, RequestState.SENT, TransitionActor.SENDER), true);
});

test('recipient cannot execute before acceptance', () => {
  assert.equal(
    canTransition(RequestState.DELIVERED, RequestState.READY_TO_RUN, TransitionActor.RECIPIENT),
    false,
  );
});

test('desktop agent can only start an execution after it is ready', () => {
  assert.equal(
    canTransition(RequestState.READY_TO_RUN, RequestState.RUNNING, TransitionActor.DESKTOP_AGENT),
    true,
  );
  assert.equal(
    canTransition(RequestState.ACCEPTED, RequestState.RUNNING, TransitionActor.DESKTOP_AGENT),
    false,
  );
});

test('returned request is resent by the sender as the same logical request', () => {
  assert.equal(
    canTransition(RequestState.RETURNED, RequestState.SENT, TransitionActor.SENDER),
    true,
  );
});

test('결과 검토의 추가 작업은 수신자만 실행 준비 상태로 요청할 수 있다', () => {
  for (const actor of Object.values(TransitionActor)) {
    assert.equal(
      canTransition(RequestState.RESULT_REVIEW, RequestState.READY_TO_RUN, actor),
      actor === TransitionActor.RECIPIENT,
    );
    assert.equal(canTransition(RequestState.RESULT_REVIEW, RequestState.RUNNING, actor), false);
    assert.equal(canTransition(RequestState.COMPLETED, RequestState.READY_TO_RUN, actor), false);
  }
});
