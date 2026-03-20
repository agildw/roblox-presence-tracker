-- CreateTable
CREATE TABLE `TelegramUser` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `telegramId` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TelegramUser_telegramId_key`(`telegramId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RobloxAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `robloxUserId` BIGINT NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `roblosecurity` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RobloxAccount_userId_key`(`userId`),
    UNIQUE INDEX `RobloxAccount_robloxUserId_key`(`robloxUserId`),
    INDEX `RobloxAccount_robloxUserId_idx`(`robloxUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Friend` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `robloxAccountId` INTEGER NOT NULL,
    `friendUserId` BIGINT NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `notifyOnline` BOOLEAN NOT NULL DEFAULT false,
    `notifyOffline` BOOLEAN NOT NULL DEFAULT false,
    `notifyGame` BOOLEAN NOT NULL DEFAULT false,
    `lastPresence` INTEGER NULL,
    `lastGameId` VARCHAR(191) NULL,
    `lastGameName` VARCHAR(191) NULL,
    `lastLocation` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `lastNotifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Friend_friendUserId_idx`(`friendUserId`),
    INDEX `Friend_robloxAccountId_lastPresence_idx`(`robloxAccountId`, `lastPresence`),
    UNIQUE INDEX `Friend_robloxAccountId_friendUserId_key`(`robloxAccountId`, `friendUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrackedUser` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `robloxAccountId` INTEGER NOT NULL,
    `robloxUserId` BIGINT NOT NULL,
    `username` VARCHAR(191) NULL,
    `displayName` VARCHAR(191) NULL,
    `notifyOnline` BOOLEAN NOT NULL DEFAULT true,
    `notifyOffline` BOOLEAN NOT NULL DEFAULT false,
    `notifyGame` BOOLEAN NOT NULL DEFAULT true,
    `lastPresence` INTEGER NULL,
    `lastGameId` VARCHAR(191) NULL,
    `lastGameName` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `lastNotifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TrackedUser_robloxUserId_idx`(`robloxUserId`),
    UNIQUE INDEX `TrackedUser_robloxAccountId_robloxUserId_key`(`robloxAccountId`, `robloxUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GameSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `robloxAccountId` INTEGER NOT NULL,
    `subjectId` BIGINT NOT NULL,
    `subjectType` ENUM('FRIEND', 'TRACKED') NOT NULL,
    `placeId` BIGINT NOT NULL,
    `universeId` BIGINT NULL,
    `gameName` VARCHAR(191) NULL,
    `startTime` DATETIME(3) NOT NULL,
    `endTime` DATETIME(3) NULL,
    `duration` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GameSession_subjectId_idx`(`subjectId`),
    INDEX `GameSession_robloxAccountId_startTime_idx`(`robloxAccountId`, `startTime`),
    INDEX `GameSession_robloxAccountId_subjectId_idx`(`robloxAccountId`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RobloxAccount` ADD CONSTRAINT `RobloxAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `TelegramUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Friend` ADD CONSTRAINT `Friend_robloxAccountId_fkey` FOREIGN KEY (`robloxAccountId`) REFERENCES `RobloxAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrackedUser` ADD CONSTRAINT `TrackedUser_robloxAccountId_fkey` FOREIGN KEY (`robloxAccountId`) REFERENCES `RobloxAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameSession` ADD CONSTRAINT `GameSession_robloxAccountId_fkey` FOREIGN KEY (`robloxAccountId`) REFERENCES `RobloxAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
