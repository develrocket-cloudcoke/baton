/**
 * 데몬·에이전트에 보낼 발신자 표시 이름.
 *
 * 이름도 이메일도 없으면 **아무것도 보내지 않는다**(undefined). 예전에는 `'A'` 를 넣었는데,
 * 그 값이 러너의 프롬프트 조립기까지 그대로 내려가 `"요청자: A"` 가 되어 에이전트가
 * 없는 사람 이름을 실명처럼 취급했다(2026-09-21 전수조사 결함 11).
 *
 * 대체어를 새로 지어내지 않는 이유는, 프롬프트 조립기가 이미 senderName 이 없으면
 * "(요청자: …)" 절 자체를 빼도록 돼 있기 때문이다. 빈 자리가 가짜 이름보다 정확하다.
 */
export function senderDisplayName(
  sender: { displayName?: string | null; email?: string | null } | null | undefined,
): string | undefined {
  const name = sender?.displayName?.trim();
  if (name) return name;
  const email = sender?.email?.trim();
  return email || undefined;
}
