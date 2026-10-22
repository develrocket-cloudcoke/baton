import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  AddTeamMemberSchema,
  CreateOrgUserSchema,
  CreateTeamLinkSchema,
  DeleteTeamLinkSchema,
  CreateTeamSchema,
  RemoveTeamMemberSchema,
  UpdateOrganizationSchema,
  UpdateTeamSchema,
} from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrgService } from './org.service';

@ApiTags('organization')
@ApiBearerAuth()
@Controller('v1/org')
export class OrgController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(OrgService) private org: OrgService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}
  private async user(h: string) {
    return (await this.auth.current(h)).sub;
  }
  @Get() async get(@Headers('authorization') h: string) {
    return (await this.org.membership(await this.user(h))).org;
  }
  @Patch() async update(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(UpdateOrganizationSchema)) body: any,
  ) {
    const { orgId } = await this.org.membership(await this.user(h), true);
    return this.prisma.organization.update({ where: { id: orgId }, data: body });
  }
  @Get('teams') async teams(@Headers('authorization') h: string) {
    return this.org.teams(await this.user(h));
  }
  @Post('teams') async createTeam(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(CreateTeamSchema)) body: any,
  ) {
    return this.org.createTeam(await this.user(h), body.name);
  }
  @Patch('teams/:id') async updateTeam(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateTeamSchema)) body: any,
  ) {
    return this.org.updateTeam(await this.user(h), id, body.name);
  }
  @Delete('teams/:id') async deleteTeam(
    @Headers('authorization') h: string,
    @Param('id') id: string,
  ) {
    return this.org.deleteTeam(await this.user(h), id);
  }
  @Get('teams/:id/members') async members(
    @Headers('authorization') h: string,
    @Param('id') id: string,
  ) {
    return this.org.members(await this.user(h), id);
  }
  @Post('teams/:id/members') async addMember(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddTeamMemberSchema)) body: any,
  ) {
    return this.org.addMember(await this.user(h), id, body);
  }
  @Delete('teams/:id/members') async removeMember(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RemoveTeamMemberSchema)) body: any,
  ) {
    return this.org.removeMember(await this.user(h), id, body.email);
  }
  @ApiOperation({
    summary: '조직 구성원 명부 (멤버 열람 가능)',
    description:
      '같은 조직의 모든 구성원과 소속 팀·온라인 여부를 돌려준다. GET users 와 달리 ORG_ADMIN 이 아니어도 된다. ' +
      '읽기 전용이며, 누구에게 요청을 보낼 수 있는지는 팀 링크가 정한다(GET /v1/recipients).',
  })
  @Get('members') async orgMembers(@Headers('authorization') h: string) {
    return this.org.orgMembers(await this.user(h));
  }
  @Get('users') async users(@Headers('authorization') h: string) {
    return this.org.users(await this.user(h));
  }
  @Post('users') async createUser(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(CreateOrgUserSchema)) body: any,
  ) {
    return this.org.createUser(await this.user(h), body);
  }
  @ApiOperation({
    summary:
      '방향 행 배열: A=fromTeamId, B=toTeamId, 반대 행이 있으면 direction=both 및 reverseAllowed=true',
  })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          fromTeamId: { type: 'string' },
          toTeamId: { type: 'string' },
          teamAId: { type: 'string' },
          teamBId: { type: 'string' },
          direction: { type: 'string', enum: ['both', 'a-to-b'] },
          reverseAllowed: { type: 'boolean' },
        },
      },
    },
  })
  @Get('team-links')
  async links(@Headers('authorization') h: string) {
    return this.org.links(await this.user(h));
  }
  @ApiOperation({ summary: '선택 방향을 추가한다. 기존 반대 방향은 유지한다.' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['teamAId', 'teamBId'],
      properties: {
        teamAId: { type: 'string', format: 'uuid' },
        teamBId: { type: 'string', format: 'uuid' },
        direction: { type: 'string', enum: ['both', 'a-to-b', 'b-to-a'], default: 'both' },
      },
    },
  })
  @Post('team-links')
  async createLink(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(CreateTeamLinkSchema)) body: any,
  ) {
    return this.org.createLink(await this.user(h), body);
  }
  @ApiOperation({ summary: '해당 행의 fromTeamId=A, toTeamId=B 기준으로 선택 방향 해제' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['both', 'a-to-b', 'b-to-a'], default: 'both' },
      },
    },
  })
  @Delete('team-links/:id')
  async deleteLink(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DeleteTeamLinkSchema)) body: any,
  ) {
    return this.org.deleteLink(await this.user(h), id, body.direction);
  }
}
