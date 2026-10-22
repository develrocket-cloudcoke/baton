import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET, POST } from '../app/api/mock/v1/[...slug]/route';
import { mockDb } from '../lib/mock-data';
import { RequestState } from '../lib/types';

test('M-5-1: Mock API 라우트 가드 - NEXT_PUBLIC_API_MODE !== "mock" 이면 403 차단', async () => {
  const env = process.env as Record<string, string | undefined>;
  const origMode = env.NEXT_PUBLIC_API_MODE;
  const origNodeEnv = env.NODE_ENV;

  try {
    // 1. NEXT_PUBLIC_API_MODE 미설정 시 기본 차단 (403)
    delete env.NEXT_PUBLIC_API_MODE;
    env.NODE_ENV = 'development';

    const req1 = new NextRequest('http://127.0.0.1:3000/api/mock/v1/me');
    const res1 = await GET(req1, { params: Promise.resolve({ slug: ['me'] }) });
    assert.equal(res1.status, 403);
    assert.equal(res1.headers.get('X-Baton-Mock-Guard'), 'blocked-not-mock-mode');

    // 2. NEXT_PUBLIC_API_MODE=real 일 때 차단 (403)
    env.NEXT_PUBLIC_API_MODE = 'real';
    const req2 = new NextRequest('http://127.0.0.1:3000/api/mock/v1/me');
    const res2 = await GET(req2, { params: Promise.resolve({ slug: ['me'] }) });
    assert.equal(res2.status, 403);
    assert.equal(res2.headers.get('X-Baton-Mock-Guard'), 'blocked-not-mock-mode');

    // 3. NODE_ENV=production 일 때 mock 설정되어 있어도 차단 (403)
    env.NEXT_PUBLIC_API_MODE = 'mock';
    env.NODE_ENV = 'production';
    const req3 = new NextRequest('http://127.0.0.1:3000/api/mock/v1/me');
    const res3 = await GET(req3, { params: Promise.resolve({ slug: ['me'] }) });
    assert.equal(res3.status, 403);
    assert.equal(res3.headers.get('X-Baton-Mock-Guard'), 'blocked-production');

    // 4. 개발 환경에서 NEXT_PUBLIC_API_MODE=mock 일 때만 정상 통과 (200)
    env.NEXT_PUBLIC_API_MODE = 'mock';
    env.NODE_ENV = 'development';
    const req4 = new NextRequest('http://127.0.0.1:3000/api/mock/v1/me');
    const res4 = await GET(req4, { params: Promise.resolve({ slug: ['me'] }) });
    assert.equal(res4.status, 200);
  } finally {
    if (origMode !== undefined) env.NEXT_PUBLIC_API_MODE = origMode;
    else delete env.NEXT_PUBLIC_API_MODE;
    if (origNodeEnv !== undefined) env.NODE_ENV = origNodeEnv;
    else delete env.NODE_ENV;
  }
});

test('M-5-1: mockDb.createExecution 수신자 권한 검증 (403)', () => {
  // recipientUserId 가 user_b_id 인 요청 찾기
  const targetReq = mockDb.requests.find((r) => r.recipientUserId === 'user_b_id');
  assert.ok(targetReq, 'user_b_id 대상 요청이 존재해야 함');

  // 요청 상태를 ACCEPTED 로 설정하여 실행 가능 상태로 맞춤
  const origState = targetReq.state;
  targetReq.state = RequestState.ACCEPTED;

  try {
    const dto = {
      agentId: mockDb.agents[0].id,
      projectId: mockDb.projects[0].id,
      additionalInstruction: '테스트 지시사항',
      policy: {},
      acknowledgedRisks: [],
    };

    // 타인(user_c_id)이 실행하려 할 경우 403 거부
    assert.throws(
      () => {
        mockDb.createExecution(targetReq.id, 'user_c_id', dto as any);
      },
      (err: any) => {
        assert.equal(err.status, 403);
        assert.ok(err.message.includes('수신자만 실행을 시작할 수 있습니다'));
        return true;
      },
    );
  } finally {
    targetReq.state = origState;
  }
});
