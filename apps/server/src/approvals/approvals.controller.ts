import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { ApprovalDecisionSchema, CreateApprovalSchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { DesktopService } from '../desktop/desktop.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApprovalsService } from './approvals.service';

@Controller('v1')
export class ApprovalsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DesktopService) private readonly desktop: DesktopService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}
  @Post('desktop/executions/:executionId/approvals')
  async create(
    @Headers('authorization') h: string,
    @Param('executionId') id: string,
    @Body(new ZodValidationPipe(CreateApprovalSchema)) body: unknown,
  ) {
    return this.approvals.create((await this.desktop.device(h)).id, id, body);
  }
  @Get('desktop/approvals/:id')
  async get(@Headers('authorization') h: string, @Param('id') id: string) {
    return this.approvals.get((await this.desktop.device(h)).id, id);
  }
  @Get('executions/:executionId/approvals')
  async list(@Headers('authorization') h: string, @Param('executionId') id: string) {
    return this.approvals.list((await this.auth.current(h)).sub, id);
  }
  @Post('approvals/:id/decision')
  async decide(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApprovalDecisionSchema)) body: unknown,
  ) {
    return this.approvals.decide((await this.auth.current(h)).sub, id, body);
  }
}
