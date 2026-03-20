import fs from "fs";
import { prisma } from './lib/prisma.js';

interface OldSession {
  startTime: number;
  endTime: number;
  duration: number;
}

interface OldGame {
  name: string;
  sessions?: OldSession[];
}

interface OldUser {
  gameHistory?: {
    games?: Record<string, OldGame>;
  };
}

async function migrate() {
  const robloxAccountId = 2; // Targeted Roblox account ID in DB

  console.log("Reading old-data.json...");
  const rawData = fs.readFileSync("old-data.json", "utf-8");
  const data: Record<string, OldUser> = JSON.parse(rawData);

  console.log("Fetching current friends from database...");
  const currentFriends = await prisma.friend.findMany({
    where: { robloxAccountId },
    select: { friendUserId: true }
  });

  const friendUserIdSet = new Set(currentFriends.map(f => f.friendUserId.toString()));
  const trackedUserIdsToInsert = new Set<bigint>();
  const sessionsToInsert: any[] = [];

  console.log("Processing data...");
  for (const userIdStr in data) {
    const userId = BigInt(userIdStr);
    const user = data[userIdStr];
    if (!user) continue;

    const isFriend = friendUserIdSet.has(userIdStr);
    const subjectType = isFriend ? ("FRIEND" as const) : ("TRACKED" as const);

    if (!isFriend) {
      trackedUserIdsToInsert.add(userId);
    }

    const games = user.gameHistory?.games || {};
    for (const placeIdStr in games) {
      const placeId = BigInt(placeIdStr);
      const game = games[placeIdStr];
      if (!game || !game.sessions || game.sessions.length === 0) continue;

      for (const session of game.sessions) {
        sessionsToInsert.push({
          subjectId: userId,
          placeId: placeId,
          gameName: game.name,
          robloxAccountId: robloxAccountId,
          subjectType: subjectType,
          startTime: new Date(session.startTime),
          endTime: new Date(session.endTime),
          duration: session.duration
        });
      }
    }
  }

  console.log(`Statistics:
- Tracked users to insert: ${trackedUserIdsToInsert.size}
- Game sessions to insert: ${sessionsToInsert.length}`);

  if (trackedUserIdsToInsert.size > 0) {
    console.log("Inserting tracked users...");
    await prisma.trackedUser.createMany({
      data: Array.from(trackedUserIdsToInsert).map((userId) => ({
        robloxUserId: userId,
        robloxAccountId: robloxAccountId,
        notifyOnline: true,
        notifyOffline: false,
        notifyGame: true,
      })),
      skipDuplicates: true
    });
  }

  if (sessionsToInsert.length > 0) {
    console.log("Inserting game sessions in batches...");
    const batchSize = 5000;
    for (let i = 0; i < sessionsToInsert.length; i += batchSize) {
      const batch = sessionsToInsert.slice(i, i + batchSize);
      await prisma.gameSession.createMany({
        data: batch,
        skipDuplicates: true
      });
      console.log(`- Inserted batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(sessionsToInsert.length / batchSize)}`);
    }
  }

  console.log("Migration successfully completed.");
}

migrate()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });