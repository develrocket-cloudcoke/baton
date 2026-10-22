import { PairingController } from './pairing.controller';
import { PairingService } from './pairing.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
@Module({
  imports: [AuthModule],
  controllers: [UsersController, PairingController],
  providers: [PairingService],
})
export class UsersModule {}
