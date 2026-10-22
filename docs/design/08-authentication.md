# 08. 로그인 — 교체 가능한 인증 어댑터

지금 Baton 에는 **로그인 화면이 없다.** 웹은 열면 자동으로 로그인되고 상단 "역할"
스위처로 아무 계정이나 될 수 있다(`auth-provider.tsx`). 개발 편의용이지만 사람을
붙이는 순간 권한 분리가 성립하지 않는다 — 2026-09-18 2인 테스트에서 실제로
"상대가 내 계정에 들어갈 수 있다" 는 상태로 진행했다.

이 문서는 실제 로그인을 넣되, **인증 제공자를 갈아 끼울 수 있게** 하는 경계를 정한다.
첫 구현은 사내 accounts 서버이고, 다른 조직은 자기 것을 붙일 수 있어야 한다.

관련: [01 도메인·API](01-domain-and-api.md), [05 조직·팀](05-organization-teams.md)

## 1. 왜 어댑터인가

Baton 은 나중에 다른 조직도 쓴다. 그 조직마다 인증 체계가 다르다(사내 SSO, Google,
GitHub, 자체 계정). **accounts 고유 동작이 코드 전반에 스며들면 그때 못 바꾼다.**

동시에 과하게 추상화하지 않는다. 지금 필요한 경계는 하나다 — *"이 사람이 누구인지
확인하고, Baton 의 User 로 연결한다."* 그 이후는 전부 기존 코드 그대로다.

## 2. 지금 구조에서 바뀌는 곳은 두 군데뿐

```
apps/server/src/auth/auth.service.ts
  login(email, password)  ← 발급 지점. 여기만 제공자로 바뀐다
  current(header)         ← 검증 지점. 컨트롤러 10개가 이걸 쓴다
```

`current()` 는 **바뀌지 않는다.** 이게 이 설계의 핵심이다.

로그인에 성공하면 Baton 이 **자기 세션 토큰을 새로 발급**한다. 외부 제공자의 토큰을
그대로 들고 다니지 않는다. 그래서:

- 매 요청마다 외부 서버에 묻지 않는다. accounts 가 죽어도 이미 로그인한 사람은 계속 쓴다
- 컨트롤러 10개와 데몬 토큰 경로는 손대지 않는다
- 제공자를 바꿔도 세션 규약은 그대로다

```
  [사람] --(제공자 방식)--> IdentityProvider.verify() --> 외부 신원
                                      |
                                      v
                          UserIdentity 로 Baton User 매핑
                                      |
                                      v
                        Baton 세션 JWT 발급 (기존 형식 그대로)
                                      |
                                      v
                   이후 모든 요청: AuthService.current() — 변경 없음
```

## 3. 어댑터 경계

```ts
interface ExternalIdentity {
  providerId: string;   // 'accounts' | 'local' | ...
  subject: string;      // 제공자 안에서 **영구 불변**인 식별자
  email?: string;
  displayName?: string;
}

interface IdentityProvider {
  readonly id: string;
  /** 웹이 로그인 화면을 어떻게 그릴지 결정한다 */
  describe(): { kind: 'password' | 'redirect'; authorizeUrl?: string };
  /** kind='password' */
  authenticate?(email: string, password: string): Promise<ExternalIdentity>;
  /** kind='redirect' — OAuth2/OIDC 콜백의 code 를 신원으로 바꾼다 */
  exchange?(code: string, redirectUri: string, context?: ExchangeContext): Promise<ExternalIdentity>;
}

interface RedirectIdentityProvider extends IdentityProvider {
  /** 설정에 고정된 콜백 주소. 요청에 실려 온 redirect_uri 는 쓰지 않는다 */
  readonly redirectUri: string;
  startAuthorization(state: string): Promise<{ url: string; codeVerifier?: string }>;
}

/** authorize 에서 콜백까지 넘겨야 하는 값. 둘 다 브라우저에 보이면 안 된다 */
interface ExchangeContext {
  codeVerifier?: string;   // PKCE 를 쓰는 제공자만 (accounts 는 없다)
  state?: string;          // 이미 검증된 state. 제공자는 여기서 nonce 를 되계산한다
}
```

### `describe().authorizeUrl` 은 외부 주소가 아니다

redirect 제공자의 `authorizeUrl` 은 **Baton 서버의 `/v1/auth/authorize`** 다. 매 시도마다
새 state 를 만들어야 하는데 정적 URL 에는 담을 수 없기 때문이다. 웹은 이 주소를 링크로
걸기만 하고, 외부 인증 서버 주소는 서버가 302 로 만들어 준다. 주소의 origin 은 설정에
고정된 `*_REDIRECT_URI` 에서 가져오므로 환경변수가 따로 없다.

```
웹 /login  ──a href──>  서버 GET /v1/auth/authorize
                          state 생성 → httpOnly 쿠키, 302 → 제공자 authorize
                        서버 GET /v1/auth/callback?code&state
                          state 검증 → exchange → 세션 발급 → 302 → 웹 /login/callback#token=…
```

토큰을 fragment 로 넘기는 이유는 쿼리에 실으면 웹 서버 접근 로그와 Referer 헤더에
세션 토큰이 그대로 남기 때문이다. 콜백이 실패하면 `/login?auth_error=1` 로 보낸다.

`subject` 가 이 설계의 유일한 까다로운 부분이다. **이메일을 키로 쓰면 안 된다** —
사람이 이메일을 바꾸면 다른 사람이 되어 버리고, 남의 계정을 넘겨받을 수도 있다.
제공자가 주는 불변 식별자를 쓴다.

## 4. 저장 구조

```
UserIdentity
  id           uuid
  userId       → User
  providerId   string     'accounts'
  subject      string     제공자의 불변 식별자
  createdAt

  @@unique([providerId, subject])
```

- `User.passwordHash` 는 `local` 제공자 전용이 된다. nullable 로 바꾼다
- 한 사람이 여러 제공자를 가질 수 있다(나중에 계정 연결)
- **자동 가입 여부는 정책이다.** 기본은 "이미 있는 User 에만 연결". 처음 보는
  subject 가 오면 거부한다 — 조직 내부 도구이므로 아무나 들어오면 안 된다.
  `AUTH_AUTO_PROVISION=true` 일 때만 User 를 새로 만든다

## 5. 설정

```
AUTH_PROVIDER=local | accounts        (기본 local — 지금 동작 유지)
AUTH_AUTO_PROVISION=false
ACCOUNTS_* ...                         제공자별 값
```

**기본값을 바꾸지 않는다.** `AUTH_PROVIDER` 를 주지 않으면 지금과 똑같이 동작해
기존 개발·테스트 흐름과 seed 계정이 그대로 산다.

## 6. 웹

- `/login` 을 실제 화면으로 만든다. `describe()` 가 `password` 면 입력 폼,
  `redirect` 면 "accounts 로 로그인" 버튼 하나
- **역할 스위처는 `AUTH_PROVIDER=local` 일 때만 보인다.** 실제 인증을 켠 환경에서는
  사라져야 한다. 지금 이게 권한 분리를 무너뜨리는 주범이다
- 자동 로그인(`auth-provider.tsx` 의 seed 계정 로그인)도 같은 조건으로 막는다

## 7. accounts 어댑터

비표준 사내 인증 서버를 연결하는 accounts 어댑터의 규약이다. 주소는 예시다.

### 확인된 규약

| | 값 |
|---|---|
| issuer (prod) | `https://accounts.example.com` |
| issuer (dev) | `https://accounts.dev.example.com` (사내망 주소) |
| authorize | `GET /oauth/v2/authorize` — 307 확인 |
| token | `POST /oauth/v2/token` — GET 은 405 확인 |
| userinfo | `GET /oauth/v2/user` — 무인증 401 확인 |
| userinfo 응답 | `{ id, email, name, uid, emailVerified }` |

**subject 는 `id` 를 쓴다.** `uid` 는 사용자명 성격이라 바뀔 수 있다.
계정 이관·재가입 시 `id` 유지 여부는 인증 서버의 규약을 확인해야 한다. 그래서
`(providerId, subject)` 복합 유니크를 키로 두고 email 은 보조로만 쓴다(4절과 동일).

### 표준 OIDC 가 아니다

discovery 없음, `id_token` 없음, JWKS 없음, PKCE 없음. 인터페이스는 3절의
OIDC 모양(authorize → token → userinfo)을 유지하고 **비표준은 accounts 구현체
안에서만 흡수한다.** 엔드포인트는 하드코딩하고, 신원은 `id_token` 대신 userinfo
호출로 얻는다.

### 그래서 세션을 우리가 발급하는 것이 선택이 아니라 필수다

JWKS 가 없으니 외부 토큰을 **로컬에서 검증할 방법이 없다.** 그 토큰을 세션으로 쓰면
매 요청마다 accounts 에 userinfo 를 물어야 한다. 2절의 결정(로그인 시 Baton 세션
토큰 발급)이 이 제약을 정면으로 해결한다 — userinfo 는 **로그인 순간 한 번만** 부른다.

대가는 해지 지연이다. accounts 에서 계정을 막아도 이미 발급된 Baton 세션은 만료까지
산다. 그래서 `current()` 에 **Baton 쪽 `User.status` 확인을 추가**한다(지금은 JWT
서명만 보고 통과시킨다). Baton 에서 막으면 즉시 끊기고, accounts 쪽 해지는 세션
만료까지가 상한이다.

### 코드 교환은 서버에서 한다

PKCE 가 없으므로 confidential client + `client_secret` 이다. **시크릿은 브라우저에
둘 수 없다.** 따라서 콜백은 Next.js 가 아니라 **Baton 서버**가 받고, 서버가
`POST /oauth/v2/token` 으로 교환한 뒤 Baton 세션을 발급해 웹으로 돌려준다.
CSRF 는 `state` 로 막는다(우리가 만들고 우리가 검증한다).

### 🔴 붙이기 전에 아는 결함

**1. 오픈 리다이렉트.** 미등록 `client_id` 에 임의 `redirect_uri` 를 그대로 307 로
돌려준다. dev 에서 재확인했다:

```
/oauth/v2/authorize?client_id=baton_probe_unregistered&redirect_uri=https://example.com/cb
→ 307 location: https://example.com/cb?error=unauthorized_client&error_description=invalid_client
```

RFC 6749 §3.1.2.4 위반이다. 에러 파라미터만 실려 심각도는 낮지만 **"등록됐는지"를
redirect_uri 응답으로 판단하면 안 된다.** 등록 확인은 `client_id` 차이로만 성립한다
(등록됐으면 `/login?prevUrl=...`). 우리 쪽에서는 redirect URI 를 설정에 고정하고
`state` 를 우리가 검증한다.

**2. 인증 서버 장애.** accounts 가 죽으면
**신규 로그인이 전부 막힌다.** 이미 로그인한 사람은 Baton 세션으로 계속 쓴다(위 구조
덕분이다). 그래도 운영 의존이 하나 늘어나는 것이므로, `AUTH_PROVIDER=local` 을
비상 경로로 남겨 둔다.

### 연결 전 준비

- 인증 서버에 클라이언트와 redirect URI 를 등록한다.
- `client_secret` 을 인증 서버와 Baton 서버 환경에 설정한다.
- 로그인 검증에 사용할 테스트 계정을 준비한다.

accounts 구현체는 계약 테스트(가짜 accounts 서버)로 검증한 뒤 실제 인증 서버에 연결한다.

### 구현 상태 (2026-09-21)

어댑터 둘(`oidc`, `accounts`)과 서버 콜백 경로가 들어갔다. accounts 는 실계정이 없어
가짜 accounts 서버를 띄운 계약 테스트로만 검증했다 — `apps/server/src/auth-accounts.test.ts`.
표준 OIDC 는 discovery·JWKS·PKCE 를 실제로 쓰는 가짜 제공자로 검증했다(`auth-oidc.test.ts`).

실계정이 생기면 확인해야 할 것 둘:

- **scope**. `ACCOUNTS_SCOPE` 기본값 `openid profile email` 은 추측이다. 등록 때 확인한다
- **토큰 엔드포인트의 클라이언트 인증 방식**. 표준 협상(discovery)이 없어 물어볼 수 없어서
  본문(`client_secret_post`)으로 보낸다. Basic 만 받는다면 고친다

### accounts 에 조직·팀 정보는 없다

인증 서버의 사용자 정보에 Baton 의 조직·팀 정보가 없으므로 **Baton 이 자체 관리한다** — 8절의 인가 분리와 일치한다.

## 8. 범위 밖

- 데몬의 디바이스 토큰. 이건 Baton 이 발급하는 별도 자격증명이고 사람 로그인과
  무관하다(05 §3.4). accounts 를 붙여도 pairing 흐름은 그대로다
- 권한(역할·조직 멤버십). accounts 가 조직 정보를 준다 해도 **Baton 의 팀 구조와
  1:1 이 아니다.** 인증(누구인가)만 위임하고 인가(무엇을 할 수 있는가)는 Baton 이
  계속 판단한다
- 세션 만료·갱신 정책은 현재 값을 유지한다. 바꾸려면 별도로 정한다
