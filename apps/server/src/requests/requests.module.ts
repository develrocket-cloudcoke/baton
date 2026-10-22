import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecipientsController } from './recipients.controller';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
@Module({
  imports: [AuthModule],
  controllers: [RequestsController, RecipientsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
