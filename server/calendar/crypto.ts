import crypto from 'crypto';

// Encryption algorithm for storing OAuth refresh tokens at rest
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard recommended IV length for AES-GCM
const AUTH_TAG_LENGTH = 16;
const SALT = 'ezzymigo-calendar-token-salt-v1';

/**
 * Returns true if the dedicated encryption key is set.
 */
export function hasDedicatedEncryptionKey(): boolean {
  return !!(process.env.CALENDAR_TOKEN_ENCRYPTION_KEY && process.env.CALENDAR_TOKEN_ENCRYPTION_KEY.trim().length > 0);
}

/**
 * Retrieves the 32-byte encryption key derived strictly from CALENDAR_TOKEN_ENCRYPTION_KEY.
 * Explicitly refuses to derive from database tokens or any other fallback.
 * Throws an explicit error if CALENDAR_TOKEN_ENCRYPTION_KEY is absent.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      'Calendar token storage is disabled: CALENDAR_TOKEN_ENCRYPTION_KEY is not configured in environment secrets.'
    );
  }

  return crypto.scryptSync(secret.trim(), SALT, 32);
}

/**
 * Encrypt a plaintext token using AES-256-GCM.
 * Output format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
 * Refuses to execute if dedicated key is not set.
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted token string.
 * Returns empty string if input is empty or invalid.
 */
export function decryptToken(encryptedPayload: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') return '';
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
