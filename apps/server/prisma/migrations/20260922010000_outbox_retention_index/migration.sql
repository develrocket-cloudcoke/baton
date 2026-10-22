-- 디바이스와 무관한 시간순 보존 정리에서 전체 테이블 스캔을 피한다.
CREATE INDEX `OutboxEvent_createdAt_id_idx` ON `OutboxEvent`(`createdAt`, `id`);
