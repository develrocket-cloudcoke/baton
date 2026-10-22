import type { PrismaClient } from '@prisma/client';

// 보안 검토 M-6-2: 트리거는 선택적 DB 방어이며 서비스 기동의 전제는 아니다.
export const auditTriggers = [
  {
    name: 'TimelineEvent_no_update',
    sql: "CREATE TRIGGER `TimelineEvent_no_update` BEFORE UPDATE ON `TimelineEvent`\nFOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit.append_only: TimelineEvent UPDATE denied';",
  },
  {
    name: 'TimelineEvent_no_delete',
    sql: "CREATE TRIGGER `TimelineEvent_no_delete` BEFORE DELETE ON `TimelineEvent`\nFOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit.append_only: TimelineEvent DELETE denied';",
  },
  {
    name: 'Execution_approval_immutable',
    sql: "CREATE TRIGGER `Execution_approval_immutable` BEFORE UPDATE ON `Execution`\nFOR EACH ROW\nBEGIN\n  IF NOT (OLD.acknowledgedRisks <=> NEW.acknowledgedRisks)\n    OR NOT (OLD.riskAcknowledgedAt <=> NEW.riskAcknowledgedAt)\n    OR NOT (OLD.riskAcknowledgedByUserId <=> NEW.riskAcknowledgedByUserId)\n    OR NOT (OLD.agentCapabilitiesSnapshot <=> NEW.agentCapabilitiesSnapshot) THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit.append_only: Execution approval UPDATE denied';\n  END IF;\nEND;",
  },
  {
    name: 'ExecutionApproval_no_delete',
    sql: "CREATE TRIGGER `ExecutionApproval_no_delete` BEFORE DELETE ON `ExecutionApproval` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit.append_only: ExecutionApproval DELETE denied';",
  },
  {
    name: 'ExecutionApproval_immutable',
    // 원문/마감은 생성 이후 고정, 결정은 PENDING에서 한 번만 허용한다.
    sql: `CREATE TRIGGER ExecutionApproval_immutable BEFORE UPDATE ON ExecutionApproval
FOR EACH ROW
BEGIN
  IF OLD.status <> 'PENDING'
    OR NOT (OLD.id <=> NEW.id)
    OR NOT (OLD.executionId <=> NEW.executionId)
    OR NOT (OLD.toolName <=> NEW.toolName)
    OR NOT (OLD.detail <=> NEW.detail)
    OR NOT (OLD.reason <=> NEW.reason)
    OR NOT (OLD.expiresAt <=> NEW.expiresAt)
    OR NOT (OLD.createdAt <=> NEW.createdAt)
    OR NEW.status = 'PENDING'
    OR NEW.decidedAt IS NULL
    OR (NEW.status IN ('ALLOWED', 'DENIED') AND NEW.decidedByUserId IS NULL)
    OR (NEW.status = 'EXPIRED' AND NEW.decidedByUserId IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit.immutable: ExecutionApproval UPDATE denied';
  END IF;
END;`,
  },
] as const;

export async function missingAuditTriggers(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ name: string }[]>`
    SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()`;
  const present = new Set(rows.map((row) => row.name));
  return auditTriggers.map((trigger) => trigger.name).filter((name) => !present.has(name));
}
