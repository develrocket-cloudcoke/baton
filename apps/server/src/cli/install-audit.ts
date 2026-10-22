import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { auditTriggers, missingAuditTriggers } from '../audit-protection';

const db = new PrismaClient();
async function main() {
  const missing = new Set(await missingAuditTriggers(db));
  for (const trigger of auditTriggers) {
    if (!missing.has(trigger.name)) continue;
    // CREATE TRIGGER는 MySQL prepared statement 프로토콜에서 지원되지 않는다.
    // 기존 Prisma CLI의 비준비 SQL 실행 경로를 쓰고 SQL은 stdin으로만 전달한다.
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'db',
        'execute',
        '--stdin',
        '--schema',
        'prisma/schema.prisma',
      ],
      { input: trigger.sql, encoding: 'utf8' },
    );
    if (result.status === 0) {
      console.info(`audit.installed: ${trigger.name}`);
      continue;
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const permissionDenied =
      /\b(1419|1227|1142)\b|You do not have the SUPER privilege|Access denied; you need.*privilege|TRIGGER command denied/i.test(
        output,
      );
    if (!permissionDenied) throw new Error('트리거 설치 오류');
    // 배포 환경은 BATON_AUDIT_REQUIRED=true 로 띄운다. 권한이 없어 건너뛰면 감사 기록
    // 변조 방어 없이 서비스가 뜨는데, 경고 한 줄은 아무도 안 본다. 그 경우 기동을 막는다.
    // (MySQL 은 binlog 가 켜져 있으면 TRIGGER 권한만으로는 부족하고 SUPER 또는
    //  log_bin_trust_function_creators=1 이 필요하다 — 오류 1419)
    if (process.env.BATON_AUDIT_REQUIRED === 'true') {
      console.error(`audit.install_required_but_denied: ${trigger.name}\n${output.trim()}`);
      process.exitCode = 1;
      return;
    }
    console.warn(
      `audit.install_skipped: ${trigger.name}; MySQL TRIGGER/SUPER 권한 부족. 앱은 계속 동작하지만 감사 기록 변조 방어가 불완전합니다.`,
    );
  }
}
main()
  .catch(() => {
    console.error(
      'audit.install_failed: 권한 부족 이외의 오류입니다. DB 연결과 스키마를 확인하세요.',
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
