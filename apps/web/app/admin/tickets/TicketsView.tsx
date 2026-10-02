'use client';

// Ticket history and the outbound-mail approval queue.
//
// The important property of this screen: an email is only ever sent by a
// human pressing "Approve & send", after seeing the exact text that will
// go out and being able to change it. The agent drafts; it never sends.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/Toast';

interface Record_ {
  kind: 'ticket' | 'escalation';
  id: string;
  ref: string;
  conversation_id: string;
  category: string;
  priority: string | null;
  summary: string;
  contact_name: string | null;
  email_to: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_status: string;
  email_error: string | null;
  email_sent_at: string | null;
  email_approved_by: string | null;
  status: string;
  created_at: string;
}

interface Draft { to: string; subject: string; body: string; }

const STATUS_PILL: Record<string, string> = {
  draft: 'pill-warn', approved: 'pill-info', sending: 'pill-info',
  sent: 'pill-ok', failed: 'pill-err', cancelled: 'pill'
};

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Awaiting approval' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'cancelled', label: 'Cancelled' }
];

export default function TicketsView() {
  const [records, setRecords] = useState<Record_[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [mailReady, setMailReady] = useState<{ ready: boolean; reason?: string }>({ ready: true });
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState<Record_ | null>(null);
  const [draft, setDraft] = useState<Draft>({ to: '', subject: '', body: '' });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'send' | 'cancel' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/tickets', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const j = await res.json();
      setRecords(j.records ?? []);
      setCounts(j.counts ?? {});
      setMailReady(j.email ?? { ready: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Read the deep-link filter once on mount (?filter=draft from Overview).
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get('filter');
    if (f) setFilter(f);
  }, []);

  const shown = useMemo(() => records.filter((r) => {
    if (filter && r.email_status !== filter) return false;
    if (!q) return true;
    const hay = `${r.ref} ${r.category} ${r.summary} ${r.contact_name ?? ''} ${r.email_to ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [records, filter, q]);

  async function openRecord(rec: Record_) {
    setOpen(rec);
    setDirty(false);
    setDraft({ to: '', subject: '', body: '' });
    try {
      const res = await fetch(`/api/admin/tickets/${rec.kind}/${rec.id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not load the draft (${res.status})`);
      const j = await res.json();
      setDraft(j.draft);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function act(action: 'save' | 'approve_send' | 'cancel') {
    if (!open) return;
    const key = action === 'approve_send' ? 'send' : action === 'cancel' ? 'cancel' : 'save';

    if (action === 'approve_send') {
      const ok = window.confirm(
        `Send this email to ${draft.to}?\n\nThis goes to a real customer and cannot be unsent.`
      );
      if (!ok) return;
    }

    setBusy(key);
    try {
      const res = await fetch(`/api/admin/tickets/${open.kind}/${open.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...draft })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);

      toast(
        action === 'approve_send' ? `Sent to ${draft.to}` :
        action === 'cancel' ? 'Cancelled — this will not be sent' : 'Draft saved'
      );
      setDirty(false);
      if (action !== 'save') setOpen(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(null);
    }
  }

  const sendable = open && open.email_status !== 'sent' && open.email_status !== 'sending';

  return (
    <main className="wrap wrap-wide">
      <div className="btw mb3">
        <div>
          <h1>Tickets &amp; outbound mail</h1>
          <p className="lede" style={{ marginTop: 4 }}>
            Everything the agent created. Review and approve before anything reaches a customer.
          </p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? <><span className="spin" /> Loading</> : 'Refresh'}
        </button>
      </div>

      {!mailReady.ready && (
        <div className="notice notice-warn mb3">
          <div><strong>Sending is disabled.</strong> {mailReady.reason} Drafts can still be reviewed and edited.</div>
        </div>
      )}

      <div className="row row-wrap mb3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key && counts[f.key] ? ` (${counts[f.key]})` : ''}
          </button>
        ))}
        <input
          type="search" placeholder="Search reference, contact, summary…"
          value={q} onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 300, marginLeft: 'auto' }}
        />
      </div>

      <div className="card card-pad-0">
        {loading ? (
          <div className="empty"><p>Loading…</p></div>
        ) : shown.length === 0 ? (
          <div className="empty">
            <h4>Nothing here</h4>
            <p>{filter ? 'No records with that status.' : 'The agent has not created any tickets yet.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Reference</th><th>Type</th><th>Contact</th>
                  <th>Summary</th><th>Mail</th><th>Created</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} data-sel={open?.id === r.id}>
                    <td className="mono" style={{ color: 'var(--t0)', whiteSpace: 'nowrap' }}>{r.ref}</td>
                    <td>
                      <span className={`pill ${r.kind === 'escalation' ? 'pill-warn' : 'pill-bare'}`}>{r.kind}</span>
                    </td>
                    <td>
                      <div>{r.contact_name || <span className="faint">—</span>}</div>
                      <div className="xs dim">{r.email_to || 'no address'}</div>
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      <div className="sm" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {r.summary}
                      </div>
                    </td>
                    <td><span className={`pill ${STATUS_PILL[r.email_status] ?? 'pill'}`}>{r.email_status}</span></td>
                    <td className="xs dim" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="r">
                      <button className="btn btn-sm" onClick={() => openRecord(r)}>
                        {r.email_status === 'draft' ? 'Review' : 'Open'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={`Email for ${open.ref}`}>
            <div className="modal-head">
              <div>
                <div className="row">
                  <h2 style={{ fontSize: 16 }} className="mono">{open.ref}</h2>
                  <span className={`pill ${STATUS_PILL[open.email_status] ?? 'pill'}`}>{open.email_status}</span>
                </div>
                <div className="xs dim mt1">
                  {open.category}{open.priority ? ` · ${open.priority}` : ''} · conversation{' '}
                  <span className="mono">{open.conversation_id}</span>
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(null)} disabled={Boolean(busy)}>Close</button>
            </div>

            <div className="modal-body">
              {open.email_status === 'sent' && (
                <div className="notice notice-ok mb3">
                  <div>
                    Sent{open.email_sent_at ? ` on ${new Date(open.email_sent_at).toLocaleString()}` : ''}
                    {open.email_approved_by ? ` · approved by ${open.email_approved_by}` : ''}.
                    This is a record of what went out.
                  </div>
                </div>
              )}
              {open.email_status === 'failed' && open.email_error && (
                <div className="notice notice-err mb3">
                  <div><strong>Send failed.</strong> {open.email_error}</div>
                </div>
              )}

              <div className="card card-hi mb3">
                <h3>What the caller said</h3>
                <p className="sm" style={{ margin: '8px 0 0', color: 'var(--t1)' }}>{open.summary}</p>
              </div>

              <label className="field">
                <span className="lbl">To</span>
                <input
                  type="email" value={draft.to}
                  className={dirty ? 'editing' : undefined}
                  onChange={(e) => { setDraft({ ...draft, to: e.target.value }); setDirty(true); }}
                  disabled={!sendable}
                />
                <span className="hint">
                  Taken from what the caller confirmed during the call. Check it before sending.
                </span>
              </label>

              <label className="field">
                <span className="lbl">Subject</span>
                <input
                  type="text" value={draft.subject}
                  className={dirty ? 'editing' : undefined}
                  onChange={(e) => { setDraft({ ...draft, subject: e.target.value }); setDirty(true); }}
                  disabled={!sendable}
                />
              </label>

              <label className="field" style={{ marginBottom: 0 }}>
                <span className="lbl">Message</span>
                <textarea
                  rows={14} value={draft.body}
                  className={dirty ? 'editing' : undefined}
                  onChange={(e) => { setDraft({ ...draft, body: e.target.value }); setDirty(true); }}
                  disabled={!sendable}
                  style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
                />
                <span className="hint">
                  Edit freely. The draft deliberately promises no timeline or outcome — if you add one, that is your commitment.
                </span>
              </label>
            </div>

            {sendable && (
              <div className="modal-foot">
                <button className="btn btn-danger" onClick={() => act('cancel')} disabled={Boolean(busy)}>
                  {busy === 'cancel' ? <><span className="spin" /> Cancelling</> : "Don't send"}
                </button>
                <div className="grow" />
                <button className="btn" onClick={() => act('save')} disabled={Boolean(busy) || !dirty}>
                  {busy === 'save' ? <><span className="spin" /> Saving</> : 'Save draft'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => act('approve_send')}
                  disabled={Boolean(busy) || !mailReady.ready || !draft.to}
                  title={!mailReady.ready ? mailReady.reason : undefined}
                >
                  {busy === 'send' ? <><span className="spin" /> Sending</> : 'Approve & send'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
