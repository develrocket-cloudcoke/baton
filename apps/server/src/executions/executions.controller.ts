import {
  ApiBody,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { CreateExecutionSchema, UnenforceableProtectionKeySchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ExecutionsService } from './executions.service';

const unenforceableProtectionKeys = UnenforceableProtectionKeySchema.options;

@ApiTags('executions')
@ApiBearerAuth()
@ApiConflictResponse({
  description:
    'supportsResume 미지원 추가 작업, supportsCancel 미지원 취소, 강제할 수 없는 보호가 승인되지 않은 실행은 409',
})
@Controller('v1')
export class ExecutionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ExecutionsService) private readonly executions: ExecutionsService,
  ) {}
  private async user(authorization?: string) {
    return (await this.auth.current(authorization)).sub;
  }
  @ApiOperation({
    summary: '실행 및 추가 작업 생성',
    description:
      'RESULT_REVIEW에서는 확정 수신자가 followUpInstruction(또는 additionalInstruction)으로 추가 작업을 생성한다. 새 실행은 QUEUED, 요청은 READY_TO_RUN. previousExecutionId로 직전 실행을 연결하고 outbox에 followUpInstruction/resumeSessionId(null 가능)를 포함한다. ' +
      'CLO-110(M-2): policy는 서버가 ExecutionPolicySchema로 정규화한 뒤 승인 목록을 계산한다. 일부 필드를 생략하거나 policy 자체를 보내지 않아도 기본값이 채워지므로 같은 의미의 입력은 항상 같은 목록을 낸다 — @baton/shared의 unenforceableProtections도 같은 정규화를 함수 안에서 하므로 웹이 미리 계산한 목록과 서버 목록이 어긋나지 않는다. ' +
      'CLO-110(M-6-1): 승인 항목이 0건이어도 실행 시점의 agentCapabilitiesSnapshot을 Execution에 남긴다.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['agentId', 'projectId'],
      properties: {
        agentId: { type: 'string', format: 'uuid' },
        projectId: { type: 'string', format: 'uuid' },
        additionalInstruction: { type: 'string' },
        followUpInstruction: { type: 'string', minLength: 1 },
        policy: { type: 'object' },
        acknowledgedRisks: {
          type: 'array',
          description:
            'CLO-108: 이 Agent가 강제할 수 없는 보호 항목의 키. 409 본문의 requiredAcknowledgements와 정확히 같은 집합이어야 하며, 하나라도 빠지거나 다른 키·중복이 있으면 다시 409다. 뭉뚱그린 boolean 승인은 받지 않는다.',
          items: { type: 'string', enum: unenforceableProtectionKeys },
        },
      },
    },
  })
  @ApiConflictResponse({
    description:
      '강제할 수 없는 보호가 승인되지 않음. 웹은 unenforceableProtections를 그대로 열거하고 사용자가 확인한 키를 acknowledgedRisks로 되돌려 보낸다.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 409 },
        code: { type: 'string', example: 'execution.unenforceable_protections' },
        message: { type: 'string' },
        requiredAcknowledgements: {
          type: 'array',
          items: { type: 'string', enum: unenforceableProtectionKeys },
        },
        acknowledgedRisks: { type: 'array', items: { type: 'string' } },
        unenforceableProtections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'severity', 'title', 'description', 'risk', 'source'],
            properties: {
              key: { type: 'string', enum: unenforceableProtectionKeys },
              // credential_path_read만 critical이다. 웹은 이 항목을 눈에 띄게 다룬다.
              severity: { type: 'string', enum: ['critical', 'high'] },
              title: { type: 'string' },
              description: { type: 'string' },
              risk: { type: 'string' },
              source: { type: 'string', enum: ['baseline', 'policy'] },
              policyField: { type: 'string', nullable: true },
              missingCapability: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @Post('requests/:requestId/executions')
  create(
    @Headers('authorization') h: string,
    @Param('requestId') id: string,
    @Body(new ZodValidationPipe(CreateExecutionSchema)) body: any,
  ) {
    return this.user(h).then((userId) => this.executions.create(userId, id, body));
  }
  @Post('executions/:executionId/cancel')
  @ApiOperation({
    summary: '수신자만 QUEUED/RUNNING 실행 취소: CANCELLED 및 요청 READY_TO_RUN 복귀',
  })
  @ApiConflictResponse({ description: '종료된 실행, 동시 상태 변경 또는 supportsCancel=false' })
  cancel(@Headers('authorization') h: string, @Param('executionId') id: string) {
    return this.user(h).then((userId) => this.executions.cancel(userId, id));
  }
  @ApiOperation({
    summary: '실행 상세',
    description:
      'CLO-110(M-6-1): agentCapabilitiesSnapshot에 실행 시점의 {agentId,agentProvider,securityTier,capabilities(서버 상한 clamp 후),declaredCapabilities(데몬 원본),overDeclaredCapabilities(깎인 필드 경로),unenforceableProtectionKeys,policy,capturedAt}가 담긴다. 승인 항목이 0건이라 acknowledgedRisks·riskAcknowledged*가 null인 실행에도 남으므로 "capability가 충분했다"와 "과대 선언으로 항목이 사라졌다"를 구분할 수 있다. ' +
      'CLO-110(H-1-3): 발신자에게는 additionalInstruction을 빈 문자열로 지우고 agentCapabilitiesSnapshot을 null로 두며 additionalInstructionRedacted=true를 붙인다.',
  })
  @Get('executions/:executionId')
  get(@Headers('authorization') h: string, @Param('executionId') id: string) {
    return this.user(h).then((userId) => this.executions.get(userId, id));
  }
  @ApiOperation({
    summary: '최신 실행의 PENDING 결과만 승인·전달, 과거 결과와 추가 작업 중 승인은 409',
  })
  @Post('results/:resultId/approve-and-send')
  approve(@Headers('authorization') h: string, @Param('resultId') id: string) {
    return this.user(h).then((userId) => this.executions.approve(userId, id));
  }
}
