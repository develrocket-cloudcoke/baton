import assert from 'node:assert/strict';
import test from 'node:test';
import { isInbox, isSent, type BoxRequest } from '../lib/request-boxes';

const me = 'me', other = 'other', myTeam = 't-mine', otherTeam = 't-other';
const req = (p: Partial<BoxRequest>): BoxRequest => ({
  senderUserId: other, recipientUserId: null, recipientTeamId: otherTeam, claimedAt: null, claimedBy: null, ...p,
});

// 2026-09-23 dev: 조직 관리자에게 받은/보낸 탭이 똑같이 보였다(isAdmin 이면 둘 다 통과).
test('내가 보낸 요청은 보낸 요청에만, 받은 요청에는 없다', () => {
  const r = req({ senderUserId: me, recipientUserId: other });
  assert.equal(isSent(r, me), true);
  assert.equal(isInbox(r, me, [myTeam]), false);
});

test('나에게 온 요청·내가 맡은 요청은 받은 요청', () => {
  assert.equal(isInbox(req({ recipientUserId: me }), me, []), true);
  assert.equal(isInbox(req({ claimedAt: new Date(), claimedBy: { id: me } }), me, []), true);
  assert.equal(isSent(req({ recipientUserId: me }), me), false);
});

test('팀 앞 요청은 내 팀일 때만 받은 요청 — 팀이 없다고 전부 받지 않는다', () => {
  assert.equal(isInbox(req({ recipientTeamId: myTeam }), me, [myTeam]), true);
  assert.equal(isInbox(req({ recipientTeamId: otherTeam }), me, [myTeam]), false);
  assert.equal(isInbox(req({ recipientTeamId: otherTeam }), me, []), false);
});

test('다른 사람에게 개인 지정된 요청은 내 팀이어도 받은 요청이 아니다', () => {
  assert.equal(isInbox(req({ recipientUserId: other, recipientTeamId: myTeam }), me, [myTeam]), false);
});

test('내 팀 전체에 내가 보낸 요청은 보낸 요청에만 뜬다', () => {
  const r = req({ senderUserId: me, recipientUserId: null, recipientTeamId: myTeam });
  assert.equal(isSent(r, me), true);
  assert.equal(isInbox(r, me, [myTeam]), false);
});

test('나 자신을 수신자로 지정해 보낸 요청은 양쪽에 뜬다', () => {
  const r = req({ senderUserId: me, recipientUserId: me, recipientTeamId: myTeam });
  assert.equal(isSent(r, me), true);
  assert.equal(isInbox(r, me, [myTeam]), true);
});

test('철회 요청은 개인·팀 받은 요청에서 빠지고 보낸 요청에는 남는다', () => {
  for (const r of [req({ state: 'WITHDRAWN', recipientUserId: me }), req({ state: 'WITHDRAWN', recipientTeamId: myTeam })]) {
    assert.equal(isInbox(r, me, [myTeam]), false);
  }
  assert.equal(isSent(req({ state: 'WITHDRAWN', senderUserId: me }), me), true);
});
