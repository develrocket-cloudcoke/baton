-- DropForeignKey
ALTER TABLE `Request` DROP FOREIGN KEY `Request_teamId_fkey`;

-- DropForeignKey
ALTER TABLE `Request` DROP FOREIGN KEY `Request_recipientUserId_fkey`;

-- AlterTable
ALTER TABLE `Team` ADD COLUMN `orgId` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `TeamMembership` MODIFY `role` ENUM('TEAM_LEAD', 'MEMBER') NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE `Device` ADD COLUMN `revokedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Request` DROP COLUMN `teamId`,
    ADD COLUMN `claimedAt` DATETIME(3) NULL,
    ADD COLUMN `recipientTeamId` VARCHAR(191) NOT NULL,
    ADD COLUMN `senderTeamId` VARCHAR(191) NOT NULL,
    MODIFY `recipientUserId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `TimelineEvent` MODIFY `requestId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Organization` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Organization_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgMembership` (
    `orgId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('ORG_ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`orgId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamLink` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `fromTeamId` VARCHAR(191) NOT NULL,
    `toTeamId` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TeamLink_fromTeamId_toTeamId_key`(`fromTeamId`, `toTeamId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PairingCode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PairingCode_codeHash_key`(`codeHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Team_orgId_name_key` ON `Team`(`orgId`, `name`);

-- AddForeignKey
ALTER TABLE `Organization` ADD CONSTRAINT `Organization_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgMembership` ADD CONSTRAINT `OrgMembership_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgMembership` ADD CONSTRAINT `OrgMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamLink` ADD CONSTRAINT `TeamLink_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamLink` ADD CONSTRAINT `TeamLink_fromTeamId_fkey` FOREIGN KEY (`fromTeamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamLink` ADD CONSTRAINT `TeamLink_toTeamId_fkey` FOREIGN KEY (`toTeamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamLink` ADD CONSTRAINT `TeamLink_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PairingCode` ADD CONSTRAINT `PairingCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Team` ADD CONSTRAINT `Team_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_senderTeamId_fkey` FOREIGN KEY (`senderTeamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_recipientTeamId_fkey` FOREIGN KEY (`recipientTeamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_recipientUserId_fkey` FOREIGN KEY (`recipientUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

