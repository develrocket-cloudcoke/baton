import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResultReviewView } from '../components/result-review-view';
import { DisclosedResultView } from '../components/disclosed-result-view';
import { RequestState } from '../lib/types';

// CLO-141: 결과 검토의 출구 셋(반려·거절·결과 폐기)과 result.md 공개.

const result: any = {
  id: 'result-1',
  executionId: 'execution-1',
  kind: 'FINAL',
  summary: '요약',
  changedFiles: ['k8s/deployment.yaml'],
  testSummary: null,
  resultDocumentVersionId: null,
  artifactIds: [],
  reviewStatus: 'PENDING',
  reviewedByUserId: null,
  reviewedAt: null,
  sentAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function render(node: React.ReactElement) {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, node));
  } finally {
    client.clear();
  }
}

const review = (props: Record<string, unknown>) =>
  render(
    React.createElement(ResultReviewView, {
      result,
      results: [result],
      executions: [{ id: 'execution-1' } as any],
      reviewedByUserId: 'recipient',
      requestState: RequestState.RESULT_REVIEW,
      onApproved() {},
      onRequestFollowUp() {},
      ...props,
    } as any),
  );

test('결과 검토 화면에 출구 세 개가 승인·추가 작업과 함께 뜬다', () => {
  const html = review({ onReturn() {}, onReject() {}, onDiscard() {} });
  assert.ok(html.includes('data-testid="result-return"'));
  assert.ok(html.includes('data-testid="result-reject"'));
  assert.ok(html.includes('data-testid="result-discard"'));
  // 기존 두 출구가 사라지면 안 된다.
  assert.ok(html.includes('결과 승인 및 A에게 전달'));
  assert.ok(html.includes('Agent에게 추가 작업 요청'));
});

test('출구가 없는 화면(완료 이력 등)에는 버튼을 그리지 않는다', () => {
  const html = review({});
  assert.equal(html.includes('data-testid="result-return"'), false);
  assert.equal(html.includes('data-testid="result-discard"'), false);
  // 콜백을 줘도 이미 승인이 끝난 화면이면 액션 자체가 없다.
  const completed = review({
    isCompleted: true,
    onReturn() {},
    onReject() {},
    onDiscard() {},
  });
  assert.equal(completed.includes('data-testid="result-discard"'), false);
  assert.ok(completed.includes('승인 및 업무 인계 완료'));
});

test('공개된 결과 화면은 result.md 만 다루고 변경 파일·patch 를 약속하지 않는다', () => {
  const html = render(React.createElement(DisclosedResultView, { artifactId: 'artifact-md' }));
  assert.ok(html.includes('data-testid="disclosed-result"'));
  assert.ok(html.includes('result.md'));
  // 무엇이 공개되지 않는지 화면에 적혀 있어야 한다.
  assert.ok(html.includes('공개 대상이 아닙니다'));
});

const page = () => readFileSync(path.join(__dirname, '..', 'app/requests/[id]/page.tsx'), 'utf8');

test('반려 공개 체크박스는 결과 검토에서만 뜨고 기본값이 꺼짐이다', () => {
  const source = page();
  // 상태 초기값이 곧 안전한 쪽이어야 한다. true 로 시작하면 체크를 못 본 사람이 결과를 내보낸다.
  assert.ok(source.includes('const [discloseResult, setDiscloseResult] = useState(false);'));
  assert.ok(source.includes('data-testid="disclose-result"'));
  // 수락 전 반려에는 보여 줄 결과가 없다.
  assert.ok(source.includes('request.state === RequestState.RESULT_REVIEW && ('));
  // 반려가 끝나면 다음 반려를 위해 다시 꺼진다.
  assert.ok(source.includes('setDiscloseResult(false);'));
});

test('폐기는 되돌릴 수 없는 것을 대화상자와 상주 배너 양쪽에서 알린다', () => {
  const source = page();
  // 대화상자: 지금 버리는 회차가 남기는 변경
  assert.ok(source.includes('파일 변경은 그대로 남습니다'));
  assert.ok(source.includes('discardedChangedFiles'));
  // 상주 배너: 폐기한 뒤에도 실행 준비 화면 위에 계속 남는다. 한 번 보여 주고 끝낼 일이 아니다.
  assert.ok(source.includes('data-testid="discarded-leftover-banner"'));
  assert.ok(source.includes("event.eventType === 'result.discarded'"));
  // 되돌리는 방법까지 적는다.
  assert.ok(source.includes('git stash'));
});
