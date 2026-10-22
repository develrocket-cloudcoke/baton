import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

export class BootstrapError extends Error {}

export function parseBootstrapArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' }, name: { type: 'string' }, org: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const email = values.email?.trim();
  const name = values.name?.trim();
  const org = values.org?.trim();
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 191 ||
    !name ||
    name.length > 191 ||
    !org ||
    org.length > 191
  ) {
    throw new BootstrapError('--email, --name, --org를 올바르게 지정하세요(각 191자 이하).');
  }
  return { email, name, org };
}

// TTY에서는 입력을 기다리거나 비밀번호를 화면에 에코하지 않는다.
export async function readBootstrapPassword(input: Readable & { isTTY?: boolean }) {
  let line = '';
  if (!input.isTTY) {
    input.setEncoding('utf8');
    for await (const chunk of input) {
      line += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (line.includes('\n')) {
        line = line.slice(0, line.indexOf('\n'));
        break;
      }
      if (Buffer.byteLength(line) > 72) throw new BootstrapError('비밀번호는 최대 72바이트입니다.');
    }
    line = line.replace(/\r$/, '');
  }
  if (!line) return { password: randomBytes(24).toString('base64url'), generated: true };
  // bcrypt가 72바이트 뒤를 조용히 버리지 않도록 입력 단계에서 막는다.
  // 최소 길이는 관리자 화면의 계정 생성(CreateOrgUserSchema.temporaryPassword, 8~72)과 맞춘다.
  if (line.length < 8 || Buffer.byteLength(line) > 72)
    throw new BootstrapError('비밀번호는 8자 이상, 72바이트 이하이어야 합니다.');
  return { password: line, generated: false };
}

export async function bootstrapAdmin(
  db: PrismaClient,
  args: ReturnType<typeof parseBootstrapArgs>,
  password: string,
) {
  const passwordHash = await bcrypt.hash(password, 10);
  return db.$transaction(
    async (tx) => {
      if (await tx.user.findUnique({ where: { email: args.email } }))
        throw new BootstrapError('같은 이메일의 사용자가 이미 있습니다.');
      if (await tx.user.count())
        throw new BootstrapError('사용자가 있는 DB에서는 초기화할 수 없습니다.');
      const user = await tx.user.create({
        data: { email: args.email, displayName: args.name, passwordHash },
      });
      await tx.userIdentity.create({
        data: { providerId: 'local', subject: user.id, userId: user.id },
      });
      const org = await tx.organization.create({
        data: { name: args.org, slug: `org-${randomUUID()}`, createdByUserId: user.id },
      });
      await tx.orgMembership.create({
        data: { orgId: org.id, userId: user.id, role: 'ORG_ADMIN' },
      });
      const team = await tx.team.create({
        data: { orgId: org.id, name: '기본 팀', createdByUserId: user.id },
      });
      await tx.teamMembership.create({
        data: { teamId: team.id, userId: user.id, role: 'TEAM_LEAD' },
      });
      await tx.timelineEvent.create({
        data: {
          actorType: 'HUMAN',
          actorUserId: user.id,
          eventType: 'organization.bootstrapped',
          payload: { orgId: org.id, teamId: team.id },
        },
      });
      return { userId: user.id, orgId: org.id, teamId: team.id };
      // 빈 사용자 집합 검사와 생성을 직렬화한다. 동시 실행의 충돌은 재시도하지 않고 실패한다.
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function main() {
  const args = parseBootstrapArgs(process.argv.slice(2));
  if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local')
    throw new BootstrapError('AUTH_PROVIDER=local에서만 실행할 수 있습니다.');
  const { password, generated } = await readBootstrapPassword(process.stdin);
  const db = new PrismaClient();
  try {
    const result = await bootstrapAdmin(db, args, password);
    console.error(`관리자 생성 완료: ${JSON.stringify(result)}`);
    // 트랜잭션이 성공한 뒤 생성한 비밀번호만 한 번 출력한다. 입력 비밀번호는 출력하지 않는다.
    if (generated) console.log(password);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Prisma 오류에는 쿼리 인수가 들어갈 수 있어 원문을 출력하지 않는다.
    console.error(
      error instanceof BootstrapError
        ? error.message
        : '관리자 생성 실패: 입력 옵션, DB 연결·스키마와 동시 실행 여부를 확인하세요.',
    );
    process.exitCode = 1;
  });
}
