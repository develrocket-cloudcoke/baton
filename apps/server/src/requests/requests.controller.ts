import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { RequestsService } from './requests.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  WithdrawRequestSchema,
  CreateRequestSchema,
  CreateRevisionSchema,
  CreateDelegationSchema,
  DiscardResultSchema,
  ResendRequestSchema,
  RejectRequestSchema,
  ReturnRequestSchema,
  UpdateDraftSchema,
  RequestState,
  TimelineEventType,
} from '@baton/shared';
@ApiTags('requests')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '발신 팀 소속·조직 경계·방향성 링크·수신 팀원 검증 실패' })
@ApiConflictResponse({ description: '이미 다른 팀원이 처리 중 또는 유효하지 않은 상태 전이' })
@Controller('v1/requests')
export class RequestsController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(RequestsService) private requests: RequestsService,
  ) {}
  private async user(h?: string) {
    return (await this.auth.current(h)).sub;
  }
  @ApiBody({
    schema: {
      type: 'object',
      required: ['senderTeamId', 'recipientTeamId', 'title', 'originalInstruction'],
      properties: {
        senderTeamId: { type: 'string', format: 'uuid' },
        recipientTeamId: { type: 'string', format: 'uuid' },
        recipientUserId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          description: '생략 또는 null이면 팀 전체 전달',
        },
        title: { type: 'string' },
        originalInstruction: { type: 'string' },
        documentVersionIds: { type: 'array', items: { type: 'string' } },
        artifactIds: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @Post()
  create(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(CreateRequestSchema)) b: any,
  ) {
    return this.user(h).then((u) => this.requests.create(u, b));
  }
  @Post(':id/withdraw')
  withdraw(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(WithdrawRequestSchema)) body: { reason?: string },
  ) {
    return this.user(h).then((u) => this.requests.withdraw(u, id, body.reason));
  }
  @Post(':id/delegations')
  delegate(@Headers('authorization') h: string, @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateDelegationSchema)) body: any) {
    return this.user(h).then((u) => this.requests.delegate(u, id, body));
  }

  @ApiOperation({ summary: 'inbox: 본인 지정 및 팀 전달 요청, recipientTeam과 claimedBy 포함' })
  @Get()
  list(@Headers('authorization') h: string, @Query('box') box?: string) {
    return this.user(h).then((u) => this.requests.list(u, box));
  }
  @ApiOperation({
    summary:
      '요청 상세: executions[].agent에 provider·정규화 capabilities 포함, executions 및 results 생성 오름차순, result/latestResult는 최신 실행 결과(실행 중 null), 이전 결과는 results에 보존',
    description:
      'CLO-110(H-1-3): 발신자에게 나가는 응답에서는 수신자의 비공개 정보를 지운다. executions[].additionalInstruction은 빈 문자열, executions[].agentCapabilitiesSnapshot은 null이 되고 executions[].additionalInstructionRedacted=true가 붙는다. timelineEvents의 execution.command_requested·execution.follow_up_requested payload에서도 additionalInstruction/followUpInstruction을 같은 방식으로 지운다. 확정 수신자와 수신 팀원은 원문을 그대로 본다.',
  })
  @Get(':id')
  detail(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.user(h).then((u) => this.requests.detail(u, id));
  }
  @Patch(':id/draft') draft(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateDraftSchema)) b: any,
  ) {
    return this.user(h).then((u) => this.requests.updateDraft(u, id, b));
  }
  @Post(':id/send') send(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.user(h).then((u) =>
      this.requests.transition(u, id, RequestState.SENT, TimelineEventType.REQUEST_SENT),
    );
  }
  @Post(':id/revisions') rev(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateRevisionSchema)) b: any,
  ) {
    return this.user(h).then((u) => this.requests.revision(u, id, b));
  }
  @ApiOperation({
    summary:
      '새 revision 재전송: team은 반려된 팀 전달 요청의 claim을 해제하고 팀 전체에 다시 전달 (사람 지정은 400)',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        reassign: { type: 'string', enum: ['same', 'team'], default: 'same' },
      },
    },
  })
  @Post(':id/resend')
  resend(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResendRequestSchema)) body: any,
  ) {
    return this.user(h).then((u) =>
      this.requests.transition(
        u,
        id,
        RequestState.SENT,
        TimelineEventType.REQUEST_RESENT,
        undefined,
        body.reassign,
      ),
    );
  }
  @Post(':id/review/start') review(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.user(h).then((u) => this.requests.startReview(u, id));
  }
  @ApiOperation({ summary: '미확정 팀 요청은 첫 처리자에게 원자적으로 claim, 이후 팀원은 409' })
  @Post(':id/accept')
  accept(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.user(h).then((u) =>
      this.requests.transition(u, id, RequestState.ACCEPTED, TimelineEventType.REQUEST_ACCEPTED),
    );
  }
  @ApiOperation({
    summary: '미확정 팀 요청은 첫 처리자에게 원자적으로 claim, 이후 팀원은 409',
    description:
      'CLO-141: 결과 검토(RESULT_REVIEW)에서도 반려할 수 있다. discloseResult=true 면 그 회차의 result.md 아티팩트 한 건만 요청자에게 연다(기본 false).',
  })
  @Post(':id/return')
  returned(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReturnRequestSchema)) b: any,
  ) {
    return this.user(h).then((u) =>
      this.requests.transition(
        u,
        id,
        RequestState.RETURNED,
        TimelineEventType.REQUEST_RETURNED,
        b.reason,
        'same',
        b.discloseResult === true,
      ),
    );
  }
  @ApiOperation({
    summary: 'CLO-141: 결과를 버리고 실행 설정부터 다시 한다 (RESULT_REVIEW → ACCEPTED)',
    description:
      '요청은 살아 있다. 실행자 컴퓨터의 파일 변경은 되돌리지 않으며 result.discarded 이벤트의 changedFiles 로 무엇이 남았는지 남긴다.',
  })
  @Post(':id/discard-result')
  discardResult(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DiscardResultSchema)) b: any,
  ) {
    return this.user(h).then((u) => this.requests.discardResult(u, id, b?.reason));
  }
  @ApiOperation({ summary: '미확정 팀 요청은 첫 처리자에게 원자적으로 claim, 이후 팀원은 409' })
  @Post(':id/reject')
  reject(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectRequestSchema)) b: any,
  ) {
    return this.user(h).then((u) =>
      this.requests.transition(
        u,
        id,
        RequestState.REJECTED,
        TimelineEventType.REQUEST_REJECTED,
        b.reason,
      ),
    );
  }
  @ApiOperation({
    summary: '요청 타임라인',
    description:
      'CLO-110(H-1-3): 발신자에게는 execution.command_requested·execution.follow_up_requested payload의 additionalInstruction/followUpInstruction을 빈 문자열로 지우고 additionalInstructionRedacted=true를 붙인다.',
  })
  @Get(':id/timeline')
  timeline(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.user(h).then((u) => this.requests.timeline(u, id));
  }
}
