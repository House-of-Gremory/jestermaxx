import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const USER_SESSION_COOKIE = 'user_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- password hashing (scrypt, per-user random salt) -------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- session tokens ----------------------------------------------------------
// Same HMAC-signed scheme as the admin session, but carrying the user id, and
// under its own cookie so an admin login and a player login never collide.
// Reuses ADMIN_SESSION_SECRET so no new environment variable is needed.

function secret(): string {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value) throw new Error('ADMIN_SESSION_SECRET is not configured');
  return value;
}

function sign(payload: string): string {
  // Domain-separated from admin tokens so one can never be replayed as the other.
  return createHmac('sha256', `user:${secret()}`).update(payload).digest('hex');
}

export function createUserSessionToken(userId: string): string {
  const payload = `${Buffer.from(userId).toString('base64url')}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the user id for a valid, unexpired token, otherwise null.
export function verifyUserSessionToken(token: string | undefined | null): string | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idPart, expiryPart, signature] = parts;

  const expiresAt = Number(expiryPart);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  let expectedSignature: string;
  try {
    expectedSignature = sign(`${idPart}.${expiryPart}`);
  } catch {
    return null;
  }

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    return Buffer.from(idPart, 'base64url').toString();
  } catch {
    return null;
  }
}
