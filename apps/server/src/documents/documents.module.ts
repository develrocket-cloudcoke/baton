import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DesktopModule } from '../desktop/desktop.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
@Module({
  imports: [AuthModule, DesktopModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
