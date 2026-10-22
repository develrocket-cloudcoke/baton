-- 실행 중 승인. 참조 삭제/cascade로 감사 기록을 우회하지 못하게 한다.
CREATE TABLE `ExecutionApproval` (
 `id` VARCHAR(191) NOT NULL,
 `executionId` VARCHAR(191) NOT NULL,
 `toolName` VARCHAR(80) NOT NULL,
 `detail` TEXT NOT NULL,
 `reason` VARCHAR(500) NOT NULL,
 `status` ENUM('PENDING','ALLOWED','DENIED','EXPIRED') NOT NULL DEFAULT 'PENDING',
 `decidedByUserId` VARCHAR(191) NULL,
 `decidedAt` DATETIME(3) NULL,
 `expiresAt` DATETIME(3) NOT NULL,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`),
 INDEX `ExecutionApproval_executionId_status_idx` (`executionId`, `status`),
 CONSTRAINT `ExecutionApproval_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `Execution` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT `ExecutionApproval_decidedByUserId_fkey` FOREIGN KEY (`decidedByUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- 기존 배포 방식대로 감사 트리거는 prisma:audit-install에서 설치한다.
