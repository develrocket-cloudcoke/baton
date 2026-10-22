import { ApiBearerAuth, ApiForbiddenResponse, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { CreateUploadSchema } from '@baton/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LocalDiskStorage, StorageService } from './storage.service';
import { DesktopService } from '../desktop/desktop.service';
@ApiTags('documents-and-artifacts')
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '05 §11.2: 발신 팀 멤버 또는 연결된 요청 접근 권한자(발신자·확정 수신자·팀 전달 수신 팀원)만 접근. 디바이스 토큰은 소유 사용자 권한 적용.',
})
@Controller('v1')
export class StorageController {
  // tsx(esbuild) 로 도는 e2e 는 decorator metadata 가 없어 명시적 @Inject 가 필요하다 (다른 컨트롤러와 동일, W5d-2 수정)
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(StorageService) private service: StorageService,
    @Inject(LocalDiskStorage) private store: LocalDiskStorage,
    @Inject(DesktopService) private desktop: DesktopService,
  ) {}
  private async user(h: string) {
    try {
      return (await this.auth.current(h)).sub;
    } catch {
      // 결과물은 데몬의 device token으로도 같은 저장소에 올린다.
      return (await this.desktop.device(h)).userId;
    }
  }
  @Post('uploads') upload(
    @Headers('authorization') h: string,
    @Body(new ZodValidationPipe(CreateUploadSchema)) b: any,
  ) {
    return this.user(h).then((u) => this.service.create(u, b));
  }
  @Post('uploads/:id/complete') complete(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body() body: { sha256: string },
  ) {
    return this.user(h).then((u) => this.service.complete(u, id, body.sha256));
  }
  @Get('artifacts/:id') artifact(@Headers('authorization') h: string, @Param('id') id: string, @Query('disposition') disposition?: string) {
    if (disposition && !['inline', 'attachment'].includes(disposition)) throw new BadRequestException('잘못된 표시 방식');
    return this.user(h).then((u) => this.service.artifact(u, id, disposition === 'inline' ? 'inline' : 'attachment'));
  }
  @Put('storage/local/:key') async put(
    @Param('key') key: string,
    @Query('sha256') sha: string,
    @Query('token') token: string,
    @Req() req: any,
  ) {
    if (!this.store.valid(key, sha, token))
      throw new ForbiddenException('유효하지 않은 업로드 URL');
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha) throw new BadRequestException('sha256 불일치');
    await this.store.put(key, bytes);
    return { ok: true };
  }
  // 원문 바이트를 그대로 내려준다. Buffer 를 반환하면 Nest 가 {"type":"Buffer","data":[…]} 로 직렬화해
  // 데몬의 sha256 검증이 실패하고 웹 결과 화면에 바이트 배열이 보였다 (W4b §4-9, W5d-2 수정).
  @Get('storage/local/:key') async get(@Param('key') key: string, @Query() query: Record<string, string>, @Res() res: any) {
    if (!this.store.validGet(key, query.expires, query.disposition, query.contentType, query.token))
      throw new ForbiddenException('만료되었거나 유효하지 않은 다운로드 URL');
    const bytes = await this.store.get(key);
    res.set({ 'Content-Type': query.contentType, 'Content-Disposition': query.disposition,
      'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  }
}
