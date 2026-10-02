import Link from 'next/link';
import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { emailConfigured } from '@/lib/email.server';

export const dynamic = 'force-dynamic';

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  try {
    const db = supabaseAdmin();
    const res = await withTimeout(`count ${table}`, () => {
      let q = db.from(table).select('*', { count: 'exact', head: true });
      if (filter) q = filter(q);
      return q;
    });
    if (!res.ok) return 0;
    return (res.data as { count: number | null }).count ?? 0;
  } catch {
    return 0;
  }
}

export default async function AdminOverview() {
  const [conversations, escalated, tickets, pendingMail, failedMail, evaluations] = await Promise.all([
    count('conversations'),
    count('conversations', (q) => q.eq('final_status', 'escalated')),
    count('support_tickets'),
    count('support_tickets', (q) => q.eq('email_status', 'draft')),
    count('support_tickets', (q) => q.eq('email_status', 'failed')),
    count('evaluations')
  ]);

  const mail = emailConfigured();

  return (
    <main className="wrap wrap-wide">
      <div className="btw mb3">
        <div>
          <h1>Overview</h1>
          <p className="lede" style={{ marginTop: 4 }}>
            Every call the agent has handled, what it created, and what is waiting on you.
          </p>
        </div>
      </div>

      {!mail.ready && (
        <div className="notice notice-warn mb3">
          <div>
            <strong>Email is not configured.</strong>{' '}
            {mail.reason} Ticket confirmations can be drafted and reviewed, but not sent.
          </div>
        </div>
      )}

      {pendingMail > 0 && (
        <div className="notice notice-info mb3">
          <div>
            <strong>{pendingMail} draft{pendingMail === 1 ? '' : 's'} awaiting your review.</strong>{' '}
            Nothing is emailed to a customer until you approve it.{' '}
            <Link href="/admin/tickets?filter=draft">Review now</Link>
          </div>
        </div>
      )}

      {failedMail > 0 && (
        <div className="notice notice-err mb3">
          <div>
            <strong>{failedMail} email{failedMail === 1 ? '' : 's'} failed to send.</strong>{' '}
            Usually a bad address or an unverified sending domain.{' '}
            <Link href="/admin/tickets?filter=failed">See why</Link>
          </div>
        </div>
      )}

      <div className="stats mb3">
        <div className="stat">
          <div className="k">Conversations</div>
          <div className="v num">{conversations}</div>
          <div className="sub">all time</div>
        </div>
        <div className="stat">
          <div className="k">Escalated</div>
          <div className="v num">{escalated}</div>
          <div className="sub">handed to a human</div>
        </div>
        <div className="stat">
          <div className="k">Tickets</div>
          <div className="v num">{tickets}</div>
          <div className="sub">created by the agent</div>
        </div>
        <div className="stat">
          <div className="k">Awaiting approval</div>
          <div className="v num" style={{ color: pendingMail ? 'var(--warn)' : undefined }}>{pendingMail}</div>
          <div className="sub">drafts not yet sent</div>
        </div>
        <div className="stat">
          <div className="k">Evaluations</div>
          <div className="v num">{evaluations}</div>
          <div className="sub">scenario runs</div>
        </div>
      </div>

      <div className="g2">
        <Link href="/admin/conversations" className="card" style={{ textDecoration: 'none', display: 'block' }}>
          <h2 style={{ fontSize: 15 }}>Conversations</h2>
          <p className="sm dim" style={{ margin: '6px 0 0' }}>
            Full transcripts, tool calls, retrieval, and what the agent decided on each turn.
          </p>
        </Link>
        <Link href="/admin/tickets" className="card" style={{ textDecoration: 'none', display: 'block' }}>
          <h2 style={{ fontSize: 15 }}>Tickets &amp; outbound mail</h2>
          <p className="sm dim" style={{ margin: '6px 0 0' }}>
            Review, edit and approve what gets emailed to customers. Nothing sends on its own.
          </p>
        </Link>
      </div>
    </main>
  );
}
