import { issueRefreshSession, rotateRefreshSession, revokeRefreshFamily } from './refresh-session';
import {
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import {
  ExternalIdentity,
  IdentityProviderRegistry,
  isRedirectProvider,
} from './identity-provider';
import { readSessionOptions, SESSION_OPTIONS, SessionOptions } from './session-options';
import {
  AUTH_COOKIE_PATH,
  AUTH_STATE_COOKIE,
  AUTH_VERIFIER_COOKIE,
  createState,
  STATE_TTL_SECONDS,
  verifyState,
} from './state';

// 콜백이 끝날 때까지만 사는 쿠키. 컨트롤러가 그대로 심고 지운다.
export interface AuthCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    // Strict 면 외부 인증 서버에서 돌아오는 요청에 쿠키가 실리지 않아 매번 실패한다.
    sameSite: 'lax';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

export const AUTH_FLOW_COOKIES = [AUTH_STATE_COOKIE, AUTH_VERIFIER_COOKIE];

export class AuthRejection extends UnauthorizedException {
  constructor(readonly reason: 'not_staff' | 'unlinked' | 'failed') {
    super();
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(JwtService) private jwt: JwtService,
    @Inject(IdentityProviderRegistry) private providers: IdentityProviderRegistry,
    @Inject(SESSION_OPTIONS) private options: SessionOptions = readSessionOptions(),
  ) {}

  describe() {
    const provider = this.providers.active;
    return {
      providerId: provider.id,
      ...provider.describe(),
      ...(provider.logoutUrl ? { logoutUrl: provider.logoutUrl(this.options.webUrl) } : {}),
    };
  }

  async login(email: string, password: string) {
    const provider = this.providers.active;
    if (
      provider.describe().kind !== 'password' ||
      !provider.authenticate ||
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email ||
      !password
    ) {
      throw new UnauthorizedException();
    }
    let identity: ExternalIdentity;
    try {
      identity = await provider.authenticate(email, password);
    } catch {
      throw new UnauthorizedException();
    }
    return this.issueSession(identity);
  }

  /**
   * redirect 로그인의 시작점. 웹의 "로그인" 버튼은 외부 서버가 아니라 여기로 온다.
   * 매 시도마다 새 state 를 만들어야 해서 정적 URL 로는 안 되기 때문이다.
   */
  async startAuthorization(): Promise<{ url: string; cookies: AuthCookie[] }> {
    const provider = this.redirectProvider();
    const state = createState(this.options.stateSecret);
    let start;
    try {
      start = await provider.startAuthorization(state);
    } catch {
      // discovery 실패 등 외부 사정이다. 인증 실패(401)와 구분해서 알린다.
      throw new ServiceUnavailableException('인증 서버에 연결할 수 없습니다.');
    }
    const secure = provider.redirectUri.startsWith('https:');
    const cookies = [this.flowCookie(AUTH_STATE_COOKIE, state, secure)];
    if (start.codeVerifier)
      cookies.push(this.flowCookie(AUTH_VERIFIER_COOKIE, start.codeVerifier, secure));
    return { url: start.url, cookies };
  }

  /**
   * 외부 인증 서버가 돌려보낸 콜백. 여기서 Baton 세션을 발급한다.
   * 순서가 중요하다 — **state 를 통과하기 전에는 code 를 제공자에 넘기지 않는다.**
   */
  async callback(
    query: { code?: unknown; state?: unknown; error?: unknown } | undefined,
    cookies: Record<string, string>,
  ) {
    const provider = this.redirectProvider();
    // 사용자가 동의를 거부했거나 제공자가 오류를 실어 보냈다. 이때도 code 는 없다.
    if (query?.error) throw new UnauthorizedException();
    if (!verifyState(cookies?.[AUTH_STATE_COOKIE], query?.state, this.options.stateSecret))
      throw new UnauthorizedException();
    const code = query?.code;
    if (typeof code !== 'string' || !code || code.length > 2048) throw new UnauthorizedException();
    let identity: ExternalIdentity;
    try {
      identity = await provider.exchange(code, provider.redirectUri, {
        codeVerifier: cookies?.[AUTH_VERIFIER_COOKIE],
        state: query.state as string,
      });
    } catch {
      throw new UnauthorizedException();
    }
    const session = await this.issueSession(identity);
    // 토큰은 쿼리가 아니라 fragment 로 넘긴다. 쿼리에 실으면 웹 서버 접근 로그와
    // Referer 헤더에 세션 토큰이 그대로 남는다.
    const url = new URL('/login/callback', this.options.webUrl);
    url.hash = `token=${encodeURIComponent(session.token)}`;
    return { ...session, redirectTo: url.toString() };
  }

  /** 콜백이 실패했을 때 브라우저를 보낼 곳. 이유는 알려 주지 않는다. */
  loginErrorUrl(error?: unknown): string {
    const url = new URL('/login', this.options.webUrl);
    url.searchParams.set('auth_error', error instanceof AuthRejection ? error.reason : 'failed');
    return url.toString();
  }

  private redirectProvider() {
    const provider = this.providers.active;
    if (!isRedirectProvider(provider))
      throw new NotImplementedException('redirect 인증 콜백은 아직 설정되지 않았습니다.');
    return provider;
  }

  private flowCookie(name: string, value: string, secure: boolean): AuthCookie {
    return {
      name,
      value,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: AUTH_COOKIE_PATH,
        maxAge: STATE_TTL_SECONDS * 1000,
      },
    };
  }

  private async issueSession(identity: ExternalIdentity) {
    if (
      !identity ||
      identity.providerId !== this.providers.active.id ||
      typeof identity.subject !== 'string' ||
      !identity.subject ||
      identity.subject.length > 255
    )
      throw new UnauthorizedException();
    const key = { providerId: identity.providerId, subject: identity.subject };
    let linked = await this.prisma.userIdentity.findUnique({
      where: { providerId_subject: key },
      include: { user: true },
    });
    if (!linked && this.providers.config.autoProvision) {
      const staffGate = this.providers.active.autoProvisionRequiresStaff === true;
      // 기존 수동 연결 계정에는 적용하지 않는다. 직원 판정은 신규 가입에만 사용한다.
      if (staffGate && identity.staff !== true) {
        // 직원이 아니어도 운영자가 link-identity 로 따로 연결할 수 있게 식별 키를 남긴다(비밀은 넣지 않는다).
        this.logger.warn(
          JSON.stringify({
            event: 'auth.not_staff',
            ...key,
            ...(typeof identity.email === 'string' ? { email: identity.email.slice(0, 320) } : {}),
          }),
        );
        throw new AuthRejection('not_staff');
      }
      // 이메일은 표시용 속성이다. 같은 이메일의 기존 계정과 연결하지 않는다.
      // 이메일 미제공 제공자를 위해 내부 전용 주소를 만들되 신원 키는 위 복합 키다.
      const email =
        identity.email ||
        `identity-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}@baton.invalid`;
      try {
        const data = {
          email,
          displayName: (identity.displayName || identity.email || identity.subject).slice(0, 191),
          passwordHash: null,
          identities: { create: key },
        };
        if (staffGate) {
          await this.prisma.$transaction(async (tx) => {
            const configured = this.providers.config.defaultOrgId;
            const orgs = await tx.organization.findMany({
              where: configured ? { id: configured } : {},
              take: 2,
              select: { id: true },
            });
            if (orgs.length !== 1) {
              this.logger.warn(
                JSON.stringify({
                  event: 'auth.provision_org_unavailable',
                  reason: configured ? 'configured_org_missing' : 'organization_count_not_one',
                }),
              );
              throw new AuthRejection('failed');
            }
            const user = await tx.user.create({
              data: { ...data, orgMemberships: { create: { orgId: orgs[0].id, role: 'MEMBER' } } },
            });
            await tx.timelineEvent.create({
              data: {
                actorType: 'SERVER',
                eventType: 'user.auto_provisioned',
                payload: { userId: user.id, orgId: orgs[0].id, ...key },
              },
            });
          });
        } else {
          await this.prisma.user.create({ data });
        }
      } catch (error) {
        // 동시 첫 로그인은 복합 키의 승자를 다시 읽는다. 이메일 중복은 계정 연결이 아니다.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002'))
          throw error;
      }
      linked = await this.prisma.userIdentity.findUnique({
        where: { providerId_subject: key },
        include: { user: true },
      });
    }
    if (!linked) {
      // 검증된 신원의 연결에 필요한 필드만 기록한다. 제공자 응답/code/token은 기록하지 않는다.
      // JSON 문자열로 개행을 이스케이프해 한 줄 로그를 유지한다.
      this.logger.warn(
        JSON.stringify({
          event: 'auth.identity_unlinked',
          ...key,
          ...(typeof identity.email === 'string' ? { email: identity.email.slice(0, 320) } : {}),
        }),
      );
      throw new AuthRejection('unlinked');
    }
    if (linked.user.status !== 'ACTIVE') throw new UnauthorizedException();
    const { passwordHash: _, ...publicUser } = linked.user;
    return {
      user: publicUser,
      token: await this.jwt.signAsync({ sub: linked.user.id, email: linked.user.email }),
    };
  }

  createRefreshSession(userId: string, userAgent?: string) {
    return issueRefreshSession(this.prisma, userId, userAgent);
  }

  refresh(raw?: string, userAgent?: string) {
    return rotateRefreshSession(this.prisma, this.jwt, raw, userAgent);
  }

  logout(raw?: string) {
    return revokeRefreshFamily(this.prisma, raw);
  }

  async current(value?: string) {
    if (!value) throw new UnauthorizedException();
    try {
      const token =
        value.replace(/^Bearer\s+/i, '').match(/(?:^|;\s*)(?:token|baton_token)=([^;]+)/)?.[1] ??
        value.replace(/^Bearer\s+/i, '');
      const claims = await this.jwt.verifyAsync<{ sub: string }>(decodeURIComponent(token));
      if (!claims.sub || typeof claims.sub !== 'string') throw new UnauthorizedException();
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { status: true },
      });
      if (user?.status !== 'ACTIVE') throw new UnauthorizedException();
      return claims;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
