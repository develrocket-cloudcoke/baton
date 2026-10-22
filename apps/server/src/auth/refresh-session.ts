import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma.service';

export const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
export const ACCESS_MAX_AGE = 8 * 60 * 60 * 1000;
export const REFRESH_COOKIE_PATH = '/v1/auth';
const ROTATION_GRACE_MS = 10_000;
export const refreshHash = (token: string) => createHash('sha256').update(token).digest('hex');

function freshSession(userId: string, familyId: string, now: Date, userAgent?: string) {
  const refreshToken = randomBytes(32).toString('base64url');
  return { refreshToken, data: {
    id: randomUUID(), userId, familyId, tokenHash: refreshHash(refreshToken),
    createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + REFRESH_MAX_AGE),
    userAgent: userAgent?.slice(0, 191),
  } };
}

export async function issueRefreshSession(db: PrismaService, userId: string, userAgent?: string) {
  const session = freshSession(userId, randomUUID(), new Date(), userAgent);
  await db.authSession.create({ data: session.data });
  return session.refreshToken;
}

export async function rotateRefreshSession(db: PrismaService, jwt: JwtService, raw?: string, userAgent?: string) {
  if (!raw) throw new UnauthorizedException();
  const tokenHash = refreshHash(raw);
  const found = await db.authSession.findUnique({ where: { tokenHash } });
  if (!found) throw new UnauthorizedException();
  const result = await db.$transaction(async (tx) => {
    // family의 옛 토큰 재사용·새 토큰 회전·로그아웃을 같은 잠금으로 직렬화한다.
    await tx.$queryRaw`SELECT id FROM User WHERE id = ${found.userId} FOR UPDATE`;
    const session = await tx.authSession.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!session) return null;
    if (session.revokedAt) {
      const elapsed = now.getTime() - session.revokedAt.getTime();
      if (!(session.replacedById && elapsed >= 0 && elapsed <= ROTATION_GRACE_MS)) {
        await tx.authSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });
      }
      // 후속 토큰 원문은 저장하지 않는다. 짧은 경합도 401로 끝내되 family는 유지한다.
      return null;
    }
    if (session.expiresAt <= now) return null;
    const user = await tx.user.findUnique({ where: { id: session.userId } });
    if (user?.status !== 'ACTIVE') return null;
    const next = freshSession(user.id, session.familyId, now, userAgent);
    const token = await jwt.signAsync({ sub: user.id, email: user.email });
    await tx.authSession.create({ data: next.data });
    await tx.authSession.update({ where: { id: session.id }, data: {
      revokedAt: now, lastUsedAt: now, replacedById: next.data.id,
    } });
    return { token, refreshToken: next.refreshToken };
  });
  // 트랜잭션 밖에서 거부해야 재사용으로 폐기한 family가 롤백되지 않는다.
  if (!result) throw new UnauthorizedException();
  return result;
}

export async function revokeRefreshFamily(db: PrismaService, raw?: string) {
  if (!raw) return;
  const found = await db.authSession.findUnique({ where: { tokenHash: refreshHash(raw) } });
  if (!found) return;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM User WHERE id = ${found.userId} FOR UPDATE`;
    await tx.authSession.updateMany({ where: { familyId: found.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}
