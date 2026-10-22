import { BadRequestException, Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RecipientsQuerySchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { RequestsService } from './requests.service';

@ApiTags('requests')
@ApiBearerAuth()
@Controller('v1/recipients')
export class RecipientsController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(RequestsService) private requests: RequestsService,
  ) {}
  @Get()
  @ApiQuery({ name: 'senderTeamId', required: true, type: String })
  @ApiOkResponse({
    description:
      '같은 조직의 소속 팀 및 발신 방향 TeamLink 대상. { teams: [{ id, name, members: [{ id, email, displayName }] }] }, 본인 제외.',
  })
  @ApiForbiddenResponse({ description: '본인이 소속되지 않은 발신 팀' })
  async list(@Headers('authorization') h: string, @Query() query: { senderTeamId: string }) {
    const parsed = RecipientsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('senderTeamId가 필요합니다.');
    return this.requests.recipients((await this.auth.current(h)).sub, parsed.data.senderTeamId);
  }
}
