import { ApiOkResponse, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { capabilitiesSwagger } from '../desktop/capabilities-swagger';
import { AgentProviderSchema, effectiveAgentCapabilities } from '@baton/shared';
import {
  Controller,
  Delete,
  ConflictException,
  Get,
  Headers,
  Inject,
  Param,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { canonicalAgent } from '../desktop/agent-lifecycle';
import { expirePresence } from '../desktop/presence';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';
@Controller('v1')
export class UsersController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}
  @Get('me') async me(@Headers('authorization') h?: string) {
    const user = await this.auth.current(h);
    const result = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        orgMemberships: { include: { org: true } },
        memberships: { include: { team: true } },
      },
    });
    return {
      ...result,
      organization: result.orgMemberships[0]?.org ?? null,
      orgRole: result.orgMemberships[0]?.role ?? null,
      teams: result.memberships.map((membership) => ({
        ...membership.team,
        role: membership.role,
      })),
    };
  }
  @Get('teams/:teamId/members') async members(
    @Headers('authorization') h: string,
    @Param('teamId') teamId: string,
  ) {
    const user = await this.auth.current(h);
    const member = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: user.sub } },
    });
    if (!member) throw new ForbiddenException();
    return this.prisma.teamMembership.findMany({
      where: { teamId },
      include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
    });
  }
  // 실행 준비 화면이 고르는 "내" Agent 목록. 데몬이 등록한 것이 먼저 오도록 최근 접속 순으로 정렬한다.
  @ApiOperation({
    summary:
      '내 Agent 목록: provider·정규화 capabilities·lastSeenAt·status, 2분 만료 시 DB OFFLINE 갱신 (기본값으로 DISABLED 제외)',
  })
  @ApiQuery({
    name: 'includeDisabled',
    required: false,
    type: Boolean,
    description: 'true 시 DISABLED 상태인 Agent도 포함하여 반환 (기본값 false)',
  })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          provider: { type: 'string', enum: ['CLAUDE_CODE', 'CODEX', 'AGY'] },
          capabilities: capabilitiesSwagger,
        },
      },
    },
  })
  @Get('agents')
  async agents(
    @Headers('authorization') h: string,
    @Query('includeDisabled') includeDisabled?: string,
  ) {
    const user = await this.auth.current(h);
    const devices = await this.prisma.device.findMany({
      where: { userId: user.sub },
      select: { id: true },
    });
    for (const device of devices)
      for (const provider of AgentProviderSchema.options)
        await this.prisma.$transaction((tx) => canonicalAgent(tx, device.id, provider));
    await expirePresence(this.prisma, user.sub);
    const showDisabled = includeDisabled === 'true' || includeDisabled === '1';
    const agents = await this.prisma.agent.findMany({
      where: {
        ownerUserId: user.sub,
        ...(showDisabled ? {} : { status: { not: 'DISABLED' } }),
      },
      include: { device: { select: { id: true, name: true, lastSeenAt: true } } },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });
    const rows = agents.map((agent) => ({
      ...agent,
      capabilities: effectiveAgentCapabilities(agent.provider, agent.capabilities),
    }));
    const rank = (status: string) => (status === 'ONLINE' || status === 'BUSY' ? 0 : 1);
    return rows.sort((a, b) => rank(a.status) - rank(b.status));
  }
  @Delete('agents/:agentId')
  @ApiOperation({ summary: '소유자 Agent 비활성화, 실행 이력 보존; 진행 중 실행은 먼저 취소(409)' })
  async disableAgent(@Headers('authorization') h: string, @Param('agentId') id: string) {
    const user = await this.auth.current(h);
    const agent = await this.prisma.agent.findFirst({ where: { id, ownerUserId: user.sub } });
    if (!agent) throw new ForbiddenException();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Device WHERE id = ${agent.deviceId} FOR UPDATE`;
      await tx.agent.update({ where: { id }, data: { status: 'DISABLED' } });
      if (
        await tx.execution.findFirst({
          where: { agentId: id, status: { in: ['QUEUED', 'RUNNING'] } },
        })
      )
        throw new ConflictException('진행 중인 실행을 먼저 취소하세요.');
      return { ok: true };
    });
  }
  // 실행 준비 화면이 고르는 "내" Project 목록 (agentId 로 필터 가능)
  @ApiQuery({
    name: 'includeDisabled',
    required: false,
    type: Boolean,
    description: 'true 시 DISABLED 프로젝트 및 DISABLED 에이전트의 프로젝트도 포함 (기본값 false)',
  })
  @ApiQuery({
    name: 'agentId',
    required: false,
    type: String,
    description: '특정 Agent에 등록된 Project만 필터링',
  })
  @Get('projects')
  async projects(
    @Headers('authorization') h: string,
    @Query('includeDisabled') includeDisabled?: string,
    @Query('agentId') agentId?: string,
  ) {
    const user = await this.auth.current(h);
    const showDisabled = includeDisabled === 'true' || includeDisabled === '1';
    return this.prisma.project.findMany({
      where: {
        ownerUserId: user.sub,
        ...(showDisabled
          ? {}
          : { status: 'ACTIVE', agent: { status: { not: 'DISABLED' } } }),
        ...(agentId ? { agentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
