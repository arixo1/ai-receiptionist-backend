/**
 * Token Encryption/Decryption Utility
 * 
 * Uses AES-256-GCM for authenticated encryption of sensitive tokens.
 * The encryption key is derived from ENCRYPTION_KEY environment variable.
 * 
 * SETUP:
 *   1. Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Add to Railway Variables: ENCRYPTION_KEY=<the-hex-string>
 *   3. Restart the service
 */

const crypto = require('crypto');

// Derive encryption key from environment
function getEncryptionKey() {
  const keyEnv = process.env.ENCRYPTION_KEY;
  
  if (!keyEnv) {
    // Development fallback (NOT SECURE — use env var in production)
    console.warn(
      '⚠️  ENCRYPTION_KEY not set. Using insecure development default. ' +
      'In production, set ENCRYPTION_KEY in Railway Variables.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    return Buffer.from('0'.repeat(64), 'hex'); // 32 bytes of zeros — DO NOT USE IN PRODUCTION
  }

  // Key should be 64 hex chars (32 bytes) for AES-256
  if (keyEnv.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex characters (32 bytes). Got ${keyEnv.length} chars.\n` +
      `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }

  return Buffer.from(keyEnv, 'hex');
}

/**
 * Encrypt a plaintext string (e.g., Square access token)
 * Returns: base64-encoded string containing IV + ciphertext + auth tag
 */
function encrypt(plaintext) {
  if (!plaintext) return null;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16); // 128-bit IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Package: IV + authTag + ciphertext (all in one base64 blob)
  const packet = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'hex')]);
  return packet.toString('base64');
}

/**
 * Decrypt a ciphertext blob (produced by encrypt())
 * Returns: plaintext string
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;

  try {
    const key = getEncryptionKey();
    const packet = Buffer.from(ciphertext, 'base64');

    // Unpack: first 16 bytes = IV, next 16 bytes = auth tag, rest = ciphertext
    const iv = packet.slice(0, 16);
    const authTag = packet.slice(16, 32);
    const encrypted = packet.slice(32).toString('hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('Decryption failed (token may be corrupted or key changed):', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
