/**
 * Cookie Encryption Utility — AES-256-GCM
 *
 * Encrypts the .ROBLOSECURITY cookie before storing it in the database.
 * Format stored in DB: `<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 *
 * KEY must be exactly 32 bytes. Sourced from ENCRYPTION_KEY env var.
 * A random 12-byte IV is generated per encryption call.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

function getKey(): Buffer {
  const raw = process.env['ENCRYPTION_KEY'] ?? '';
  // Derive exactly 32 bytes: pad with zeros or truncate
  const buf = Buffer.alloc(32);
  Buffer.from(raw, 'utf-8').copy(buf);
  return buf;
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext string.
 * Returns `iv:authTag:ciphertext` (all hex-encoded) as a single string.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypts a ciphertext produced by `encrypt()`.
 * Throws if the format is invalid or the auth tag doesn't match (tamper detection).
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted cookie format.');
  }

  const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];

  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encryptedData = Buffer.from(encryptedHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted cookie format.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]).toString('utf-8');
}
