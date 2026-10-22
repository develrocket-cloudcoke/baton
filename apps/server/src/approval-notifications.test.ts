import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { firstValueFrom } from 'rxjs';
import { NotificationsController } from './notifications/notifications.controller';
import { ApprovalsController } from './approvals/approvals.controller';

test('승인 SSE는 실행자이자 확정 수신자만 선택하고 실행 ID를 전달한다', async () => {
  let query: any;
  const event = {
    id: 'event',
    occurredAt: new Date(),
    eventType: 'execution.approval_requested',
    payload: { executionId: 'execution', approvalId: 'approval' },
  };
  const controller = new NotificationsController(
    { current: async () => ({ sub: 'executor' }) } as any,
    {
      timelineEvent: {
        findMany: async (args: any) => {
          query = args;
          return [event];
        },
      },
    } as any,
  );
  const result = await firstValueFrom(controller.events('Bearer user', ''));
  assert.deepEqual(query.where.AND[1].OR[0], {
    execution: { executorUserId: 'executor', request: { recipientUserId: 'executor' } },
    eventType: { in: ['execution.approval_requested', 'execution.approval_decided'] },
  });
  assert.deepEqual(result, { id: event.id, type: event.eventType, data: event.payload });
});

test('웹 승인 조회는 사용자 인증을 거치고 디바이스 인증으로 대체하지 않는다', async () => {
  const calls: unknown[] = [];
  const controller = new ApprovalsController(
    {
      current: async (header: string) => {
        calls.push(header);
        return { sub: 'executor' };
      },
    } as any,
    {
      device: async () => {
        throw new Error('device auth must not run');
      },
    } as any,
    {
      list: async (...args: string[]) => {
        calls.push(args);
        return [];
      },
    } as any,
  );
  assert.deepEqual(await controller.list('Bearer user', 'execution'), []);
  assert.deepEqual(calls, ['Bearer user', ['executor', 'execution']]);
});
