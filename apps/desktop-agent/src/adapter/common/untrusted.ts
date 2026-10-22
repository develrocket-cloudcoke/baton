// CLO-110 H-4: 프롬프트의 신뢰 경계.
// 시스템(Baton)이 만든 부분과 외부 입력(요청 본문·제목·첨부 내용·이전 회차 결과)을 구분자로 감싼다.
// 구분자를 흉내 내 경계를 깨는 것을 막기 위해, 외부 입력 안에서 표식으로 쓰이는 토큰을 먼저 무력화한다.

export const UNTRUSTED_MARKER = 'BATON_UNTRUSTED_DATA';
export const UNTRUSTED_END_MARKER = 'END_BATON_UNTRUSTED_DATA';

// 외부 입력의 출처. 시스템 규약이 이 목록을 그대로 설명하므로 값을 바꾸면 규약 문구도 함께 고친다.
export type UntrustedKind = 'request_title' | 'request_body' | 'attachment_content' | 'previous_result';

const KIND_LABEL: Record<UntrustedKind, string> = {
  request_title: '요청 제목 (다른 사용자가 작성)',
  request_body: '요청 본문 (다른 사용자가 작성)',
  attachment_content: '첨부 문서 내용 (다른 사용자가 업로드)',
  previous_result: '이전 회차 실행 결과 (모델 출력)'
};

// 표식 전체를 흉내 낸 문자열 (`<<<BATON_UNTRUSTED_DATA …>>>`, `<<<END_BATON_UNTRUSTED_DATA>>>` 등)
const MARKER_LIKE = /<{2,}[^<>\n]*BATON[ _-]?UNTRUSTED[^<>\n]*>{2,}/gi;
// 위 치환을 피해 조각으로 남은 토큰. 표식은 이 토큰 없이는 만들 수 없으므로 여기서 위조가 끊긴다.
const MARKER_WORD = /\bEND[ _-]?BATON[ _-]?UNTRUSTED[A-Z0-9_]*|\bBATON[ _-]?UNTRUSTED[A-Z0-9_]*/gi;

export interface Sanitized {
  text: string;
  // 경계 표식을 흉내 낸 문자열이 있어 무력화했는가 (있으면 경고로 보고한다)
  tampered: boolean;
}

// 외부 입력에서 경계 표식 위조를 제거한다. 내용 자체는 버리지 않고 표식만 무력화한다.
export function sanitizeUntrusted(raw: string | null | undefined): Sanitized {
  const text = (raw ?? '').toString();
  if (!text) return { text: '', tampered: false };
  let tampered = false;
  let out = text.replace(MARKER_LIKE, () => {
    tampered = true;
    return '[BATON: 위조된 신뢰 경계 표식을 제거했습니다]';
  });
  out = out.replace(MARKER_WORD, () => {
    tampered = true;
    return 'BATON_(무효화된_표식)';
  });
  return { text: out, tampered };
}

// 외부 입력 한 덩어리를 경계 구획으로 감싼다. 안이 비어 있으면 빈 구획을 만들지 않는다.
export function untrustedBlock(kind: UntrustedKind, raw: string | null | undefined, note?: string): { text: string; tampered: boolean } {
  const { text, tampered } = sanitizeUntrusted(raw);
  if (!text.trim()) return { text: '', tampered };
  const attrs = `kind="${kind}"${note ? ` note="${note.replace(/"/g, "'")}"` : ''}`;
  return {
    text: `<<<${UNTRUSTED_MARKER} ${attrs}>>>\n${text}\n<<<${UNTRUSTED_END_MARKER} kind="${kind}">>>`,
    tampered
  };
}

export function untrustedKindLabel(kind: UntrustedKind): string {
  return KIND_LABEL[kind];
}
