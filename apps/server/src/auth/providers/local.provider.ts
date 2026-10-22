import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma.service';
import { ExternalIdentity, IdentityProvider } from '../identity-provider';

@Injectable()
export class LocalProvider implements IdentityProvider {
  readonly id = 'local';
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  describe() {
    return { kind: 'password' as const };
  }
  async authenticate(email: string, password: string): Promise<ExternalIdentity> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !user.passwordHash ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw new UnauthorizedException();
    }
    // 기존 seed/관리자 생성 계정 호환. 비밀번호로 증명한 기존 User만 연결한다.
    // 이메일은 로그인 입력일 뿐이며 subject는 주소 변경에도 같은 User.id다.
    // 외부 신원에 이런 연결을 적용하거나 신규 User를 자동 생성하지 않는다.
    const identity = await this.prisma.userIdentity.upsert({
      where: { providerId_subject: { providerId: this.id, subject: user.id } },
      create: { providerId: this.id, subject: user.id, userId: user.id },
      update: {},
    });
    if (identity.userId !== user.id) throw new UnauthorizedException();
    return {
      providerId: this.id,
      subject: user.id,
      email: user.email,
      displayName: user.displayName,
    };
  }
}
