import { parseArgs } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';

export class LinkIdentityError extends Error {}

export function parseLinkIdentityArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      provider: { type: 'string' },
      subject: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const email = values.email?.trim();
  const providerId = values.provider;
  const subject = values.subject;
  // subject는 제공자의 불투명한 식별자다. trim/소문자 변환으로 다른 신원에 연결하지 않는다.
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 191 ||
    !providerId ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(providerId) ||
    !subject ||
    !subject.trim() ||
    subject.length > 255 ||
    /[\x00-\x1f\x7f]/.test(subject)
  )
    throw new LinkIdentityError(
      '--email, --provider(80자 이하), --subject(255자 이하)를 확인하세요.',
    );
  return { email, providerId, subject };
}

export async function linkIdentity(
  db: PrismaClient,
  args: ReturnType<typeof parseLinkIdentityArgs>,
) {
  return db.$transaction(
    async (tx) => {
      const user = await tx.user.findUnique({ where: { email: args.email } });
      if (!user) throw new LinkIdentityError('사용자가 없습니다.');
      if (user.status !== 'ACTIVE') throw new LinkIdentityError('비활성 사용자입니다.');
      const key = { providerId: args.providerId, subject: args.subject };
      const existing = await tx.userIdentity.findUnique({ where: { providerId_subject: key } });
      if (existing && existing.userId !== user.id)
        throw new LinkIdentityError('이 신원은 다른 사용자에 연결돼 있습니다.');
      if (
        existing ||
        (await tx.userIdentity.findFirst({
          where: { userId: user.id, providerId: args.providerId },
        }))
      )
        throw new LinkIdentityError('이 사용자는 해당 제공자의 신원을 이미 가지고 있습니다.');
      const identity = await tx.userIdentity.create({ data: { ...key, userId: user.id } });
      // 실행자는 DB 접근 권한을 가진 운영자이며 연결 대상 사용자가 실행했다고 기록하지 않는다.
      await tx.timelineEvent.create({
        data: {
          actorType: 'HUMAN',
          eventType: 'user.identity_linked',
          payload: { userId: user.id, identityId: identity.id, ...key, source: 'operator-cli' },
        },
      });
      return { userId: user.id, identityId: identity.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function main() {
  const args = parseLinkIdentityArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await linkIdentity(db, args)));
  } finally {
    await db.$disconnect();
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      error instanceof LinkIdentityError
        ? error.message
        : '신원 연결 실패: 입력 옵션, DB·스키마 및 동시 실행 여부를 확인하세요.',
    );
    process.exitCode = 1;
  });
