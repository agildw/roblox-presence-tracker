-- Additive migration: persistent subject identity + username history.
--
-- Why: `Friend` and `TrackedUser` describe only the CURRENT lists. Unfriending
-- or `/untrack` deletes those rows (by design), which made historical
-- `GameSession` / `PresenceSession` rows unresolvable by username even though
-- the rows themselves survive. `SubjectIdentity` is the durable per-account
-- (subjectId → usernames) mapping; `SubjectUsername` records every handle ever
-- observed so a renamed user stays searchable.
--
-- SAFETY: this migration is strictly additive. No existing table or row is
-- altered or deleted — only two new tables are created, then populated from the
-- data that is already present.

-- CreateTable
CREATE TABLE `SubjectIdentity` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `robloxAccountId` INTEGER NOT NULL,
    `robloxUserId` BIGINT NOT NULL,
    `username` VARCHAR(191) NULL,
    `displayName` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastResolvedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SubjectIdentity_robloxUserId_idx`(`robloxUserId`),
    INDEX `SubjectIdentity_robloxAccountId_lastSeenAt_idx`(`robloxAccountId`, `lastSeenAt`),
    INDEX `SubjectIdentity_robloxAccountId_username_idx`(`robloxAccountId`, `username`),
    UNIQUE INDEX `SubjectIdentity_robloxAccountId_robloxUserId_key`(`robloxAccountId`, `robloxUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SubjectUsername` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `subjectIdentityId` INTEGER NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isCurrent` BOOLEAN NOT NULL DEFAULT false,

    INDEX `SubjectUsername_username_idx`(`username`),
    INDEX `SubjectUsername_subjectIdentityId_isCurrent_idx`(`subjectIdentityId`, `isCurrent`),
    UNIQUE INDEX `SubjectUsername_subjectIdentityId_username_key`(`subjectIdentityId`, `username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SubjectIdentity` ADD CONSTRAINT `SubjectIdentity_robloxAccountId_fkey` FOREIGN KEY (`robloxAccountId`) REFERENCES `RobloxAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubjectUsername` ADD CONSTRAINT `SubjectUsername_subjectIdentityId_fkey` FOREIGN KEY (`subjectIdentityId`) REFERENCES `SubjectIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill (data preserving, idempotent)
--
-- Every subject that is currently a friend, currently tracked, or that already
-- has session rows gets exactly one SubjectIdentity row per account. Subjects
-- whose username is no longer known (only sessions remain) are still created
-- with NULL username so their sessions stay resolvable by Rooblox user id.
--
-- usernames are stored lower-cased, matching the case-insensitive lookup the
-- services perform.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `SubjectIdentity`
  (`robloxAccountId`, `robloxUserId`, `username`, `displayName`, `lastSeenAt`, `firstSeenAt`, `lastResolvedAt`, `createdAt`, `updatedAt`)
SELECT
  s.`robloxAccountId`,
  s.`robloxUserId`,
  MAX(LOWER(s.`username`)),
  MAX(s.`displayName`),
  MAX(s.`lastSeenAt`),
  MIN(s.`firstSeen`),
  NOW(3),
  NOW(3),
  NOW(3)
FROM (
  SELECT `robloxAccountId`, `friendUserId` AS `robloxUserId`, `username`, `displayName`,
         `lastSeenAt`, `createdAt` AS `firstSeen`
    FROM `Friend`
  UNION ALL
  SELECT `robloxAccountId`, `robloxUserId`, `username`, `displayName`,
         `lastSeenAt`, `createdAt` AS `firstSeen`
    FROM `TrackedUser`
  UNION ALL
  SELECT gs.`robloxAccountId`, gs.`subjectId` AS `robloxUserId`, NULL AS `username`, NULL AS `displayName`,
         NULL AS `lastSeenAt`, MIN(gs.`startTime`) AS `firstSeen`
    FROM `GameSession` gs
   GROUP BY gs.`robloxAccountId`, gs.`subjectId`
  UNION ALL
  SELECT ps.`robloxAccountId`, ps.`subjectId` AS `robloxUserId`, NULL AS `username`, NULL AS `displayName`,
         NULL AS `lastSeenAt`, MIN(ps.`startTime`) AS `firstSeen`
    FROM `PresenceSession` ps
   GROUP BY ps.`robloxAccountId`, ps.`subjectId`
) s
GROUP BY s.`robloxAccountId`, s.`robloxUserId`;

-- Record the currently known handle for every backfilled identity.
INSERT INTO `SubjectUsername` (`subjectIdentityId`, `username`, `firstSeenAt`, `lastSeenAt`, `isCurrent`)
SELECT si.`id`, si.`username`, si.`firstSeenAt`, NOW(3), TRUE
FROM `SubjectIdentity` si
WHERE si.`username` IS NOT NULL AND si.`username` <> '';

-- Seed `lastSeenAt` from the newest closed session when the subject row never
-- recorded one, so open-session capping keeps working for historical users.
UPDATE `SubjectIdentity` si
SET si.`lastSeenAt` = (
  SELECT MAX(gs.`endTime`)
  FROM `GameSession` gs
  WHERE gs.`robloxAccountId` = si.`robloxAccountId`
    AND gs.`subjectId` = si.`robloxUserId`
)
WHERE si.`lastSeenAt` IS NULL;
