import { ApiBearerAuth, ApiForbiddenResponse, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { CreateDocumentSchema, CreateDocumentVersionSchema } from '@baton/shared';
import { AuthService } from '../auth/auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DesktopService } from '../desktop/desktop.service';
import { DocumentsService } from './documents.service';
@ApiTags('documents-and-artifacts')
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '05 §11.2: 발신 팀 멤버 또는 연결된 요청 접근 권한자(발신자·확정 수신자·팀 전달 수신 팀원)만 접근. 디바이스 토큰은 소유 사용자 권한 적용.',
})
@Controller('v1')
export class DocumentsController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(DocumentsService) private documents: DocumentsService,
    @Inject(DesktopService) private desktop: DesktopService,
  ) {}
  private async user(header: string) {
    return (await this.auth.current(header)).sub;
  }
  // 문서 본문은 웹(사용자 JWT)뿐 아니라 데몬(device token)도 내려받는다.
  private async userOrDevice(header: string) {
    try {
      return await this.user(header);
    } catch {
      return (await this.desktop.device(header)).userId;
    }
  }
  @Post('requests/:id/documents') create(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateDocumentSchema)) body: any,
  ) {
    return this.user(h).then((user) => this.documents.create(user, id, body));
  }
  @Get('documents/:id/versions') versions(
    @Headers('authorization') h: string,
    @Param('id') id: string,
  ) {
    return this.user(h).then((user) => this.documents.versions(user, id));
  }
  @Post('documents/:id/versions') version(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateDocumentVersionSchema)) body: any,
  ) {
    return this.user(h).then((user) => this.documents.addVersion(user, id, body));
  }
  @Get('documents/versions/:versionId') versionDetail(
    @Headers('authorization') h: string,
    @Param('versionId') versionId: string,
  ) {
    return this.userOrDevice(h).then((user) => this.documents.version(user, versionId));
  }
  // 실행 명령 payload 의 attachments[].downloadUrl 이 가리키는 경로 (원문 그대로)
  @Get('documents/versions/:versionId/download') async download(
    @Headers('authorization') h: string,
    @Param('versionId') versionId: string,
    @Res() res: any,
  ) {
    const user = await this.userOrDevice(h);
    const version = await this.documents.version(user, versionId);
    res.set({ 'Content-Type': `${version.mimeType}; charset=utf-8` });
    res.send(version.content);
  }
}
