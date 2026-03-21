-- CreateTable
CREATE TABLE `PresenceSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `robloxAccountId` INTEGER NOT NULL,
    `subjectId` BIGINT NOT NULL,
    `subjectType` ENUM('FRIEND', 'TRACKED') NOT NULL,
    `presenceType` INTEGER NOT NULL,
    `startTime` DATETIME(3) NOT NULL,
    `endTime` DATETIME(3) NULL,
    `duration` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PresenceSession_subjectId_idx`(`subjectId`),
    INDEX `PresenceSession_robloxAccountId_startTime_idx`(`robloxAccountId`, `startTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PresenceSession` ADD CONSTRAINT `PresenceSession_robloxAccountId_fkey` FOREIGN KEY (`robloxAccountId`) REFERENCES `RobloxAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
