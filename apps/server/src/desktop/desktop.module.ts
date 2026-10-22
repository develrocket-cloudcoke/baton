import { Module } from '@nestjs/common';
import { OnModuleDestroy } from '@nestjs/common';
import { endAllDeviceConnections } from './connections';
import { AuthModule } from '../auth/auth.module';
import { DesktopController } from './desktop.controller';
import { DesktopService } from './desktop.service';
import { OutboxRetentionService } from './outbox-retention.service';

@Module({
  imports: [AuthModule],
  controllers: [DesktopController],
  providers: [DesktopService, OutboxRetentionService],
  exports: [DesktopService],
})
/**
 * 종료할 때 열린 SSE 를 먼저 끊는다.
 *
 * `enableShutdownHooks()` 아래에서 Nest 는 HTTP 서버가 닫히기를 기다리는데, SSE 는
 * 스스로 끝나지 않아 종료가 멈춘다(2026-09-22 dev 서버 실측). 데몬 쪽에는 제어
 * 이벤트를 보내지 않으므로 평소의 끊김으로 보고 백오프 재연결한다.
 */
export class DesktopModule implements OnModuleDestroy {
  onModuleDestroy() {
    endAllDeviceConnections();
  }
}
