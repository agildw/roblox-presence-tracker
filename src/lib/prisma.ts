import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('Missing DATABASE_URL environment variable');
}

// Singleton pattern — ensures one DB connection pool across the app
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  // PrismaMariaDb accepts a raw connection string or PoolConfig
  const adapter = new PrismaMariaDb(connectionString as string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (PrismaClient as any)({ adapter }) as PrismaClient;
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
