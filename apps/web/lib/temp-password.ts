// 신규 계정의 임시 비밀번호. 예전에는 화면에 `baton-temp-pass-123` 이 미리 채워져 있어서,
// 관리자가 그대로 제출하면 **조직의 모든 신규 계정이 알려진 고정 비밀번호**로 만들어졌다
// (2026-09-21 전수조사 결함 3).

/** 서버 스키마(CreateOrgUserSchema)가 요구하는 최소 길이. */
export const MIN_TEMP_PASSWORD_LENGTH = 8;

// 사람이 눈으로 읽고 한 번 받아 적는 값이라 헷갈리는 글자(0/O, 1/l/I)를 뺀다.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * 암호학적 난수로 임시 비밀번호를 만든다. `Math.random()` 을 쓰지 않는 이유는
 * 예측 가능한 값이면 고정 문자열을 고친 의미가 없기 때문이다.
 *
 * **브라우저에서만 부른다.** 서버 렌더에서 만들면 hydration 이 어긋난다.
 */
export function generateTempPassword(length = 16): string {
  const source = globalThis.crypto;
  if (!source?.getRandomValues) throw new Error('이 환경에서는 안전한 난수를 만들 수 없습니다.');
  const bytes = new Uint32Array(length);
  source.getRandomValues(bytes);
  // 256 이 알파벳 길이의 배수가 아니라 나머지 연산은 약간 치우치지만, 32비트 난수에서는
  // 그 편향이 무시할 수준이다(2^32 / 57 ≈ 7.5e7 — 한 글자당 편차 1e-8 미만).
  return Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length]).join('');
}

/** 제출 전에 통과해야 하는 최소 조건. 짧으면 서버가 400 으로 막지만 여기서 먼저 걸러 준다. */
export function isUsableTempPassword(value: string): boolean {
  return value.trim().length >= MIN_TEMP_PASSWORD_LENGTH;
}
