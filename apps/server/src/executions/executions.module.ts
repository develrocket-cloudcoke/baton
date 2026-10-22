import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';

@Module({
  imports: [AuthModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
