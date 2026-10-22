import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { linkIdentity, parseLinkIdentityArgs } from './cli/link-identity';

const args = { email: 'admin@example.com', providerId: 'accounts', subject: 'stable-id' };
function fixture(
  options: {
    missing?: boolean;
    disabled?: boolean;
    owner?: string;
    linked?: boolean;
    auditFailure?: boolean;
  } = {},
) {
  const writes: any[] = [];
  const db = {
    $transaction: async (run: any, config: any) => {
      assert.equal(config.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      try {
        return await run({
          user: {
            findUnique: async () =>
              options.missing
                ? null
                : { id: 'user', status: options.disabled ? 'DISABLED' : 'ACTIVE' },
          },
          userIdentity: {
            findUnique: async () => (options.owner ? { userId: options.owner } : null),
            findFirst: async () => (options.linked ? { subject: 'another' } : null),
            create: async ({ data }: any) => {
              writes.push(data);
              return { id: 'identity', ...data };
            },
          },
          timelineEvent: {
            create: async ({ data }: any) => {
              if (options.auditFailure) throw new Error('audit failed');
              writes.push(data);
            },
          },
        });
      } catch (error) {
        writes.length = 0;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  return { db, writes };
}

test('신원 연결과 운영자 감사 이벤트를 같은 트랜잭션에 생성', async () => {
  const f = fixture();
  assert.deepEqual(await linkIdentity(f.db, args), { userId: 'user', identityId: 'identity' });
  assert.deepEqual(f.writes[0], { providerId: 'accounts', subject: 'stable-id', userId: 'user' });
  assert.equal(f.writes[1].eventType, 'user.identity_linked');
  assert.equal(f.writes[1].actorType, 'HUMAN');
  assert.equal(f.writes[1].payload.userId, 'user');
});

test('없는/비활성 사용자, 다른 소유자, 같은 제공자 중복, 감사 실패 거부', async () => {
  for (const options of [
    { missing: true },
    { disabled: true },
    { owner: 'other' },
    { owner: 'user' },
    { linked: true },
    { auditFailure: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(linkIdentity(f.db, args));
    assert.equal(f.writes.length, 0);
  }
});

test('CLI 필수 옵션과 길이를 검사하고 subject를 정규화하지 않는다', () => {
  assert.deepEqual(
    parseLinkIdentityArgs([
      '--email',
      args.email,
      '--provider',
      'accounts',
      '--subject',
      ' CaseSensitive ',
    ]),
    { ...args, subject: ' CaseSensitive ' },
  );
  for (const tokens of [
    [],
    ['--email', args.email, '--provider', 'accounts', '--subject', 'x\ny'],
    ['--force'],
  ])
    assert.throws(() => parseLinkIdentityArgs(tokens));
});
