import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { missingAuditTriggers } from './audit-protection';
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy, OnModuleInit {
  async onModuleInit() {
    const logger = new Logger('AuditProtection');
    try {
      const missing = await missingAuditTriggers(this);
      if (missing.length)
        logger.warn(
          `audit.protection_missing: ${missing.join(', ')}; 승인 기록의 DB 수정/삭제 방어가 불완전합니다. prisma:audit-install을 실행하세요.`,
        );
    } catch {
      logger.warn(
        'audit.protection_unverified: 트리거 존재를 확인할 권한 또는 DB 연결이 없습니다.',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
