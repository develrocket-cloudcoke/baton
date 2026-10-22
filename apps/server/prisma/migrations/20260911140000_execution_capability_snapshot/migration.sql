-- CLO-110(보안 검토 M-6-1): 실행 시점의 provider·securityTier·capability 전문 스냅샷.
-- 승인 항목이 0 건인 실행에도 남겨, 나중에 capability 가 바뀌어도 그때 무엇을 근거로 승인했는지 추적할 수 있게 한다.
-- 기존 실행은 스냅샷 없이 돌았으므로 전부 NULL 로 남는다.
ALTER TABLE `Execution`
  ADD COLUMN `agentCapabilitiesSnapshot` JSON NULL;
