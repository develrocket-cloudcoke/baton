import { LocalProvider } from './providers/local.provider';
import { buildRedirectProvider } from './providers/factory';
import {
  IDENTITY_PROVIDERS,
  IdentityProvider,
  IdentityProviderRegistry,
  readAuthConfig,
} from './identity-provider';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { readSessionOptions, SESSION_OPTIONS } from './session-options';
import { sessionSecret } from './state';
@Module({
  imports: [
    JwtModule.register({
      secret: sessionSecret(),
      signOptions: { expiresIn: '8h' },
    }),
  ],
  providers: [
    LocalProvider,
    {
      provide: IDENTITY_PROVIDERS,
      useFactory: (local: LocalProvider): IdentityProvider[] => {
        // local 은 늘 등록한다(설계 08 §7 — accounts 가 죽었을 때의 비상 경로).
        // redirect 제공자는 AUTH_PROVIDER 가 그것을 가리킬 때만 만든다. 설정이 모자라면
        // 여기서 바로 죽어야 한다 — 로그인 버튼을 누른 사람이 처음 알게 되면 안 된다.
        const config = readAuthConfig();
        const redirect =
          config.providerId === local.id ? null : buildRedirectProvider(config.providerId);
        return redirect ? [local, redirect] : [local];
      },
      inject: [LocalProvider],
    },
    {
      provide: IdentityProviderRegistry,
      useFactory: (providers: IdentityProvider[]) => new IdentityProviderRegistry(providers),
      inject: [IDENTITY_PROVIDERS],
    },
    { provide: SESSION_OPTIONS, useFactory: () => readSessionOptions() },
    AuthService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
