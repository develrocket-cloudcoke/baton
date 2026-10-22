import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { bootstrapAdmin, parseBootstrapArgs, readBootstrapPassword } from './cli/bootstrap-admin';

const args = { email: 'admin@example.com', name: '관리자', org: '조직' };
function fixture(existing = false, duplicate = false, fail = false) {
  const writes: { table: string; data: any }[] = [];
  let committed = false;
  const create =
    (table: string) =>
    async ({ data }: any) => {
      if (fail && table === 'team') throw new Error('failure');
      writes.push({ table, data });
      return { id: table, ...data };
    };
  const tx = Object.fromEntries(
    [
      'user',
      'userIdentity',
      'organization',
      'orgMembership',
      'team',
      'teamMembership',
      'timelineEvent',
    ].map((table) => [table, { create: create(table) }]),
  );
  Object.assign(tx.user, {
    count: async () => (existing ? 1 : 0),
    findUnique: async () => (duplicate ? { id: 'old' } : null),
  });
  const db = {
    $transaction: async (fn: any, options: any) => {
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      try {
        const result = await fn(tx);
        committed = true;
        return result;
      } catch (error) {
        writes.length = 0;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  return { db, writes, committed: () => committed };
}

test('초기 관리자는 local 신원·조직 관리자·팀 리드와 감사 기록을 한 트랜잭션으로 만든다', async () => {
  const f = fixture();
  await bootstrapAdmin(f.db, args, 'test-password-123');
  assert.equal(f.committed(), true);
  const data = (table: string) => f.writes.find((w) => w.table === table)!.data;
  assert.equal(await bcrypt.compare('test-password-123', data('user').passwordHash), true);
  assert.equal(bcrypt.getRounds(data('user').passwordHash), 10);
  assert.deepEqual(data('userIdentity'), { providerId: 'local', subject: 'user', userId: 'user' });
  assert.equal(data('orgMembership').role, 'ORG_ADMIN');
  assert.equal(data('teamMembership').role, 'TEAM_LEAD');
  assert.equal(data('team').orgId, 'organization');
  assert.ok(!JSON.stringify(data('timelineEvent')).includes('password'));
});

test('기존 사용자·동일 이메일은 거부하고 생성 중 오류도 전파한다', async () => {
  for (const f of [fixture(true), fixture(false, true), fixture(false, false, true)]) {
    await assert.rejects(bootstrapAdmin(f.db, args, 'test-password-123'));
    assert.equal(f.committed(), false);
    assert.equal(f.writes.length, 0);
  }
});

test('비밀번호 옵션은 받지 않고 필수 옵션을 검사한다', () => {
  assert.deepEqual(
    parseBootstrapArgs(['--email', args.email, '--name', args.name, '--org', args.org]),
    args,
  );
  assert.throws(() => parseBootstrapArgs(['--password', 'secret']));
  assert.throws(() => parseBootstrapArgs(['--email', 'bad']));
});

test('stdin 한 줄·CRLF·빈 입력·TTY와 bcrypt 길이 제한', async () => {
  assert.deepEqual(await readBootstrapPassword(Readable.from(['test-password-123\r\n'])), {
    password: 'test-password-123',
    generated: false,
  });
  for (const input of [
    Readable.from([]),
    Readable.from(['\n']),
    Object.assign(Readable.from(['ignored']), { isTTY: true }),
  ]) {
    const result = await readBootstrapPassword(input);
    assert.equal(result.generated, true);
    assert.match(result.password, /^[A-Za-z0-9_-]{32}$/);
  }
  await assert.rejects(readBootstrapPassword(Readable.from(['short\n'])));
  await assert.rejects(readBootstrapPassword(Readable.from(['1234567\n'])));
  assert.equal((await readBootstrapPassword(Readable.from(['12345678\n']))).password, '12345678');
  await assert.rejects(readBootstrapPassword(Readable.from(['가'.repeat(25) + '\n'])));
  const unicode = '가'.repeat(12);
  const bytes = Buffer.from(unicode + '\n');
  assert.equal(
    (await readBootstrapPassword(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)])))
      .password,
    unicode,
  );
});
