-- CLO-108: 강제할 수 없는 보호를 사람이 항목별로 승인하고 시작한 실행의 기록.
-- 기존 실행은 승인 없이 돌았으므로 전부 NULL 로 남는다(승인 하에 돌지 않았다는 뜻).
ALTER TABLE `Execution`
  ADD COLUMN `acknowledgedRisks` JSON NULL,
  ADD COLUMN `riskAcknowledgedAt` DATETIME(3) NULL,
  ADD COLUMN `riskAcknowledgedByUserId` VARCHAR(191) NULL;
