import { NextRequest, NextResponse } from 'next/server';
import { mockDb } from '@/lib/mock-data';

type RouteContext = {
  params: Promise<{ slug: string[] }>;
};

function getUserIdFromRequest(request: NextRequest, defaultUserId = 'user_b_id'): string {
  const { searchParams } = new URL(request.url);
  return searchParams.get('userId') || request.headers.get('x-user-id') || defaultUserId;
}

function handleError(err: unknown) {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  let status = 400;
  if (typeof err === 'object' && err !== null && 'status' in err) {
    status = Number((err as { status: number }).status) || 400;
  } else if (message.includes('409:')) {
    status = 409;
  } else if (message.includes('403:')) {
    status = 403;
  } else if (message.includes('not found') || message.includes('404:')) {
    status = 404;
  }
  return NextResponse.json({ message }, { status });
}

// M-5-1: Mock API는 개발 전용이며 프로덕션 환경이거나 명시적으로 NEXT_PUBLIC_API_MODE=mock이 켜져 있지 않으면 403 차단한다.
function assertMockAllowed(): NextResponse | null {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { message: 'Mock API는 프로덕션 환경에서 비활성화되어 있습니다.' },
      { status: 403, headers: { 'X-Baton-Mock-Guard': 'blocked-production' } },
    );
  }
  if (process.env.NEXT_PUBLIC_API_MODE !== 'mock') {
    return NextResponse.json(
      {
        message:
          'Mock API가 비활성화되어 있습니다. mock API를 사용하려면 NEXT_PUBLIC_API_MODE=mock 설정이 필요합니다.',
      },
      { status: 403, headers: { 'X-Baton-Mock-Guard': 'blocked-not-mock-mode' } },
    );
  }
  return null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = assertMockAllowed();
  if (guard) return guard;

  const { slug } = await context.params;
  const path = slug.join('/');
  const { searchParams } = new URL(request.url);

  try {
    // 1. GET /v1/me
    if (path === 'me') {
      const userId = getUserIdFromRequest(request);
      return NextResponse.json(mockDb.getMe(userId));
    }

    // 2. GET /v1/me/devices
    if (path === 'me/devices') {
      const userId = getUserIdFromRequest(request);
      return NextResponse.json(mockDb.getDevices(userId));
    }

    // 3. GET /v1/org
    if (path === 'org') {
      return NextResponse.json(mockDb.getOrg());
    }

    // 4. GET /v1/org/teams
    if (path === 'org/teams') {
      return NextResponse.json(mockDb.getOrgTeams());
    }

    // 5. GET /v1/org/team-links
    if (path === 'org/team-links') {
      return NextResponse.json(mockDb.getOrgTeamLinks());
    }

    // 6. GET /v1/recipients?senderTeamId=
    if (path === 'recipients') {
      const senderTeamId = searchParams.get('senderTeamId') || 'team_backend_id';
      return NextResponse.json(mockDb.getRecipients(senderTeamId));
    }

    // 7. GET /v1/users
    if (path === 'users') {
      return NextResponse.json(mockDb.users);
    }

    // 8. GET /v1/agents
    if (path === 'agents') {
      return NextResponse.json(mockDb.agents);
    }

    // 9. GET /v1/projects
    if (path === 'projects') {
      return NextResponse.json(mockDb.projects);
    }

    // 10. GET /v1/requests
    if (path === 'requests') {
      const userId = searchParams.get('userId') || undefined;
      const list = mockDb.getRequests(userId);
      return NextResponse.json(list);
    }

    // 11. GET /v1/requests/:id
    if (slug[0] === 'requests' && slug.length === 2) {
      const requestId = slug[1];
      const detail = mockDb.getRequestDetail(requestId);
      if (!detail) {
        return NextResponse.json({ message: 'Request not found' }, { status: 404 });
      }
      return NextResponse.json(detail);
    }

    // 12. GET /v1/requests/:id/timeline
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'timeline') {
      const requestId = slug[1];
      const detail = mockDb.getRequestDetail(requestId);
      return NextResponse.json(detail ? detail.timeline : []);
    }

    // 13. GET /v1/documents/versions/:id (문서 버전 및 본문 조회)
    if (slug[0] === 'documents' && slug[1] === 'versions' && slug.length === 3) {
      const versionId = slug[2];
      const version = mockDb.documentVersions.find((dv) => dv.id === versionId);
      if (!version) {
        return NextResponse.json({ message: 'Document version not found' }, { status: 404 });
      }
      const doc = mockDb.documents.find((d) => d.id === version.documentId);
      return NextResponse.json({
        id: version.id,
        documentId: version.documentId,
        versionNo: version.versionNo,
        name: doc?.name || 'api-error-analysis.md',
        mimeType: doc?.mimeType || 'text/markdown',
        changeNote: version.changeNote,
        content: version.contentRef,
        createdAt: version.createdAt,
        updatedAt: version.updatedAt,
      });
    }

    return NextResponse.json({ message: `Route not found: GET /v1/${path}` }, { status: 404 });
  } catch (err: unknown) {
    return handleError(err);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = assertMockAllowed();
  if (guard) return guard;

  const { slug } = await context.params;
  const path = slug.join('/');

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    // empty body
  }

  try {
    // 1. POST /v1/reset
    if (path === 'reset') {
      mockDb.reset();
      return NextResponse.json({ ok: true, message: 'Mock data reset to initial state' });
    }

    // 2. POST /v1/me/pairing-codes
    if (path === 'me/pairing-codes') {
      const userId = (body.userId as string) || getUserIdFromRequest(request);
      const codeRes = mockDb.createPairingCode(userId);
      return NextResponse.json(codeRes, { status: 201 });
    }

    // 3. POST /v1/org/teams (새 팀 생성)
    if (path === 'org/teams') {
      const name = (body.name as string) || 'New Team';
      const created = mockDb.createOrgTeam(name);
      return NextResponse.json(created, { status: 201 });
    }

    // 4. POST /v1/org/teams/:id/members (팀원 추가)
    if (slug[0] === 'org' && slug[1] === 'teams' && slug.length === 4 && slug[3] === 'members') {
      const teamId = slug[2];
      const email = body.email as string;
      const userId =
        (body.userId as string) ||
        (email ? mockDb.users.find((u) => u.email === email)?.id : undefined);
      const role = (body.role as 'TEAM_LEAD' | 'MEMBER') || 'MEMBER';
      if (!userId) {
        return NextResponse.json({ message: 'User not found' }, { status: 404 });
      }
      const member = mockDb.addTeamMember(teamId, userId, role);
      return NextResponse.json(member, { status: 201 });
    }

    // 5. POST /v1/org/users (사용자 생성)
    if (path === 'org/users') {
      const email = body.email as string;
      const name = (body.displayName as string) || (body.name as string) || email;
      const tempPassword = (body.temporaryPassword as string) || (body.tempPassword as string);
      const user = mockDb.createOrgUser(email, name, tempPassword);
      return NextResponse.json(user, { status: 201 });
    }

    // 6. POST /v1/org/team-links (통신 링크 허용 - direction: 'both' | 'a-to-b' | 'b-to-a')
    if (path === 'org/team-links') {
      const fromTeamId = (body.teamAId as string) || (body.fromTeamId as string);
      const toTeamId = (body.teamBId as string) || (body.toTeamId as string);
      const direction =
        (body.direction as 'both' | 'a-to-b' | 'b-to-a') ||
        (body.bidirectional === false ? 'a-to-b' : 'both');
      const links = mockDb.createOrgTeamLink(fromTeamId, toTeamId, direction);
      return NextResponse.json(links, { status: 201 });
    }

    // 7. POST /v1/requests (새 Request 생성)
    if (path === 'requests') {
      const senderUserId =
        (body.senderUserId as string) || getUserIdFromRequest(request, 'user_a_id');
      const created = mockDb.createRequest(senderUserId, body as never);
      return NextResponse.json(created, { status: 201 });
    }

    // 8. POST /v1/requests/:id/claim (팀 뿌리기 선점)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'claim') {
      const requestId = slug[1];
      const claimerUserId =
        (body.recipientUserId as string) ||
        (body.userId as string) ||
        getUserIdFromRequest(request, 'user_b_id');
      const updated = mockDb.claimRequest(requestId, claimerUserId);
      return NextResponse.json(updated);
    }

    // 9. POST /v1/requests/:id/send (DRAFT 전송)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'send') {
      const requestId = slug[1];
      const senderUserId = (body.senderUserId as string) || 'user_a_id';
      const updated = mockDb.sendRequest(requestId, senderUserId);
      return NextResponse.json(updated);
    }

    // 10. POST /v1/requests/:id/review/start (검토 시작)
    if (
      slug[0] === 'requests' &&
      slug.length === 4 &&
      slug[2] === 'review' &&
      slug[3] === 'start'
    ) {
      const requestId = slug[1];
      const recipientUserId =
        (body.recipientUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      const updated = mockDb.startReview(requestId, recipientUserId);
      return NextResponse.json(updated);
    }

    // 11. POST /v1/requests/:id/accept (수락)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'accept') {
      const requestId = slug[1];
      const recipientUserId =
        (body.recipientUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      const updated = mockDb.acceptRequest(requestId, recipientUserId);
      return NextResponse.json(updated);
    }

    // 12. POST /v1/requests/:id/return (반려)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'return') {
      const requestId = slug[1];
      const recipientUserId =
        (body.recipientUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      const reason = (body.reason as string) || '';
      const updated = mockDb.returnRequest(requestId, recipientUserId, reason);
      return NextResponse.json(updated);
    }

    // 13. POST /v1/requests/:id/reject (거절)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'reject') {
      const requestId = slug[1];
      const recipientUserId =
        (body.recipientUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      const reason = (body.reason as string) || '';
      const updated = mockDb.rejectRequest(requestId, recipientUserId, reason);
      return NextResponse.json(updated);
    }

    // 14. POST /v1/requests/:id/resend (보완 재전송)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'resend') {
      const requestId = slug[1];
      const senderUserId = (body.senderUserId as string) || 'user_a_id';
      const updated = mockDb.resendWithNewRevision(requestId, senderUserId, body as never);
      return NextResponse.json(updated);
    }

    // 15. POST /v1/requests/:id/executions (실행 생성)
    if (slug[0] === 'requests' && slug.length === 3 && slug[2] === 'executions') {
      const requestId = slug[1];
      const executorUserId =
        (body.executorUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      try {
        const execution = mockDb.createExecution(requestId, executorUserId, body as never);
        return NextResponse.json(execution, { status: 201 });
      } catch (err: any) {
        if (err.statusCode === 409) {
          return NextResponse.json(
            {
              statusCode: 409,
              error: err.error || 'Conflict',
              code: err.code || 'execution.unenforceable_protections',
              message: err.message,
              unenforceableProtections: err.unenforceableProtections,
              requiredAcknowledgements: err.requiredAcknowledgements,
              acknowledgedRisks: err.acknowledgedRisks,
            },
            { status: 409 },
          );
        }
        throw err;
      }
    }

    // 16. POST /v1/executions/:id/simulate-step (실행 진행 단계 시뮬레이션)
    if (slug[0] === 'executions' && slug.length === 3 && slug[2] === 'simulate-step') {
      const executionId = slug[1];
      const forceFail = Boolean(body.forceFail);
      const stepResult = mockDb.simulateExecutionStep(executionId, forceFail);
      return NextResponse.json(stepResult);
    }

    // 17. POST /v1/executions/:id/cancel (에이전트 실행 취소)
    if (slug[0] === 'executions' && slug.length === 3 && slug[2] === 'cancel') {
      const executionId = slug[1];
      const cancelResult = mockDb.cancelExecution(executionId);
      return NextResponse.json(cancelResult);
    }

    // 17. POST /v1/results/:id/approve-and-send (결과 승인 및 전달)
    if (slug[0] === 'results' && slug.length === 3 && slug[2] === 'approve-and-send') {
      const resultId = slug[1];
      const reviewedByUserId =
        (body.reviewedByUserId as string) || getUserIdFromRequest(request, 'user_b_id');
      const result = mockDb.approveAndSendResult(resultId, reviewedByUserId);
      return NextResponse.json(result);
    }

    return NextResponse.json({ message: `Route not found: POST /v1/${path}` }, { status: 404 });
  } catch (err: unknown) {
    return handleError(err);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = assertMockAllowed();
  if (guard) return guard;

  const { slug } = await context.params;

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    // empty body
  }

  try {
    // PATCH /v1/org/teams/:id (팀 이름 수정)
    if (slug[0] === 'org' && slug[1] === 'teams' && slug.length === 3) {
      const teamId = slug[2];
      const name = body.name as string;
      const updated = mockDb.updateOrgTeam(teamId, name);
      return NextResponse.json(updated);
    }

    return NextResponse.json(
      { message: `Route not found: PATCH /v1/${slug.join('/')}` },
      { status: 404 },
    );
  } catch (err: unknown) {
    return handleError(err);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = assertMockAllowed();
  if (guard) return guard;

  const { slug } = await context.params;
  const path = slug.join('/');
  const { searchParams } = new URL(request.url);

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    // empty body
  }

  try {
    // 1. DELETE /v1/me/devices/:id
    if (slug[0] === 'me' && slug[1] === 'devices' && slug.length === 3) {
      const deviceId = slug[2];
      const userId = getUserIdFromRequest(request);
      const success = mockDb.deleteDevice(userId, deviceId);
      return NextResponse.json({ success });
    }

    // 2. DELETE /v1/org/teams/:id/members (body: { email }) or /:userId
    if (slug[0] === 'org' && slug[1] === 'teams' && slug[3] === 'members') {
      const teamId = slug[2];
      let memberUserId = slug.length === 5 ? slug[4] : undefined;
      if (!memberUserId) {
        const email = body.email as string;
        memberUserId =
          (body.userId as string) ||
          (email ? mockDb.users.find((u) => u.email === email)?.id : undefined);
      }
      if (memberUserId) {
        mockDb.removeTeamMember(teamId, memberUserId);
      }
      return NextResponse.json({ success: true });
    }

    // 3. DELETE /v1/org/teams/:id (팀 삭제)
    if (slug[0] === 'org' && slug[1] === 'teams' && slug.length === 3) {
      const teamId = slug[2];
      const success = mockDb.deleteOrgTeam(teamId);
      return NextResponse.json({ success });
    }

    // 4. DELETE /v1/org/team-links/:id
    if (slug[0] === 'org' && slug[1] === 'team-links' && slug.length === 3) {
      const linkId = slug[2];
      const success = mockDb.deleteOrgTeamLink(linkId);
      return NextResponse.json({ success });
    }

    // 5. DELETE /v1/org/team-links
    if (path === 'org/team-links') {
      const fromTeamId = (body.fromTeamId as string) || searchParams.get('fromTeamId');
      const toTeamId = (body.toTeamId as string) || searchParams.get('toTeamId');
      const directionParam = (body.direction as string) || searchParams.get('direction');
      const bidirectional =
        directionParam === 'both' ||
        (directionParam !== 'a-to-b' &&
          directionParam !== 'b-to-a' &&
          body.bidirectional !== false &&
          searchParams.get('bidirectional') !== 'false');
      const direction =
        (directionParam as 'both' | 'a-to-b' | 'b-to-a') || (bidirectional ? 'both' : 'a-to-b');

      if (!fromTeamId || !toTeamId) {
        return NextResponse.json(
          { message: 'fromTeamId and toTeamId are required' },
          { status: 400 },
        );
      }
      const success = mockDb.deleteOrgTeamLink(fromTeamId, toTeamId, direction);
      return NextResponse.json({ success });
    }

    return NextResponse.json({ message: `Route not found: DELETE /v1/${path}` }, { status: 404 });
  } catch (err: unknown) {
    return handleError(err);
  }
}
