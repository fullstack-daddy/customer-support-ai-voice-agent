// Admin authentication.
//
// One account, defined entirely by environment variables. There is no
// sign-up, no user table, no password reset — adding those would mean
// adding an account-recovery surface to a console that holds customer
// call transcripts, which is a bad trade for a single-operator tool.
//
// Rotating ADMIN_PASSWORD in the environment takes effect immediately.
// Rotating AUTH_SECRET invalidates every existing session, which is the
// break-glass control if a session cookie is ever exposed.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'relaypay_admin';
const TTL_MS = 1000 * 60 * 60 * 12;   // 12h — a console, not a consumer app

export interface AdminSession {
  email: string;
  name: string;
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s: string): Buffer {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET is missing or too short. Set 32+ random characters in .env.');
  }
  return s;
}

/** Constant-time string compare that does not leak length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);   // burn an equivalent comparison
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function signSession(session: AdminSession): string {
  const body = b64url(Buffer.from(JSON.stringify(session)));
  const sig = b64url(createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(cookie: string | undefined | null): AdminSession | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return null;
  try {
    const expected = b64url(createHmac('sha256', secret()).update(body).digest());
    if (!safeEqual(sig, expected)) return null;
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as AdminSession;
    if (!parsed?.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sessionCookie(session: AdminSession): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `${COOKIE}=${signSession(session)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const COOKIE_NAME = COOKIE;

export interface LoginResult {
  ok: boolean;
  session?: AdminSession;
  error?: string;
  code?: string;
}

/**
 * Check credentials against the environment.
 *
 * Fails CLOSED: if the admin account is not configured, nobody can log
 * in. An unconfigured deployment must not be an open one.
 */
export function checkCredentials(email: unknown, password: unknown): LoginResult {
  const expectedEmail = process.env.ADMIN_EMAIL;
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedEmail || !expectedPassword) {
    return {
      ok: false,
      code: 'not_configured',
      error: 'No admin account is configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.'
    };
  }
  if (expectedPassword.length < 8) {
    return {
      ok: false,
      code: 'weak_password',
      error: 'The configured ADMIN_PASSWORD is shorter than 8 characters. Set a stronger one.'
    };
  }

  const givenEmail = String(email ?? '').trim().toLowerCase();
  const givenPassword = String(password ?? '');

  // Always evaluate both comparisons so a wrong email and a wrong
  // password take the same time — no oracle for which half was right.
  const emailOk = safeEqual(givenEmail, expectedEmail.trim().toLowerCase());
  const passwordOk = safeEqual(givenPassword, expectedPassword);

  if (!emailOk || !passwordOk) {
    return { ok: false, code: 'invalid', error: 'Wrong email or password.' };
  }

  const now = Date.now();
  return {
    ok: true,
    session: {
      email: expectedEmail,
      name: process.env.ADMIN_NAME || 'RelayPay Admin',
      iat: now,
      exp: now + TTL_MS
    }
  };
}

/** Generate a suggestion for operators who have not set AUTH_SECRET. */
export function suggestSecret(): string {
  return randomBytes(32).toString('hex');
}
