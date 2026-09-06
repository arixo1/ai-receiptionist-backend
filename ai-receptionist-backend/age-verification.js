/**
 * Backend Age Verification
 *
 * Moves the 21+ gate from client-side JavaScript (trivially bypassed with
 * dev tools) to the server. The server issues a signed, time-limited token
 * only after a verification attempt is logged — the chat endpoint then
 * refuses to answer anything unless a valid token is presented.
 *
 * Every attempt (pass or fail) is written to a JSONL audit log stored next
 * to shop-config.json, so it survives redeploys on the same Railway Volume.
 *
 * SETUP
 *   Add to Railway Variables:
 *     AGE_TOKEN_SECRET       — any random string (see AGE-VERIFICATION-SETUP.md
 *                              for how to generate one). If omitted, this
 *                              falls back to reusing ENCRYPTION_KEY, which
 *                              works but isn't ideal — separate secrets for
 *                              separate purposes is better practice.
 *     AGE_TOKEN_TTL_MINUTES  — how long a verification lasts before the chat
 *                              re-asks (default: 120 = 2 hours)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function getAgeTokenSecret() {
  if (process.env.AGE_TOKEN_SECRET) {
    return process.env.AGE_TOKEN_SECRET;
  }
  if (process.env.ENCRYPTION_KEY) {
    console.warn(
      '⚠️  AGE_TOKEN_SECRET not set — reusing ENCRYPTION_KEY as the signing secret. ' +
      'This works, but a dedicated AGE_TOKEN_SECRET is recommended. See AGE-VERIFICATION-SETUP.md.'
    );
    return process.env.ENCRYPTION_KEY;
  }
  console.warn(
    '⚠️  Neither AGE_TOKEN_SECRET nor ENCRYPTION_KEY is set. Using an insecure ' +
    'development default — set AGE_TOKEN_SECRET in Railway Variables before going live.'
  );
  return 'insecure-development-fallback-do-not-use-in-production';
}

/**
 * Sign a payload into a compact, tamper-evident token: base64(payload).signature
 * Not a full JWT (no external library needed) — just enough structure to prove
 * "this token was issued by us, for this shop, and hasn't expired or been altered."
 */
function signToken(payload) {
  const secret = getAgeTokenSecret();
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a token's signature and expiry. Returns the decoded payload if valid,
 * or null if the token is missing, malformed, tampered, or expired.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;

  const secret = getAgeTokenSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  // Timing-safe comparison — a plain === check leaks timing info that can help
  // an attacker forge a valid signature byte-by-byte.
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null; // expired
    return payload;
  } catch (err) {
    return null;
  }
}

// Verification attempts live in a JSONL file (one JSON object per line) next
// to shop-config.json — same Volume, so it survives redeploys the same way
// the config does.
function getLogPath(configPath) {
  return path.join(path.dirname(configPath), 'age-verification-log.jsonl');
}

function logVerificationAttempt(configPath, entry) {
  try {
    fs.appendFileSync(getLogPath(configPath), JSON.stringify(entry) + '\n');
  } catch (err) {
    // A logging failure should never take down the actual verification flow —
    // but it should be visible, not silently swallowed.
    console.error('Failed to write age-verification log entry:', err.message);
  }
}

module.exports = { signToken, verifyToken, logVerificationAttempt, getLogPath, getAgeTokenSecret };
