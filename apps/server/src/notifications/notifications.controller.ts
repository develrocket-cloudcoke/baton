import { Controller, Headers, Inject, Sse } from '@nestjs/common';
import { interval, mergeMap, Observable, startWith } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';

// 최초 접속에서 되돌려 줄 범위. 데스크톱 스트림(desktop.controller)과 같은 기준이다.
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_LIMIT = 100;

@Controller('v1')
export class NotificationsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Sse('events')
  events(
    @Headers('authorization') authorization: string,
    @Headers('cookie') cookie: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<any> {
    // 커서를 **전진시킨다**. 예전에는 lastEventId 를 헤더 값으로 고정해 둬서, 1초마다
    // 조건에 맞는 과거 이벤트를 전부 다시 내려보냈다(실측: 15초에 405건). 웹은 이벤트마다
    // 목록 쿼리를 무효화하므로 화면이 조용한데도 요청이 끝없이 나갔고, 브라우저가 붙어 있는
    // 동안 서버는 1초마다 전체 이력을 스캔했다 (2026-09-18 2인 테스트에서 확인).
    //
    // uuid 는 시간순이 아니므로 id 만으로 비교하면 안 된다. occurredAt + id 복합 커서를 쓴다.
    let after: { occurredAt: Date; id: string } | null = null;
    let primed = false;

    return interval(1000).pipe(
      startWith(0),
      mergeMap(async () => {
        const userId = (await this.auth.current(authorization || cookie)).sub;

        if (!primed) {
          primed = true;
          // 클라이언트가 이어받기를 요청했으면 그 지점부터, 아니면 최근 24시간부터 시작한다.
          if (lastEventId) {
            const anchor = await this.prisma.timelineEvent.findUnique({
              where: { id: lastEventId },
              select: { id: true, occurredAt: true },
            });
            if (anchor) after = anchor;
          }
        }

        const selection = [
          {
            execution: { executorUserId: userId, request: { recipientUserId: userId } },
            eventType: { in: ['execution.approval_requested', 'execution.approval_decided'] },
          },
          {
            request: { OR: [{ senderUserId: userId }, { recipientUserId: userId }] },
            eventType: { startsWith: 'result.' },
          },
          { actorUserId: userId, eventType: 'device.paired' },
          {
            eventType: { in: ['request.delivered', 'request.claimed'] },
            payload: { path: '$.recipientUserIds', array_contains: userId },
          },
        ];
        const cursor = after
          ? {
              OR: [
                { occurredAt: { gt: after.occurredAt } },
                { occurredAt: after.occurredAt, id: { gt: after.id } },
              ],
            }
          : { occurredAt: { gte: new Date(Date.now() - REPLAY_WINDOW_MS) } };

        const events = await this.prisma.timelineEvent.findMany({
          where: { AND: [cursor, { OR: selection }] },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          take: REPLAY_LIMIT,
        });
        if (events.length) {
          const last = events[events.length - 1];
          after = { occurredAt: last.occurredAt, id: last.id };
        } else if (!after) {
          // 되돌려 줄 것이 없어도 커서를 세워 둔다. 그러지 않으면 매 초 24시간 창을 다시 스캔한다.
          after = { occurredAt: new Date(), id: '' };
        }

        // 웹은 결과와 상태 이벤트를 SSE로 수신하므로 폴링으로 대체하지 않는다.
        return events.length
          ? events.map((event) => ({ id: event.id, type: event.eventType, data: event.payload }))
          : [{ type: 'keepalive', data: { comment: 'keepalive' } }];
      }),
      mergeMap((items) => items),
    );
  }
}
