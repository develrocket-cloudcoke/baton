import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { AddTeamMember, CreateOrgUser, CreateTeamLink, TeamLinkDirection } from '@baton/shared';
import { PrismaService } from '../prisma.service';
import { presenceCutoff } from '../desktop/presence';
import { readAuthConfig } from '../auth/identity-provider';

export const publicUser = { id: true, email: true, displayName: true, status: true } as const;
@Injectable()
export class OrgService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}
  async membership(userId: string, admin = false) {
    const membership = await this.prisma.orgMembership.findFirst({
      where: { userId },
      include: { org: true },
    });
    if (!membership || (admin && membership.role !== 'ORG_ADMIN'))
      throw new ForbiddenException('조직 권한이 없습니다.');
    return membership;
  }
  async team(userId: string, id: string, manageMembers = false) {
    const membership = await this.membership(userId);
    const team = await this.prisma.team.findFirst({ where: { id, orgId: membership.orgId } });
    if (!team) throw new ForbiddenException('내 조직의 팀만 관리할 수 있습니다.');
    if (manageMembers && membership.role !== 'ORG_ADMIN') {
      const lead = await this.prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: id, userId } },
      });
      if (lead?.role !== 'TEAM_LEAD') throw new ForbiddenException('팀 관리자 권한이 필요합니다.');
    }
    return team;
  }
  private event(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    eventType: string,
    payload: Prisma.InputJsonObject,
  ) {
    return tx.timelineEvent.create({
      data: { actorType: 'HUMAN', actorUserId, eventType, payload },
    });
  }
  private async conflict<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003'].includes(error.code)
      )
        throw new ConflictException('이미 존재하거나 사용 중인 항목입니다.');
      throw error;
    }
  }
  async teams(userId: string) {
    const { orgId } = await this.membership(userId);
    return this.prisma.team.findMany({
      where: { orgId },
      include: { memberships: { include: { user: { select: publicUser } } } },
      orderBy: { name: 'asc' },
    });
  }
  async createTeam(userId: string, name: string) {
    const { orgId } = await this.membership(userId, true);
    return this.conflict(() =>
      this.prisma.$transaction(async (tx) => {
        const team = await tx.team.create({ data: { orgId, name, createdByUserId: userId } });
        await this.event(tx, userId, 'team.created', { orgId, teamId: team.id, name });
        return team;
      }),
    );
  }
  async updateTeam(userId: string, id: string, name: string) {
    await this.membership(userId, true);
    const team = await this.team(userId, id);
    return this.conflict(() =>
      this.prisma.$transaction(async (tx) => {
        const updated = await tx.team.update({ where: { id }, data: { name } });
        await this.event(tx, userId, 'team.updated', { orgId: team.orgId, teamId: id, name });
        return updated;
      }),
    );
  }
  async deleteTeam(userId: string, id: string) {
    await this.membership(userId, true);
    const team = await this.team(userId, id);
    return this.conflict(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.team.delete({ where: { id } });
        await this.event(tx, userId, 'team.deleted', { orgId: team.orgId, teamId: id });
        return { ok: true };
      }),
    );
  }
  async members(userId: string, id: string) {
    await this.team(userId, id);
    return this.prisma.teamMembership.findMany({
      where: { teamId: id },
      include: { user: { select: publicUser } },
    });
  }
  async addMember(userId: string, id: string, body: AddTeamMember) {
    const team = await this.team(userId, id, true);
    const member = await this.prisma.orgMembership.findFirst({
      where: { orgId: team.orgId, user: { email: body.email, status: 'ACTIVE' } },
    });
    if (!member) throw new ForbiddenException('조직에 등록된 사용자만 추가할 수 있습니다.');
    return this.conflict(() =>
      this.prisma.$transaction(async (tx) => {
        const result = await tx.teamMembership.create({
          data: { teamId: id, userId: member.userId, role: body.role },
        });
        await this.event(tx, userId, 'team.member_added', {
          orgId: team.orgId,
          teamId: id,
          userId: member.userId,
          role: body.role,
        });
        return result;
      }),
    );
  }
  async removeMember(userId: string, id: string, email: string) {
    const team = await this.team(userId, id, true);
    const member = await this.prisma.teamMembership.findFirst({
      where: { teamId: id, user: { email } },
    });
    if (!member) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      await tx.teamMembership.delete({
        where: { teamId_userId: { teamId: id, userId: member.userId } },
      });
      await this.event(tx, userId, 'team.member_removed', {
        orgId: team.orgId,
        teamId: id,
        userId: member.userId,
      });
      return { ok: true };
    });
  }
  async users(userId: string) {
    const { orgId } = await this.membership(userId, true);
    return this.prisma.orgMembership.findMany({
      where: { orgId },
      include: { user: { select: publicUser } },
    });
  }
  /**
   * 조직 구성원 명부. **관리자가 아니어도 볼 수 있다.**
   *
   * `users()` 는 ORG_ADMIN 전용이고 사용자 생성과 같은 관리 경로다. 그 탓에 일반
   * 멤버는 조직에 누가 있는지조차 알 수 없었고, 요청 목록에 이름 대신 UUID 가
   * 찍히는 원인이기도 했다 (2026-09-21).
   *
   * **볼 수 있는 것과 보낼 수 있는 것은 다르다.** 여기서는 조직 전체를 보여 주고,
   * 누구에게 일을 넘길 수 있는지는 기존대로 팀 링크가 정한다(`recipients`).
   * 그래서 이 목록은 읽기 전용이고 관리 동작을 아무것도 제공하지 않는다.
   */
  async orgMembers(userId: string) {
    const { orgId } = await this.membership(userId);
    const rows = await this.prisma.orgMembership.findMany({
      where: { orgId },
      include: {
        user: {
          select: {
            ...publicUser,
            memberships: {
              where: { team: { orgId } },
              select: { role: true, team: { select: { id: true, name: true } } },
            },
            // 온라인 뱃지. 수신자 선택 화면과 같은 2분 기준을 쓴다.
            devices: {
              where: { revokedAt: null, lastSeenAt: { gt: presenceCutoff() } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    return rows
      .map(({ role, user }) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        orgRole: role,
        online: user.devices.length > 0,
        teams: user.memberships.map((m) => ({ ...m.team, role: m.role })),
      }))
      // 팀 없는 사람(관리자 등)이 목록 끝에 오도록. 그 안에서는 이름순.
      .sort((a, b) => {
        const at = a.teams[0]?.name ?? '\uffff';
        const bt = b.teams[0]?.name ?? '\uffff';
        return at === bt ? a.displayName.localeCompare(b.displayName) : at.localeCompare(bt);
      });
  }
  async createUser(userId: string, body: CreateOrgUser) {
    const { orgId } = await this.membership(userId, true);
    // 외부 로그인(accounts 등)에서는 비밀번호 계정이 쓸모없고 해롭다. 로그인할 수 없을 뿐 아니라,
    // 같은 이메일이 먼저 있으면 그 사람의 첫 외부 로그인 자동 가입이 이메일 충돌로 거부된다
    // (이메일로 계정을 잇지 않는다). 구성원은 첫 로그인 때 자동으로 추가된다.
    if (readAuthConfig().providerId !== 'local')
      throw new ConflictException(
        '외부 로그인을 쓰는 동안에는 비밀번호 계정을 만들 수 없습니다. 구성원은 처음 로그인할 때 자동으로 추가됩니다.',
      );
    const passwordHash = await bcrypt.hash(body.temporaryPassword, 10);
    // 이메일 유일 제약으로 기존 사용자를 다른 조직에 중복 등록할 수 없다.
    return this.conflict(() =>
      this.prisma.user.create({
        data: {
          email: body.email,
          displayName: body.displayName,
          passwordHash,
          orgMemberships: { create: { orgId } },
        },
        select: publicUser,
      }),
    );
  }
  async links(userId: string) {
    const { orgId } = await this.membership(userId, true);
    const rows = await this.prisma.teamLink.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
    const directions = new Set(rows.map((row) => `${row.fromTeamId}:${row.toTeamId}`));
    return rows.map((row) => {
      const reverseAllowed = directions.has(`${row.toTeamId}:${row.fromTeamId}`);
      return {
        ...row,
        teamAId: row.fromTeamId,
        teamBId: row.toTeamId,
        direction: reverseAllowed ? 'both' : 'a-to-b',
        reverseAllowed,
      };
    });
  }
  async createLink(userId: string, body: CreateTeamLink) {
    const { orgId } = await this.membership(userId, true);
    await this.team(userId, body.teamAId);
    await this.team(userId, body.teamBId);
    return this.conflict(() =>
      this.prisma.$transaction(async (tx) => {
        const rows = [];
        for (const { fromTeamId, toTeamId } of this.linkDirections(
          body.teamAId,
          body.teamBId,
          body.direction,
        )) {
          rows.push(
            await tx.teamLink.upsert({
              where: { fromTeamId_toTeamId: { fromTeamId, toTeamId } },
              update: {},
              create: { orgId, fromTeamId, toTeamId, createdByUserId: userId },
            }),
          );
        }
        await this.event(tx, userId, 'team.link_created', { orgId, ...body });
        return rows;
      }),
    );
  }
  private linkDirections(teamAId: string, teamBId: string, direction: TeamLinkDirection) {
    return [
      ...(direction !== 'b-to-a' ? [{ fromTeamId: teamAId, toTeamId: teamBId }] : []),
      ...(direction !== 'a-to-b' ? [{ fromTeamId: teamBId, toTeamId: teamAId }] : []),
    ];
  }
  async deleteLink(userId: string, id: string, direction: TeamLinkDirection = 'both') {
    const { orgId } = await this.membership(userId, true);
    const link = await this.prisma.teamLink.findFirst({ where: { id, orgId } });
    if (!link) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      await tx.teamLink.deleteMany({
        where: {
          orgId,
          OR: this.linkDirections(link.fromTeamId, link.toTeamId, direction),
        },
      });
      await this.event(tx, userId, 'team.link_revoked', {
        orgId,
        teamAId: link.fromTeamId,
        teamBId: link.toTeamId,
        direction,
      });
      return { ok: true };
    });
  }
}
