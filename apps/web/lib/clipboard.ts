/**
 * 클립보드 복사. **http 로 접속하면 `navigator.clipboard` 자체가 없다.**
 *
 * Clipboard API 는 secure context(https 또는 localhost)에서만 정의된다. 사내망 주소로
 * HTTP 접속하면 그 조건을 못 맞출 수 있다 — 예전에는 그대로
 * `navigator.clipboard.writeText` 를 불러서 pairing 코드 복사 버튼이 오류를 냈다.
 *
 * 그래서 쓸 수 있으면 Clipboard API 를, 아니면 숨긴 textarea + execCommand 로 떨어진다.
 * 둘 다 실패하면 false 를 돌려주니 호출자가 "직접 선택해서 복사하세요" 를 안내해야 한다.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 등 — 아래 대체 경로로 계속한다
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  // 화면 밖으로 보내되 focus 가 가능해야 한다 (display:none 이면 선택이 안 된다)
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}
