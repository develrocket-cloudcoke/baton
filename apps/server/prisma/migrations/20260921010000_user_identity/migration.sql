-- 제공자 신원은 이메일과 독립적인 불변 키다. MySQL 8 NO PAD 이진 collation으로
-- 대소문자와 후행 공백을 구분해 서로 다른 subject가 합쳐지지 않게 한다.
ALTER TABLE `User` MODIFY `passwordHash` VARCHAR(191) NULL;
CREATE TABLE `UserIdentity` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `providerId` VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  `subject` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UserIdentity_providerId_subject_key` (`providerId`, `subject`),
  INDEX `UserIdentity_userId_idx` (`userId`),
  CONSTRAINT `UserIdentity_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- 기존 local 계정은 주소가 아니라 User ID로 연결한다. 새 seed 계정은 로그인 시 연결된다.
INSERT INTO `UserIdentity` (`id`, `userId`, `providerId`, `subject`)
SELECT UUID(), `id`, 'local', `id` FROM `User` WHERE `passwordHash` IS NOT NULL;
