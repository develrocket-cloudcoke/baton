# Baton

**Pass the work. Keep the context.**

사람과 AI 에이전트가 함께 업무를 이어받고 전달하는 협업 플랫폼입니다.

각자 자기 컴퓨터의 AI 에이전트와 일하다가, 그 결과와 맥락을 다른 팀원에게
넘깁니다. 받은 사람은 직접 검토해 수락·반려·거절하고, 수락하면 자신의
에이전트에게 추가 지시를 더해 이어서 맡깁니다. AI 가 다른 사람의 AI 를 직접
실행하지 않고, 모든 인계에 사람의 판단이 들어갑니다.

- **라이선스**: MIT 또는 Apache-2.0 중 선택 ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)). (c) 2026 cloudcoke
- 문서 목록과 읽는 순서는 [docs/README.md](docs/README.md) 를 보십시오

이 저장소는 제품 소스 코드와 설계 문서만 담는다. 검증 스크린샷, 인수 기록,
보안 검토, 사내 조사 같은 공개 불가 산출물은 별도의 비공개 저장소에 있다.
새 산출물을 어느 쪽에 넣을지 판단이 서지 않으면 내부 저장소에 넣는다.

## 개발 환경

Node.js 22.17.1, pnpm 10.15.0, Docker Desktop이 필요합니다. 의존성을 처음 한 번 설치한 뒤에는 아래 한 명령으로 MySQL 준비 대기, migration, 멱등 seed, API와 Web(real API 모드) 기동까지 처리합니다. `.env`가 없으면 스크립트가 `.env.example`을 복사합니다.

    pnpm install
    ./scripts/dev-up.sh

기동 후 Web은 http://127.0.0.1:3000, API health는 http://127.0.0.1:3001/health 에서 확인합니다. 실행 로그는 `.dev/logs/`, PID는 `.dev/pids/`에 남으며 다음 명령으로 확인·종료할 수 있습니다.

    ./scripts/dev-status.sh
    ./scripts/dev-down.sh

기본 종료는 MySQL 볼륨을 보존합니다. 완전히 초기화하려면 `./scripts/dev-down.sh --reset`을 사용합니다.

> **`WEB_URL` 주의**: 서버는 알림·이메일 링크(`webUrl`)를 `WEB_URL` 로 만듭니다. 이 값은 **브라우저로 실제 접속하는 origin 과 반드시 같아야** 합니다. `localhost:3000` 과 `127.0.0.1:3000` 은 서로 다른 origin 이라 로그인 세션(localStorage)이 분리되고, 알림을 클릭하면 로그아웃된 화면이 열립니다. `dev-up.sh` 는 `.env` 의 `WEB_URL` 이 비어 있으면 `http://127.0.0.1:$WEB_PORT` 로 맞춰 서버에 넣어 줍니다. 다른 주소로 접속한다면 `.env` 의 `WEB_URL` 도 함께 바꾸세요.

### Phase 1 테스트 시작

`docs/test-plan.md`의 **3장 Phase 1**을 기준으로 한 대의 Mac에서 다음 순서로 시작합니다.

1. 가짜 프로젝트 저장소를 만듭니다: `./scripts/fixture-backend-api.sh` (기본 `/tmp/baton-test-fixtures/backend-api`, `deployment.yaml` 의 `redis-servcie` 오타와 `verify.sh` 포함). 최초 1회만 생성해 두면 되며, 인수 드라이버(`scripts/acceptance/*.py`)가 매 실행 시 fixture 를 자동으로 되돌리므로(CLO-16) 테스트 간 수동 재실행이 필요 없습니다.
2. seed 계정은 조직 `example` 의 관리자 `admin@baton.local`, backend 팀 A `a@baton.local`, infra 팀 B `b@baton.local` 이며 비밀번호는 모두 `baton-dev-password` 입니다(backend↔infra 링크 허용). Chrome의 서로 다른 프로필 두 개를 열고 모두 `http://127.0.0.1:3000`에 접속해 A/B 로 로그인합니다. 스크린샷·자동화용으로 `?as=a` / `?as=b` / `?as=admin`(관리자가 만든 계정은 `?as=<이메일 접두어>`) 쿼리로 전환할 수 있습니다. 팀·사용자·팀 간 허용은 관리자로 `/admin/teams`, `/admin/users`, `/admin/team-links` 에서 관리합니다.
3. 메뉴바 앱을 `./scripts/desktop-build.sh`로 빌드한 뒤 `apps/desktop-macos/build/Baton.app`을 실행합니다. 팝오버 "설정" 탭에서 서버 URL `http://127.0.0.1:3001` 과 **프로젝트 목록**(이름 + 로컬 경로)을 저장합니다. pairing 코드는 **B 가 웹 `/me/devices` → "디바이스 추가"** 로 발급한 8자리(`XXXX-XXXX`, 10분·1회용) 코드를 입력합니다(전역 `PAIRING_CODE` 는 없어졌습니다). 성공하면 상태가 `connected` 가 되고 `/me/devices` 와 서버의 Agent/Project 목록(B 로그인 후 `GET /v1/agents`, `/v1/projects`)에 이 Mac 이 나타납니다. 만료·재사용 코드는 팝오버에 사유("만료된 pairing 코드입니다." 등)가 표시됩니다.
   - **프로젝트 여러 개** (04 §11.1): 설정 탭 "프로젝트 목록" 에서 "추가" 로 이름·경로를 여러 개 등록합니다. 저장하면 데몬이 각각을 서버 Project 로 등록하고 각 행에 `projectId` 를 채워 줍니다. 웹 실행 준비 화면의 "실행 프로젝트" 드롭다운에서 고른 프로젝트의 로컬 경로에서 Claude Code 가 실행됩니다. 목록에 없는 `projectId` 로 명령이 오면 데몬은 실행하지 않고 사유와 함께 FAILED 로 보고합니다. 구버전 설정(`프로젝트 경로` 한 칸)은 목록이 비어 있을 때만 프로젝트 1개로 취급합니다.
   - **실행 취소**: 실행 중 웹 요청 상세의 `실행 취소` 를 누르면 서버가 Execution 을 CANCELLED 로 바꾸고 데몬에 `execution.command.cancel_requested` 를 보냅니다. 데몬은 claude 를 SIGTERM → (5초) → SIGKILL 로 끝내고, Request 는 `READY_TO_RUN` 으로 돌아가 실행 준비 화면에서 다시 실행할 수 있습니다. 취소된 실행의 부분 변경 내역은 로컬 `~/.baton/executions/<id>` 에만 남습니다.
   - **데몬은 디바이스당 1개**만 붙습니다. 두 번째 데몬이 연결하면 서버가 기존 연결에 `connection.replaced` 를 보내고, 먼저 붙어 있던 데몬은 재연결하지 않고 exit 17 로 끝납니다(셸은 이 코드를 보면 재시작하지 않고 "다른 데몬이 이 디바이스에 연결되어 종료했습니다" 로 표시).
   - 데몬은 60초마다 heartbeat 를 보냅니다. 2분 동안 heartbeat 가 없으면 웹 `/me/devices` 와 Agent 목록이 OFFLINE 으로 바뀝니다.
   - 데몬은 기본으로 `sonnet` 모델을 씁니다. 비용을 줄이려면 앱을 `BATON_CLAUDE_MODEL=haiku BATON_MAX_TURNS=15` 환경변수와 함께 실행합니다 (자식 데몬이 상속). 개발 중 재빌드를 반복하면 Keychain 프롬프트가 뜨므로 `BATON_TOKEN_STORE=file` 로 실행하는 것을 권합니다(`open --env … apps/desktop-macos/build/Baton.app`).
   - 알림 권한: 첫 실행 때 macOS 알림 허용 프롬프트가 뜹니다. 프롬프트가 떠 있는 동안 앱을 강제 종료하면 해당 번들이 "거부" 로 남으므로 시스템 설정 → 알림에서 Baton 을 허용해야 합니다.
   - **추가 작업 요청(기획서 §18)**: 결과 검토 화면의 `Agent에게 추가 작업 요청` 에 지시를 넣으면, 같은 Claude 세션을 `claude --resume <세션id>` 로 이어받아 새 회차를 실행합니다. 프롬프트에는 이번 회차 지시만 싣고(원본 요청·첨부는 세션이 이미 갖고 있습니다), 결과 diff 는 **이번 회차 변경만** 담습니다. 회차별 결과는 탭으로 남고 **승인은 최신 회차만** 가능합니다(과거 회차는 버튼이 비활성이고 서버도 409 로 막습니다). 세션이 만료·삭제되어 이어갈 수 없으면 데몬이 새 세션에 원본 맥락을 다시 실어 한 번 재실행하고 그 사실을 진행 상태에 남깁니다.

4. Profile A에서 새 요청(문서 `api-error-analysis.md` + 첨부 `server.log`)을 보내면 B 의 Mac 에 알림 배너가 뜹니다. 수신 대상은 "사람"(B 지정) 또는 "팀 전체"(infra 팀원 전원에게 뿌리고 먼저 수락한 사람에게 배정)를 고를 수 있습니다. Profile B에서 열람 → 반려(사유) → A 재전송 → B 수락 → 실행 준비(Agent/Project 선택, 추가 지시, policy) → 실행. 데몬이 SSE 로 명령을 받아 Claude Code 를 실행하며, 진행 상태는 웹 요청 상세(2초 갱신)와 팝오버 "활동" 탭에 표시됩니다. 완료되면 B 가 결과(diff·result.md)를 검토하고, 필요하면 **추가 작업을 요청**(같은 세션 이어가기)한 뒤 최신 회차를 승인해 A 에게 전달합니다. 자세한 항목과 실패/재실행/거절 경로는 [테스트 계획서](docs/test-plan.md), 실제 수행 기록은 [MVP 인수 검증](docs/mvp-acceptance.md)을 참조하세요.

### 자동화 검증 (API 로 같은 흐름)

브라우저 없이 API 만으로 시나리오를 돌리는 드라이버는 `docs/mvp-acceptance.md` 의 "재현 절차" 절에 있습니다. 데몬만 단독으로 붙일 때는 콘솔 모드를 씁니다:

    pnpm --filter @baton/desktop-agent build
    # 코드는 웹 /me/devices 에서 발급 (B 로그인 후 POST /v1/me/pairing-codes 로도 발급 가능)
    node apps/desktop-agent/dist/cli.js login --code XXXX-XXXX --server http://127.0.0.1:3001 --project /tmp/baton-test-fixtures/backend-api
    # --project 를 여러 번(다른 경로로) 실행하면 프로젝트 목록에 쌓입니다.
    node apps/desktop-agent/dist/cli.js start --project /tmp/baton-test-fixtures/infra-tools
    BATON_CLAUDE_MODEL=haiku node apps/desktop-agent/dist/cli.js start

## 주요 workspace

- apps/server: NestJS 10 + Prisma 6 MySQL API 골격
- apps/web: Next.js 15 App Router 화면 골격
- apps/desktop-agent: Baton Desktop Agent CLI 골격
- packages/shared: 도메인 타입, 상태 전이, DTO와 zod schema
