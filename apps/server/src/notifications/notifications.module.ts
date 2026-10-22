import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';

@Module({ imports: [AuthModule], controllers: [NotificationsController] })
export class NotificationsModule {}
