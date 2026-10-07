-- AlterTable
ALTER TABLE `telegramuser` ADD COLUMN `disabledAt` DATETIME(3) NULL,
    ADD COLUMN `isDisabled` BOOLEAN NOT NULL DEFAULT false;
