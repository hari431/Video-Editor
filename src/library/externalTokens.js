import crypto from 'node:crypto';

// In-memory opaque token store for YouTube external resources
// No DB, no encryption – simple random token -> {youtubeId, itemPath, externalUrl, createdAt}
// Tokens expire after TOKEN_TTL_MS and are cleaned up opportunistically.

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const store = new Map(); // token -> entry

function generateToken() {
  // 8 chars base62-like using crypto random
  const bytes = crypto.randomBytes(6); // 48 bits ~ 8 base62 chars
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let token = '';
  // Convert bytes to base62
  let num = BigInt('0x' + bytes.toString('hex'));
  if (num === 0n) num = 1n;
  while (token.length < 8) {
    const idx = Number(num % 62n);
    token += alphabet[idx];
    num = num / 62n;
    if (num === 0n) {
      // refill if needed
      const extra = crypto.randomBytes(1)[0] % 62;
      token += alphabet[extra];
    }
  }
  // Shuffle a bit and ensure 8-10 chars
  return token.slice(0, 8) + (Math.random() < 0.5 ? alphabet[crypto.randomBytes(1)[0] % 62] : '');
}

function cleanupExpired() {
  const now = Date.now();
  for (const [tok, entry] of store) {
    if (now - entry.createdAt > TOKEN_TTL_MS) {
      store.delete(tok);
    }
  }
}

let cleanupTimer = null;
function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function createExternalVideoToken({ youtubeId, itemPath, externalUrl }) {
  if (!youtubeId || !itemPath) return null;
  ensureCleanupTimer();
  cleanupExpired();
  let token;
  // Ensure uniqueness
  do {
    token = generateToken();
  } while (store.has(token));
  store.set(token, {
    youtubeId,
    itemPath,
    externalUrl,
    createdAt: Date.now(),
  });
  return token;
}

export function resolveExternalVideoToken(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = store.get(String(token).trim());
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    store.delete(String(token).trim());
    return null;
  }
  return entry;
}

export function _clearStoreForTests() {
  store.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export const _store = store;
export const TOKEN_TTL = TOKEN_TTL_MS;
