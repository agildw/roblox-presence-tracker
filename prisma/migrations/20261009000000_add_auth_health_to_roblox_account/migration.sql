-- AlterTable
ALTER TABLE `RobloxAccount` ADD COLUMN `authFailureCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `authLastAlertAt` DATETIME(3) NULL;