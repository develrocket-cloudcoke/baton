-- 기존 provider와 Agent를 보존하면서 선택적 기능 협상 필드를 추가한다.
ALTER TABLE `Agent`
  MODIFY `provider` ENUM('CLAUDE_CODE', 'CODEX', 'AGY') NOT NULL DEFAULT 'CLAUDE_CODE',
  ADD COLUMN `capabilities` JSON NULL;
