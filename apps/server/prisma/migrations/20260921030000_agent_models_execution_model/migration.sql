-- 데몬이 CLI 에서 읽어 보고한 모델 목록 (정보성. capability 와 달리 서버 상한 없음)
ALTER TABLE `Agent` ADD COLUMN `models` JSON NULL;

-- 실행할 때 사람이 고른 모델. null 이면 데몬 기본값 → CLI 기본값
ALTER TABLE `Execution` ADD COLUMN `model` VARCHAR(191) NULL;
