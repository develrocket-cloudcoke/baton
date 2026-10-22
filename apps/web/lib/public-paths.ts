/// 로그인하지 않아도 열리는 화면.
///
/// `/login/callback` 도 여기 있어야 한다. 외부 로그인(accounts 등)에서 돌아온 브라우저는
/// 아직 토큰을 저장하기 전이라 로그인 안 된 상태다. 이 경로를 막으면 AuthGate 가 콜백
/// 페이지를 그리지 않고 /login 으로 돌려보내, 토큰을 받고도 로그인이 끝나지 않는다
/// (2026-09-23 dev accounts 전환 때 발견).
const PUBLIC_PATHS = new Set(['/login', '/login/callback']);

export function isPublicPath(pathname: string | null | undefined): boolean {
  return !!pathname && PUBLIC_PATHS.has(pathname);
}
