CREATE TABLE `AuthSession` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `familyId` VARCHAR(191) NOT NULL,
  `tokenHash` VARCHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `replacedById` VARCHAR(191) NULL,
  `userAgent` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `AuthSession_tokenHash_key` (`tokenHash`),
  INDEX `AuthSession_userId_idx` (`userId`),
  INDEX `AuthSession_familyId_idx` (`familyId`),
  CONSTRAINT `AuthSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
