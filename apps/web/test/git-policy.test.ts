import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExecutionPrepareForm } from '../components/execution-prepare-form';
import { RiskAcknowledgementModal } from '../components/risk-acknowledgement-modal';
import { DEFAULT_STRUCTURED_POLICY } from '../lib/types';
import { unenforceableProtections, PROVIDER_CAPABILITY_CEILINGS } from '@baton/shared';

test('실행 준비 정책에 Git 단계 세 개가 있고 기본은 deny다', () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ExecutionPrepareForm, {
          request: {} as any,
          executorUserId: 'executor',
          onSuccess() {},
        }),
      ),
    );
    assert.equal(DEFAULT_STRUCTURED_POLICY.git_write, 'deny');
    assert.equal((html.match(/name="git_write"/g) ?? []).length, 3);
    assert.ok(html.includes('로컬 커밋·브랜치·태그'));
    assert.ok(html.includes('원격 푸시·PR까지 허용'));
    assert.ok(html.includes('value="deny"'));
  } finally {
    client.clear();
  }
});

test('push의 원격 위험은 기존 모달에서 사전 체크 없이 개별 승인을 요구한다', () => {
  const protections = unenforceableProtections(PROVIDER_CAPABILITY_CEILINGS.CLAUDE_CODE, {
    git_write: 'push',
  });
  const html = renderToStaticMarkup(
    React.createElement(RiskAcknowledgementModal, {
      isOpen: true,
      onClose() {},
      onConfirm() {},
      protections,
    }),
  );
  assert.ok(html.includes('risk-item-git_remote_write'));
  assert.ok(html.includes('CI·알림'));
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes('disabled=""'));
  assert.ok(!html.includes('부족한 역량:'));
});
