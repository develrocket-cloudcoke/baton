-- CLO-141 결과 검토 출구 3개 (반려·거절·결과 폐기)
--
-- 전부 가산적이다. 기존 행은 reviewStatus 가 그대로 유지되고 새 컬럼은 NULL 로 채워진다.
-- 되돌릴 때도 컬럼 세 개를 지우고 enum 에서 DISCARDED 를 빼면 된다(그 값을 쓴 행이 없을 때).

-- 결과를 채택하지 않고 버린 경우. 거절(종결)과 결과 폐기(재실행)가 같은 값이고,
-- 둘의 구분은 Request.state 와 타임라인 이벤트가 한다.
ALTER TABLE `Result`
  MODIFY `reviewStatus` ENUM('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'DISCARDED') NOT NULL DEFAULT 'PENDING';

-- 반려하면서 요청자에게 연 result.md 아티팩트 정확히 하나.
-- 본문을 복사하지 않고 id 만 둔다 — 아티팩트는 sha256 주소지정이라 불변이다.
-- Artifact 로의 FK 는 걸지 않는다. 아티팩트가 지워져도 "그때 무엇을 열었다"는 감사 기록은 남아야 한다.
ALTER TABLE `Result` ADD COLUMN `disclosedArtifactId` VARCHAR(191) NULL;
ALTER TABLE `Result` ADD COLUMN `disclosedAt` DATETIME(3) NULL;
ALTER TABLE `Result` ADD COLUMN `disclosedByUserId` VARCHAR(191) NULL;
