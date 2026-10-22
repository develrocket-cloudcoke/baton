import { ACCESS_MAX_AGE, REFRESH_MAX_AGE, REFRESH_COOKIE_PATH } from './auth/refresh-session';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotImplementedException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { AUTH_FLOW_COOKIES, AuthService } from './auth/auth.service';
import { AUTH_COOKIE_PATH, parseCookies } from './auth/state';
import { BatonService } from './baton.service';
@Controller()
export class AppController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(BatonService) private baton: BatonService,
  ) {}
  private async user(h?: string) {
    return (await this.auth.current(h)).sub;
  }
  private token(h?: string) {
    return (h || '').replace(/^Bearer\s+/i, '');
  }
  @Get('health') health() {
    return { status: 'ok', service: 'baton-server' };
  }
  @Get('v1/auth/describe') describeAuth() {
    return this.auth.describe();
  }
  /**
   * redirect 로그인 시작. 웹의 로그인 버튼이 여기로 온다(`describe().authorizeUrl`).
   * state 를 만들어 httpOnly 쿠키에 심고 외부 인증 서버로 보낸다.
   */
  @Get('v1/auth/authorize') async authorize(@Res() r: any) {
    const { url, cookies } = await this.auth.startAuthorization();
    for (const c of cookies) r.cookie(c.name, c.value, c.options);
    r.redirect(302, url);
  }

  /**
   * 외부 인증 서버의 콜백. PKCE 가 없는 제공자가 있어 코드 교환은 **서버에서만** 한다
   * — client_secret 이 브라우저에 가면 안 된다(설계 08 §7).
   */
  @Get('v1/auth/callback') async authCallback(
    @Query() q: any,
    @Headers('cookie') cookieHeader: string,
    @Res() r: any,
    @Headers('user-agent') userAgent?: string,
  ) {
    try {
      const v = await this.auth.callback(q, parseCookies(cookieHeader));
      const refreshToken = await this.auth.createRefreshSession(v.user.id, userAgent);
      this.setSessionCookies(r, v.token, refreshToken);
      // 한 번 쓴 state 는 즉시 버린다. 같은 code 로 다시 들어와도 통과하지 못한다.
      this.clearAuthFlow(r);
      r.redirect(302, v.redirectTo);
    } catch (e) {
      this.clearAuthFlow(r);
      // redirect 제공자가 아닌 설정에서는 이 경로 자체가 없는 것으로 둔다(501).
      if (e instanceof NotImplementedException) throw e;
      r.redirect(302, this.auth.loginErrorUrl(e));
    }
  }

  private clearAuthFlow(r: any) {
    for (const name of AUTH_FLOW_COOKIES) r.clearCookie(name, { path: AUTH_COOKIE_PATH });
  }
  private setSessionCookies(r: any, token: string, refreshToken: string) {
    const options = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
    r.cookie('baton_token', token, { ...options, path: '/', maxAge: ACCESS_MAX_AGE });
    r.cookie('baton_refresh', refreshToken, { ...options, path: REFRESH_COOKIE_PATH, maxAge: REFRESH_MAX_AGE });
  }

  private clearSessionCookies(r: any) {
    r.clearCookie('baton_token', { path: '/' });
    r.clearCookie('baton_refresh', { path: REFRESH_COOKIE_PATH });
  }

  @Post('v1/auth/refresh') async refresh(
    @Headers('cookie') cookieHeader: string,
    @Res({ passthrough: true }) r: any,
    @Headers('user-agent') userAgent?: string,
  ) {
    try {
      const session = await this.auth.refresh(parseCookies(cookieHeader).baton_refresh, userAgent);
      this.setSessionCookies(r, session.token, session.refreshToken);
      return { token: session.token };
    } catch (error) {
      this.clearSessionCookies(r);
      throw error;
    }
  }

  @Post('v1/auth/logout') async logout(
    @Res({ passthrough: true }) r: any,
    @Headers('cookie') cookieHeader?: string,
  ) {
    try { await this.auth.logout(parseCookies(cookieHeader).baton_refresh); }
    finally { this.clearSessionCookies(r); }
    return { ok: true };
  }

  @Post('v1/auth/login') async login(
    @Body() b: any, @Res({ passthrough: true }) r: any,
    @Headers('user-agent') userAgent?: string,
  ) {
    const v = await this.auth.login(b?.email, b?.password);
    const refreshToken = await this.auth.createRefreshSession(v.user.id, userAgent);
    this.setSessionCookies(r, v.token, refreshToken);
    return { token: v.token, user: v.user };
  }
  /* @Post('v1/requests/:id/executions') execution(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.user(h).then((u) => this.baton.execution(u, id, b));
  }
  @Post('v1/desktop/executions/:id/status') status(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.baton.status(this.token(h), id, b);
  }
  @Post('v1/desktop/executions/:id/result') result(
    @Headers('authorization') h: string,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    return this.baton.result(this.token(h), id, b);
  }
  @Post('v1/results/:id/approve-and-send') approve(
    @Headers('authorization') h: string,
    @Param('id') id: string,
  ) {
    return this.user(h).then((u) => this.baton.approve(u, id));
  } */
  // 과거 폴링 전용 진단 경로다. 실제 데몬 스트림은 DesktopController가 담당한다.
  @Get('v1/desktop/events/replay') async stream(
    @Headers('authorization') h: string,
    @Headers('last-event-id') last: string,
    @Res() r: any,
  ) {
    const events = await this.baton.outbox(this.token(h), last);
    r.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    r.flushHeaders();
    for (const e of events)
      r.write(
        'id: ' + e.id + '\nevent: ' + e.eventName + '\ndata: ' + JSON.stringify(e.payload) + '\n\n',
      );
    const timer = setInterval(() => r.write(': ping\n\n'), 15000);
    r.on('close', () => clearInterval(timer));
  }
}
