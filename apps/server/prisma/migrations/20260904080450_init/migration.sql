-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Team` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamMembership` (
    `teamId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('MEMBER') NOT NULL DEFAULT 'MEMBER',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`teamId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Device` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Device_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Agent` (
    `id` VARCHAR(191) NOT NULL,
    `ownerUserId` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `provider` ENUM('CLAUDE_CODE') NOT NULL DEFAULT 'CLAUDE_CODE',
    `displayName` VARCHAR(191) NOT NULL,
    `status` ENUM('ONLINE', 'OFFLINE', 'BUSY', 'DISABLED') NOT NULL DEFAULT 'OFFLINE',
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `ownerUserId` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `localPathHint` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Request` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `senderUserId` VARCHAR(191) NOT NULL,
    `recipientUserId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `state` ENUM('DRAFT', 'SENT', 'DELIVERED', 'REVIEWING', 'ACCEPTED', 'RETURNED', 'REJECTED', 'READY_TO_RUN', 'RUNNING', 'RESULT_REVIEW', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'DRAFT',
    `currentRevisionNo` INTEGER NOT NULL DEFAULT 1,
    `currentRevisionId` VARCHAR(191) NULL,
    `returnReason` TEXT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RequestRevision` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `revisionNo` INTEGER NOT NULL,
    `originalInstruction` TEXT NOT NULL,
    `documentVersionIds` JSON NOT NULL,
    `artifactIds` JSON NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RequestRevision_requestId_revisionNo_key`(`requestId`, `revisionNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Document` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `ownerUserId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL DEFAULT 'text/markdown',
    `currentVersionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DocumentVersion` (
    `id` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `versionNo` INTEGER NOT NULL,
    `contentRef` VARCHAR(191) NOT NULL,
    `contentSha256` VARCHAR(191) NOT NULL,
    `createdByType` ENUM('HUMAN', 'AGENT') NOT NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByAgentId` VARCHAR(191) NULL,
    `changeNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DocumentVersion_documentId_versionNo_key`(`documentId`, `versionNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Artifact` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `ownerUserId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `kind` ENUM('REQUEST_ATTACHMENT', 'RESULT_ATTACHMENT', 'PATCH', 'TEST_OUTPUT') NOT NULL,
    `filename` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `storageRef` VARCHAR(191) NOT NULL,
    `sha256` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Execution` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `requestRevisionId` VARCHAR(191) NOT NULL,
    `executorUserId` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `additionalInstruction` TEXT NOT NULL,
    `effectiveInstructionRef` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Result` (
    `id` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NOT NULL,
    `summary` TEXT NOT NULL,
    `changedFiles` JSON NOT NULL,
    `testSummary` TEXT NULL,
    `resultDocumentVersionId` VARCHAR(191) NULL,
    `artifactIds` JSON NOT NULL,
    `reviewStatus` ENUM('PENDING', 'APPROVED', 'CHANGES_REQUESTED') NOT NULL DEFAULT 'PENDING',
    `reviewedByUserId` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Result_executionId_key`(`executionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TimelineEvent` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `requestRevisionId` VARCHAR(191) NULL,
    `executionId` VARCHAR(191) NULL,
    `actorType` ENUM('HUMAN', 'DESKTOP_AGENT', 'SERVER') NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `agentId` VARCHAR(191) NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `payload` JSON NOT NULL,

    INDEX `TimelineEvent_requestId_occurredAt_idx`(`requestId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NULL,
    `eventName` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,

    INDEX `OutboxEvent_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Team` ADD CONSTRAINT `Team_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamMembership` ADD CONSTRAINT `TeamMembership_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamMembership` ADD CONSTRAINT `TeamMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Agent` ADD CONSTRAINT `Agent_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Agent` ADD CONSTRAINT `Agent_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_senderUserId_fkey` FOREIGN KEY (`senderUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Request` ADD CONSTRAINT `Request_recipientUserId_fkey` FOREIGN KEY (`recipientUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestRevision` ADD CONSTRAINT `RequestRevision_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `Request`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestRevision` ADD CONSTRAINT `RequestRevision_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DocumentVersion` ADD CONSTRAINT `DocumentVersion_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `Document`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Artifact` ADD CONSTRAINT `Artifact_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Artifact` ADD CONSTRAINT `Artifact_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Artifact` ADD CONSTRAINT `Artifact_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `Request`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Execution` ADD CONSTRAINT `Execution_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `Request`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Execution` ADD CONSTRAINT `Execution_requestRevisionId_fkey` FOREIGN KEY (`requestRevisionId`) REFERENCES `RequestRevision`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Execution` ADD CONSTRAINT `Execution_executorUserId_fkey` FOREIGN KEY (`executorUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Execution` ADD CONSTRAINT `Execution_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Execution` ADD CONSTRAINT `Execution_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Result` ADD CONSTRAINT `Result_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `Execution`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimelineEvent` ADD CONSTRAINT `TimelineEvent_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `Request`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimelineEvent` ADD CONSTRAINT `TimelineEvent_requestRevisionId_fkey` FOREIGN KEY (`requestRevisionId`) REFERENCES `RequestRevision`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimelineEvent` ADD CONSTRAINT `TimelineEvent_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `Execution`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboxEvent` ADD CONSTRAINT `OutboxEvent_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboxEvent` ADD CONSTRAINT `OutboxEvent_executionId_fkey` FOREIGN KEY (`executionId`) REFERENCES `Execution`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
