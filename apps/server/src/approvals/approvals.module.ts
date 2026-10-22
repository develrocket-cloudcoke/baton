import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DesktopModule } from '../desktop/desktop.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({ imports: [AuthModule, DesktopModule], controllers: [ApprovalsController], providers: [ApprovalsService] })
export class ApprovalsModule {}
