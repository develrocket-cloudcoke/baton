import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DesktopModule } from '../desktop/desktop.module';
import { LocalDiskStorage, S3Storage, StorageService } from './storage.service';
import { StorageController } from './storage.controller';
@Module({
  imports: [AuthModule, DesktopModule],
  controllers: [StorageController],
  providers: [LocalDiskStorage, S3Storage, StorageService],
})
export class StorageModule {}
