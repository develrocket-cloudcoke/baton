-- 보안 검토 M-6-2: 중앙 기록의 수정/삭제를 DB에서 거부한다.
-- 해시 체인은 별도 신뢰 앵커 없이는 관리자에게 재계산될 수 있어 MVP에서는
-- append-only를 선택했다. DDL/관리자 권한의 트리거 삭제·TRUNCATE까지 막지는 못한다.
-- MySQL FK cascade는 트리거를 실행하지 않으므로 참조 삭제/갱신도 RESTRICT한다.
ALTER TABLE `TimelineEvent` DROP FOREIGN KEY `TimelineEvent_requestId_fkey`,
  DROP FOREIGN KEY `TimelineEvent_requestRevisionId_fkey`,
  DROP FOREIGN KEY `TimelineEvent_executionId_fkey`;
ALTER TABLE `TimelineEvent`
  ADD CONSTRAINT `TimelineEvent_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `Request` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `TimelineEvent_requestRevisionId_fkey` FOREIGN KEY (`requestRevisionId`) REFERENCES `RequestRevision` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `TimelineEvent_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `Execution` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
-- 트리거는 prisma:audit-install로 별도 설치한다. 권한 부족이 스키마 배포를 막지 않게 한다.
