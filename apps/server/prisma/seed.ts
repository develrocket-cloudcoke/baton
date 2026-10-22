import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('baton-dev-password', 10);
  const userA = await prisma.user.upsert({
    where: { email: 'a@baton.local' },
    update: { passwordHash },
    create: { email: 'a@baton.local', displayName: 'A', passwordHash },
  });
  const userB = await prisma.user.upsert({
    where: { email: 'b@baton.local' },
    update: { passwordHash },
    create: { email: 'b@baton.local', displayName: 'B', passwordHash },
  });
  const admin = await prisma.user.upsert({
    where: { email: 'admin@baton.local' },
    update: { passwordHash },
    create: { email: 'admin@baton.local', displayName: '관리자', passwordHash },
  });
  const org = await prisma.organization.upsert({
    where: { slug: 'example' },
    update: {},
    create: { name: 'example', slug: 'example', createdByUserId: admin.id },
  });
  for (const user of [admin, userA, userB]) {
    const role = user.id === admin.id ? 'ORG_ADMIN' : 'MEMBER';
    await prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: { role },
      create: { orgId: org.id, userId: user.id, role },
    });
  }
  const team = await prisma.team.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: { name: 'backend', orgId: org.id },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'backend',
      orgId: org.id,
      createdByUserId: admin.id,
    },
  });
  const infra = await prisma.team.upsert({
    where: { orgId_name: { orgId: org.id, name: 'infra' } },
    update: {},
    create: { name: 'infra', orgId: org.id, createdByUserId: admin.id },
  });
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: userA.id } },
    update: { role: 'TEAM_LEAD' },
    create: { teamId: team.id, userId: userA.id, role: 'TEAM_LEAD' },
  });
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: infra.id, userId: userB.id } },
    update: {},
    create: { teamId: infra.id, userId: userB.id },
  });
  await prisma.$transaction([
    ...[
      [team.id, infra.id],
      [infra.id, team.id],
    ].map(([fromTeamId, toTeamId]) =>
      prisma.teamLink.upsert({
        where: { fromTeamId_toTeamId: { fromTeamId, toTeamId } },
        update: {},
        create: { orgId: org.id, fromTeamId, toTeamId, createdByUserId: admin.id },
      }),
    ),
  ]);
  const device = await prisma.device.upsert({
    where: { tokenHash: createHash('sha256').update('seed-device-token').digest('hex') },
    update: {},
    create: {
      userId: userB.id,
      name: 'B Desktop',
      tokenHash: createHash('sha256').update('seed-device-token').digest('hex'),
    },
  });
  const agent = await prisma.agent.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    update: { status: 'OFFLINE', displayName: 'Claude Code (seed, 데몬 없음)' },
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      ownerUserId: userB.id,
      deviceId: device.id,
      // 데몬이 없는 자리표시자. 실제 Agent 는 메뉴바 앱/데몬이 pairing 후 등록한다.
      displayName: 'Claude Code (seed, 데몬 없음)',
      status: 'OFFLINE',
    },
  });
  await prisma.project.upsert({
    where: { id: '00000000-0000-4000-8000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000003',
      ownerUserId: userB.id,
      agentId: agent.id,
      displayName: 'backend-api',
      localPathHint: '/tmp/backend-api',
    },
  });
  console.log('Seeded example, admin, backend(A lead), infra(B), and bidirectional links.');
}

main().finally(() => prisma.$disconnect());
