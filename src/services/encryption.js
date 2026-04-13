import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;        // 256 bits
const IV_LENGTH = 16;         // 128 bits
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

/**
 * Derive a 256-bit AES key from a DID string using PBKDF2.
 */
function deriveKey(did, salt) {
  return crypto.pbkdf2Sync(did, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt a plaintext payload, bound to a specific DID.
 * Returns a base64-encoded string containing salt + iv + authTag + ciphertext.
 */
export function encrypt(payload, did) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(did, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt(16) + iv(16) + authTag(16) + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded payload using the DID that encrypted it.
 */
export function decrypt(encryptedBase64, did) {
  const packed = Buffer.from(encryptedBase64, 'base64');

  const salt = packed.subarray(0, SALT_LENGTH);
  const iv = packed.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = packed.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + 16);
  const ciphertext = packed.subarray(SALT_LENGTH + IV_LENGTH + 16);

  const key = deriveKey(did, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Compute a SHA-256 fingerprint of a DID (used for partition keys).
 */
export function didFingerprint(did) {
  return crypto.createHash('sha256').update(did).digest('hex').substring(0, 16);
}
