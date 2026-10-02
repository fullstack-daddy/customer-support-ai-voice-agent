import { checkCredentials, sessionCookie } from '@/lib/auth.server';
import { rateLimit, clientKey, json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  // Throttle before touching credentials: this is the one unauthenticated
  // POST in the console, so it is the obvious brute-force target.
  const limit = rateLimit(`login:${clientKey(req.headers)}`, 8, 60_000);
  if (!limit.ok) {
    return json(
      { error: 'Too many attempts. Wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Malformed request.' }, { status: 400 });
  }

  const result = checkCredentials(body?.email, body?.password);
  if (!result.ok || !result.session) {
    // A misconfigured server is worth saying out loud — the operator
    // needs to fix their environment, and it reveals nothing useful to
    // an attacker. A wrong password stays deliberately vague.
    const status = result.code === 'not_configured' || result.code === 'weak_password' ? 500 : 401;
    return json({ error: result.error, code: result.code }, { status });
  }

  return json(
    { ok: true, admin: { email: result.session.email, name: result.session.name } },
    { headers: { 'set-cookie': sessionCookie(result.session) } }
  );
}
