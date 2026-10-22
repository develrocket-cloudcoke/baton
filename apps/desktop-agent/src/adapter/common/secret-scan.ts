// CLO-110 H-4-④: 결과 유출 측 방어.
// 인젝션을 완전히 막을 수는 없으므로 마지막 홉을 점검한다 — 결과 문서·패치에 알려진 시크릿 패턴이 있으면
// 결과를 버리지 않고 **경고와 함께 보고**한다(무엇이 어디서 나왔는지 사람이 판단해야 한다).

export interface SecretPattern {
  key: string;
  label: string;
  re: RegExp;
}

// 오탐을 줄이려고 형태가 뚜렷한 것만 넣는다. 새 패턴을 넣을 때는 반드시 접두사·길이를 함께 고정한다.
export const SECRET_PATTERNS: SecretPattern[] = [
  { key: 'aws_access_key_id', label: 'AWS Access Key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { key: 'aws_secret_access_key', label: 'AWS Secret Access Key (aws_secret_access_key=…)', re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}\b/gi },
  { key: 'github_token', label: 'GitHub 토큰', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { key: 'anthropic_api_key', label: 'Anthropic API Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { key: 'openai_api_key', label: 'OpenAI API Key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { key: 'google_api_key', label: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { key: 'slack_token', label: 'Slack 토큰', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { key: 'private_key_pem', label: 'PEM 개인키 헤더', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { key: 'jwt', label: 'JWT 토큰', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { key: 'baton_device_token', label: 'Baton 디바이스 토큰', re: /\bbdt_[A-Za-z0-9_-]{16,}/g }
];

export interface SecretFinding {
  key: string;
  label: string;
  // 산출물 이름 (result.md, patch, summary …)
  source: string;
  // 마스킹된 미리보기. 원문을 로그·서버로 다시 흘리지 않는다.
  masked: string;
  count: number;
}

// 앞 4자·뒤 2자만 남기고 가린다. 어떤 값인지 사람이 짚을 수는 있고 그대로 재사용할 수는 없는 정도.
export function maskSecret(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-2)}(${value.length}자)`;
}

export function scanSecrets(text: string | null | undefined, source: string): SecretFinding[] {
  if (!text) return [];
  const findings: SecretFinding[] = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    const matches = text.match(re);
    if (!matches || !matches.length) continue;
    findings.push({ key: p.key, label: p.label, source, masked: maskSecret(matches[0]), count: matches.length });
  }
  return findings;
}

// 사람이 읽는 한 줄 경고. 결과 요약 맨 앞에 붙인다.
export function secretWarningLine(findings: SecretFinding[]): string {
  const detail = findings.map((f) => `${f.label}×${f.count}(${f.source}: ${f.masked})`).join(', ');
  return `⚠️ 결과물에서 시크릿으로 보이는 값이 발견되었습니다 — ${detail}. 승인·공유 전에 반드시 확인하세요.`;
}
