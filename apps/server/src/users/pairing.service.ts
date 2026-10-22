import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceMetadata } from '@baton/shared';
import { closeDeviceConnection } from '../desktop/connections';
import { expirePresence, presenceCutoff } from '../desktop/presence';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PairingService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  /// 사람이 옮겨 적는 값이라 하이픈 누락·소문자·공백이 흔하다. 발급 형식(XXXX-XXXX)으로
  /// 되돌려 해시한다. 정규화 없이는 하이픈만 빠져도 "유효하지 않은 코드" 로 거부되는데,
  /// 입력한 사람은 코드가 맞는데 왜 안 되는지 알 수 없다 (2026-09-18 테스터 실사용).
  private normalizeCode(code: string) {
    const raw = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : code.trim();
  }
  async issue(userId: string) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.prisma.pairingCode.create({
      data: { userId, codeHash: this.hash(code), expiresAt },
    });
    return { code, expiresAt };
  }
  async pair(
    code: string,
    deviceName: string,
    metadata: DeviceMetadata = {},
    authorization?: string,
  ) {
    const deviceToken = randomBytes(32).toString('base64url');
    const result = await this.prisma.$transaction(async (tx) => {
      const pairing = await tx.pairingCode.findUnique({
        where: { codeHash: this.hash(this.normalizeCode(code)) },
      });
      if (!pairing) throw new ForbiddenException('유효하지 않은 pairing 코드입니다.');
      if (pairing.usedAt) throw new ForbiddenException('이미 사용한 pairing 코드입니다.');
      const now = new Date();
      if (pairing.expiresAt <= now) throw new ForbiddenException('만료된 pairing 코드입니다.');
      const user = await tx.user.findUnique({ where: { id: pairing.userId } });
      if (user?.status !== 'ACTIVE') throw new ForbiddenException();
      // 조건부 갱신으로 동시 요청에서도 코드가 한 번만 소비된다.
      const consumed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1)
        throw new ForbiddenException('이미 사용했거나 만료된 pairing 코드입니다.');
      const previousToken = authorization?.replace(/^Bearer\s+/i, '');
      const previous = previousToken
        ? await tx.device.findFirst({
            where: { tokenHash: this.hash(previousToken), revokedAt: null, userId: pairing.userId },
          })
        : null;
      if (previousToken && !previous)
        throw new ForbiddenException('기존 디바이스 토큰의 소유자가 일치하지 않습니다.');
      // 기존 토큰을 제시한 재-pairing은 같은 Device의 토큰을 회전한다. 실패 시 코드 소비도 롤백된다.
      if (previous) {
        const rotated = await tx.device.updateMany({
          where: { id: previous.id, tokenHash: this.hash(previousToken!), revokedAt: null },
          data: {
            ...metadata,
            name: deviceName,
            tokenHash: this.hash(deviceToken),
            lastSeenAt: new Date(),
          },
        });
        if (!rotated.count) throw new ForbiddenException('이미 교체된 디바이스 토큰입니다.');
      }
      const device =
        previous ??
        (await tx.device.create({
          data: {
            ...metadata,
            userId: pairing.userId,
            name: deviceName,
            tokenHash: this.hash(deviceToken),
            lastSeenAt: new Date(),
          },
        }));
      await tx.timelineEvent.create({
        data: {
          actorType: 'HUMAN',
          actorUserId: pairing.userId,
          eventType: 'device.paired',
          payload: { deviceId: device.id, deviceName },
        },
      });
      return { deviceId: device.id, deviceToken, userId: pairing.userId };
    });
    closeDeviceConnection(result.deviceId, '재-pairing으로 디바이스 토큰이 교체되었습니다.');
    return result;
  }
  async list(userId: string) {
    await expirePresence(this.prisma, userId);
    const devices = await this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      select: {
        platform: true,
        osVersion: true,
        appVersion: true,
        hostname: true,
        id: true,
        userId: true,
        name: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((device) => ({
      ...device,
      status: device.lastSeenAt && device.lastSeenAt > presenceCutoff() ? 'ONLINE' : 'OFFLINE',
    }));
  }
  async revoke(userId: string, id: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.device.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!changed.count) throw new NotFoundException();
      await tx.agent.updateMany({ where: { deviceId: id }, data: { status: 'DISABLED' } });
      return { ok: true };
    });
    // 데몬을 죽이지 않는다. 토큰만 무효해진 것이고 곧 다시 pairing 할 수 있어야 한다.
    closeDeviceConnection(id, '디바이스 연결이 해제되었습니다.', 'connection.revoked');
    return result;
  }
}
