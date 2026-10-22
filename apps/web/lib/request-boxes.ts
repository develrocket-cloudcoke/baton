/// 요청 목록의 "받은 요청 / 보낸 요청" 판정.
///
/// 두 탭은 **나와의 관계**로만 나눈다. 예전에는 둘 다 `isAdmin` 이면 무조건 통과시켜 조직 관리자에게
/// 두 탭이 똑같이 보였고, 소속 팀이 없으면(`myTeamIds.length === 0`) 모든 팀 요청을 받은 요청으로
/// 셌다(2026-09-23 dev). 관리자가 전부 보는 곳은 "전체" 탭이다.
export interface BoxRequest {
  state?: string;
  senderUserId: string;
  recipientUserId: string | null;
  recipientTeamId: string;
  claimedAt: string | Date | null;
  claimedBy?: { id: string } | null;
}

export function isInbox(req: BoxRequest, me: string, myTeamIds: string[]): boolean {
  if (req.state === 'WITHDRAWN') return false;
  if (req.recipientUserId === me || req.claimedBy?.id === me) return true;
  // 내가 보낸 요청은 받은 요청이 아니다. 내 팀 전체에 보내면 아래 "내 팀 앞" 규칙에 걸려 보낸 사람 자신의
  // 받은 요청에도 떴다(2026-09-23 dev, administrator → backend 팀). 나를 직접 지정한 경우만 위에서 받는다.
  if (req.senderUserId === me) return false;
  // 팀 앞으로 온 요청(개인 지정 없음·또는 누가 맡은 팀 요청)은 내 팀일 때만
  const teamAddressed = req.recipientUserId === null || req.claimedAt !== null;
  return teamAddressed && myTeamIds.includes(req.recipientTeamId);
}

export function isSent(req: BoxRequest, me: string): boolean {
  return req.senderUserId === me;
}
