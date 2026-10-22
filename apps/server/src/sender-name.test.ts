import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { senderDisplayName } from './common/sender-name';

// 2026-09-21 전수조사 결함 11: 발신자 이름이 없을 때 `'A'` 를 채워 넣어, 그 값이
// 러너의 프롬프트에 `"요청자: A"` 로 들어갔다. 에이전트가 없는 사람 이름을 실명처럼 다뤘다.

test('이름 → 이메일 순으로 쓰고, 둘 다 없으면 아무것도 보내지 않는다', () => {
  assert.equal(senderDisplayName({ displayName: '김백엔드', email: 'kim@x.test' }), '김백엔드');
  assert.equal(senderDisplayName({ displayName: null, email: 'kim@x.test' }), 'kim@x.test');
  assert.equal(senderDisplayName({ displayName: '   ', email: 'kim@x.test' }), 'kim@x.test');
  // 여기서 '요청자' 같은 대체어를 지어내지 않는다 — 프롬프트 조립기가 이미 값이 없으면
  // "(요청자: …)" 절 자체를 빼므로, 빈 자리가 가짜 이름보다 정확하다.
  for (const empty of [null, undefined, {}, { displayName: null, email: null }, { email: '  ' }])
    assert.equal(senderDisplayName(empty as any), undefined);
});

test('undefined 인 senderName 은 payload 에서 키째 빠진다', () => {
  // 서버는 payload 를 JSON 으로 저장·전송한다. undefined 는 직렬화에서 사라지므로
  // 데몬 스키마(senderName optional)와 그대로 맞는다.
  const payload = { title: '배포 확인', senderName: senderDisplayName(null) };
  assert.equal('senderName' in JSON.parse(JSON.stringify(payload)), false);
});

test("서버 어디에도 'A' 기본값이 남아 있지 않다", () => {
  for (const relative of ['executions/executions.service.ts', 'requests/requests.service.ts']) {
    const code = readFileSync(path.join(__dirname, relative), 'utf8');
    assert.equal(/senderName:.*\?\? 'A'/.test(code), false, relative);
    assert.ok(code.includes('senderName: senderDisplayName('), relative);
  }
});
