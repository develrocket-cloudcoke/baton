import { capabilitiesSwagger } from './capabilities-swagger';
import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Sse } from '@nestjs/common';
import { claimDeviceConnection } from './connections';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AgentHeartbeatSchema, RegisterAgentSchema } from '@baton/shared';
import { Observable } from 'rxjs';
import { ExecutionCompletionSchema, ExecutionStatusSchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma.service';
import { DesktopService } from './desktop.service';
import { LiveOutboxEvent, outboxEvents, OUTBOX_REPLAY_WINDOW_MS } from './outbox-events';

@ApiTags('desktop')
@ApiBearerAuth()
@Controller('v1/desktop')
export class DesktopController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DesktopService) private readonly desktop: DesktopService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}
  @Post('installations/register')
  register(
    @Headers('authorization') h: string,
    @Body() body: { name?: string; deviceName?: string },
  ) {
    return this.auth
      .current(h)
      .then((user) =>
        this.desktop.register(user.sub, body.name ?? body.deviceName ?? 'Baton Desktop'),
      );
  }
  @Get('inbox')
  @ApiOperation({ summary: '기기 사용자에게 처리가 필요한 요청 (최대 20건)' })
  inbox(@Headers('authorization') h: string) {
    return this.desktop.inbox(h);
  }
  @Post('heartbeat')
  @ApiOperation({ summary: 'agentId로 보고한 활성 Agent만 갱신, 생략 시 Device만 갱신' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        capabilities: capabilitiesSwagger,
        ...Object.fromEntries(
          ['platform', 'osVersion', 'appVersion', 'hostname', 'agentId'].map((key) => [
            key,
            { type: 'string' },
          ]),
        ),
      },
    },
  })
  heartbeat(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(AgentHeartbeatSchema)) body: any,
  ) {
    return this.desktop.device(h).then((device) => this.desktop.heartbeat(device, body));
  }
  @ApiOperation({
    summary: '디바이스당 SSE 1개, replay 최근24시간·최대500건, 종료 실행 command 제외',
  })
  @ApiResponse({
    status: 200,
    description:
      'SSE request.delivered/request.claimed: {eventName,requestId,recipientTeam:{id,name},recipientUserId:string|null,claimedBy:null|{id,email,displayName},recipientUserIds,title,senderName,revisionNo,webUrl}. 팀 전달은 recipientUserId=null, claim은 확정 id이며 처리자 본인에게는 전송하지 않는다. 취소는 execution.command.cancel_requested {eventName,executionId,requestId}.',
  })
  @Sse('events/stream')
  events(
    @Headers('authorization') h: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<any> {
    return new Observable((subscriber) => {
      let release: (() => void) | undefined;
      let cancelled = false;
      let listener: ((event: LiveOutboxEvent) => void) | undefined;
      void (async () => {
        const device = await this.desktop.device(h);
        if (cancelled) return;
        release = claimDeviceConnection(device.id, {
          notify: (reason, eventName) => {
            subscriber.next({ type: eventName, data: { reason } });
            subscriber.complete();
          },
          // 서버 종료. 제어 이벤트 없이 끝내면 데몬은 평소의 끊김으로 보고 재연결한다.
          end: () => subscriber.complete(),
        });
        const pending: LiveOutboxEvent[] = [];
        let replaying = true;
        listener = (event) => {
          if (event.deviceId !== device.id) return;
          if (replaying) pending.push(event);
          else subscriber.next({ id: event.id, type: event.eventName, data: event.payload });
        };
        outboxEvents.on('created', listener);
        const cursor = lastEventId
          ? await this.prisma.outboxEvent.findFirst({
              where: { id: lastEventId, deviceId: device.id },
            })
          : null;
        const rows = await this.prisma.outboxEvent.findMany({
          where: {
            deviceId: device.id,
            // 24시간·500건으로 재접속 부하를 제한한다. 오래된 작업은 웹에서 재실행한다.
            createdAt: { gte: new Date(Date.now() - OUTBOX_REPLAY_WINDOW_MS) },
            AND: [
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                      ],
                    },
                  ]
                : []),
              {
                OR: [
                  { NOT: { eventName: { startsWith: 'execution.command.' } } },
                  { execution: { status: { in: ['QUEUED', 'RUNNING'] } } },
                ],
              },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 500,
        });
        if (cancelled) return;
        rows.reverse();
        const seen = new Set(rows.map((row) => row.id));
        rows.forEach((row) =>
          subscriber.next({ id: row.id, type: row.eventName, data: row.payload }),
        );
        pending
          .filter((event) => !seen.has(event.id))
          .forEach((event) =>
            subscriber.next({ id: event.id, type: event.eventName, data: event.payload }),
          );
        replaying = false;
        subscriber.next({ type: 'connection.ready', data: { deviceId: device.id } });
      })().catch((error) => subscriber.error(error));
      return () => {
        cancelled = true;
        release?.();
        if (listener) outboxEvents.off('created', listener);
      };
    });
  }
  @ApiOperation({
    summary: '디바이스·provider별 Agent 재사용, capabilities 생략 시 기존값 보존 (신규는 null)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['CLAUDE_CODE', 'CODEX', 'AGY'], default: 'CLAUDE_CODE' },
        displayName: { type: 'string' },
        capabilities: capabilitiesSwagger,
      },
    },
  })
  @Post('agents')
  registerAgent(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(RegisterAgentSchema)) body: any,
  ) {
    return this.desktop.device(h).then((device) => this.desktop.registerAgent(device, body));
  }
  @Patch('agents/:agentId/presence')
  presence(@Headers('authorization') h: string, @Param('agentId') id: string, @Body() body: any) {
    return this.desktop.device(h).then((device) => this.desktop.presence(device, id, body.status));
  }
  @Post('projects')
  registerProject(@Headers('authorization') h: string, @Body() body: any) {
    return this.desktop.device(h).then((device) => this.desktop.registerProject(device, body));
  }
  @ApiOperation({ summary: '실행 시작·진행 보고, sessionId를 Execution.claudeSessionId로 저장' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['RUNNING', 'PROGRESS'] },
        sessionId: { type: 'string', maxLength: 191 },
        phase: { type: 'string' },
        message: { type: 'string' },
      },
    },
  })
  @Post('executions/:executionId/status')
  status(
    @Headers('authorization') h: string,
    @Param('executionId') id: string,
    @Body(new ZodValidationPipe(ExecutionStatusSchema)) body: any,
  ) {
    return this.desktop.device(h).then((device) => this.desktop.status(device.id, id, body));
  }
  @ApiOperation({
    summary: '성공·실패 결과 또는 CANCELLED 부분 결과 저장',
    description:
      'CANCELLED 보고는 취소 API 완료 후 summary/changedFiles/artifactIds(PATCH 포함)를 전송한다. 이미 취소된 실행에 PARTIAL 결과만 upsert하고 Request 상태는 바꾸지 않는다. 부분 결과는 승인 불가.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'CANCELLED'] },
        summary: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        failureReason: { type: 'string' },
        failureCode: { type: 'string', enum: ['project_not_git', 'git_missing'] },
      },
    },
  })
  @Post('executions/:executionId/result')
  result(
    @Headers('authorization') h: string,
    @Param('executionId') id: string,
    @Body(new ZodValidationPipe(ExecutionCompletionSchema)) body: any,
  ) {
    return this.desktop.device(h).then((device) => this.desktop.result(device.id, id, body));
  }
}
