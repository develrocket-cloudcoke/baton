import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { DevicePairV2RequestSchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PairingService } from './pairing.service';
@ApiTags('devices')
@ApiBearerAuth()
@Controller('v1')
export class PairingController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(PairingService) private pairing: PairingService,
  ) {}
  @Post('me/pairing-codes') async issue(@Headers('authorization') h: string) {
    return this.pairing.issue((await this.auth.current(h)).sub);
  }
  @ApiOperation({
    summary:
      '내 디바이스: platform/osVersion/appVersion/hostname·lastSeenAt·ONLINE/OFFLINE, 토큰 비공개',
  })
  @Get('me/devices')
  async devices(@Headers('authorization') h: string) {
    return this.pairing.list((await this.auth.current(h)).sub);
  }
  @Delete('me/devices/:id') async revoke(
    @Headers('authorization') h: string,
    @Param('id') id: string,
  ) {
    return this.pairing.revoke((await this.auth.current(h)).sub, id);
  }
  @ApiOperation({
    summary:
      '10분·1회용 코드로 pairing, 재-pairing은 Authorization에 기존 디바이스 토큰을 보내 회전',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code', 'deviceName'],
      properties: Object.fromEntries(
        ['code', 'deviceName', 'platform', 'osVersion', 'appVersion', 'hostname'].map((key) => [
          key,
          { type: 'string' },
        ]),
      ),
    },
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['deviceId', 'deviceToken', 'userId'],
      properties: Object.fromEntries(
        ['deviceId', 'deviceToken', 'userId'].map((key) => [key, { type: 'string' }]),
      ),
    },
  })
  @Post('devices/pair')
  async pair(
    @Body(new ZodValidationPipe(DevicePairV2RequestSchema)) body: any,
    @Headers('authorization') h?: string,
  ) {
    // 웹의 JWT는 코드 소유자를 바꾸지 않는다. 디바이스 토큰일 때만 재-pairing을 수행한다.
    if (h) {
      try {
        await this.auth.current(h);
        h = undefined;
      } catch {}
    }
    const { code, deviceName, ...metadata } = body;
    return this.pairing.pair(code, deviceName, metadata, h);
  }
}
