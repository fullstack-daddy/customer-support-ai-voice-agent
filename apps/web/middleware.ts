// Edge middleware: gate the admin console.
//
// Runs on the edge runtime, so it cannot use node:crypto. The HMAC is
// recomputed with Web Crypto instead — same algorithm, same secret, same
// cookie as lib/auth.server.ts. If you change the signing scheme in one,
// change it in both.
//
// This is a first gate, not the only one: every /api/admin route also
// calls requireAdmin() server-side, so a middleware bypass still hits a
// closed door.

import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = 'relaypay_admin';

function b64urlToBytes(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = t + '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function valid(cookie: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!cookie || !secret) return false;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    if (bytesToB64url(new Uint8Array(mac)) !== sig) return false;

    const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as { exp?: number };
    return Boolean(parsed?.exp && parsed.exp > Date.now());
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const ok = await valid(req.cookies.get(COOKIE)?.value, process.env.AUTH_SECRET);
  if (ok) {
    // Already signed in and heading for the login page — send them on.
    if (pathname === '/admin/login') {
      const url = req.nextUrl.clone();
      url.pathname = '/admin';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // API routes get JSON, not a redirect — a fetch should not silently
  // receive an HTML login page and try to parse it.
  if (pathname.startsWith('/api/admin')) {
    return new NextResponse(JSON.stringify({ error: 'Not signed in.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/admin/login';
  url.search = pathname === '/admin' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // /admin/login is matched too, so a signed-in admin gets bounced past it.
  matcher: ['/admin/:path*', '/api/admin/:path*']
};
