// Internal review dashboard.
//
// Not linked from the public nav, and gated on a shared secret checked
// server-side before any data is fetched. Reads go through our own API
// routes (service role, server-only) — never client-to-Supabase.
//
// Access: /internal/review?key=<INTERNAL_REVIEW_SECRET>

import { verifyInternalSecret } from '@/lib/security.server';
import { headers } from 'next/headers';
import ReviewDashboard from './ReviewDashboard';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const key = typeof params.key === 'string' ? params.key : '';

  const h = await headers();
  const fakeUrl = new URL(`https://internal.local/?key=${encodeURIComponent(key)}`);
  const authError = verifyInternalSecret(h, fakeUrl);

  if (authError) {
    return (
      <main className="page">
        <h1>Internal review</h1>
        <div className="notice notice-err">
          Access denied. Append <code className="mono">?key=&lt;INTERNAL_REVIEW_SECRET&gt;</code> to the URL.
        </div>
      </main>
    );
  }

  return <ReviewDashboard reviewKey={key} />;
}
