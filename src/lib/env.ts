import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  BOT_TOKEN: requireEnv('BOT_TOKEN'),
  DATABASE_URL: requireEnv('DATABASE_URL'),
  ENCRYPTION_KEY: process.env['ENCRYPTION_KEY'] ?? 'changeme-32-char-secret-key12345',
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',
} as const;
