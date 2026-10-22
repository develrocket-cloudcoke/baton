import { ApprovalsModule } from './approvals/approvals.module';
import { OrgModule } from './org/org.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { PrismaModule } from './prisma.module';
import { BatonService } from './baton.service';
import { AuthModule } from './auth/auth.module';
import { RequestsModule } from './requests/requests.module';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { StorageModule } from './storage/storage.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { TimelineModule } from './timeline/timeline.module';
import { ExecutionsModule } from './executions/executions.module';
import { DesktopModule } from './desktop/desktop.module';
import { NotificationsModule } from './notifications/notifications.module';
import { sessionSecret } from './auth/state';

@Module({
  imports: [
    PrismaModule,
    ApprovalsModule,
    OrgModule,
    JwtModule.register({
      secret: sessionSecret(),
      signOptions: { expiresIn: '8h' },
    }),
    AuthModule,
    RequestsModule,
    UsersModule,
    DocumentsModule,
    StorageModule,
    ArtifactsModule,
    TimelineModule,
    ExecutionsModule,
    DesktopModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [BatonService],
})
export class AppModule {}
