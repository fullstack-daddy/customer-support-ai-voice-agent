import { clearCookie } from '@/lib/auth.server';
import { json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });
}
