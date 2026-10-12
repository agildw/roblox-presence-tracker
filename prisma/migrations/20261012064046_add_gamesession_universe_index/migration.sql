-- Additive index for /gamestats per-account, per-universe window scans.
-- Queries always filter by a single robloxAccountId, then a universeId, then a
-- startTime range, so this composite leads with the account to keep the scan
-- narrow. NULL universeId rows (hidden place info, legacy imports) are simply
-- never matched by the equality on universeId, which is the intended behaviour.
CREATE INDEX `GameSession_robloxAccountId_universeId_startTime_idx`
  ON `GameSession`(`robloxAccountId`, `universeId`, `startTime`);
