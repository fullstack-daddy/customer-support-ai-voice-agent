'use client';

// Live contact confirmation.
//
// When the agent takes a name and email during a call, speech recognition
// has usually mangled at least one of them. "efua@accrastack.example"
// arrives as "effu at accra stack example" more often than not.
//
// So the moment the agent captures contact details, this panel appears
// with what was HEARD, in editable fields. The caller fixes it in two
// seconds while still on the line — instead of a confirmation email going
// to an address that does not exist and nobody finding out.
//
// It polls rather than holding a socket: one small request every few
// seconds for the duration of a call is cheap, and it degrades to
// "no panel" rather than a broken connection if the network hiccups.

import { useCallback, useEffect, useRef, useState } from 'react';

interface Pending {
  id: string;
  heard_name: string | null;
  heard_email: string | null;
  purpose: string | null;
}

const PURPOSE_COPY: Record<string, string> = {
  ticket: 'so we can send you the ticket reference',
  escalation: 'so a specialist can follow up',
  callback: 'so we can arrange the call'
};

export default function ContactConfirm({
  conversationId,
  active,
  onResolved
}: {
  conversationId: string | null;
  active: boolean;
  onResolved?: (confirmed: boolean) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Never re-show a capture the caller has already dealt with, even if a
  // slow poll returns stale data afterwards.
  const handled = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/contact-capture?conversation_id=${encodeURIComponent(conversationId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const p: Pending | null = j.pending ?? null;
      if (p && !handled.current.has(p.id)) {
        setPending((prev) => {
          if (prev?.id === p.id) return prev;   // already showing it
          setName(p.heard_name ?? '');
          setEmail(p.heard_email ?? '');
          setErr('');
          return p;
        });
      }
    } catch {
      // Silent: a dropped poll is not worth alarming a caller mid-sentence.
    }
  }, [conversationId]);

  useEffect(() => {
    if (!active || !conversationId) return;
    const tick = () => {
      poll();
      timer.current = setTimeout(tick, 3000);
    };
    tick();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [active, conversationId, poll]);

  async function submit(action: 'confirm' | 'skip') {
    if (!pending) return;
    if (action === 'confirm' && email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setErr('That does not look like a complete email address.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/contact-capture', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pending.id, name: name.trim(), email: email.trim(), action })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Could not save that.');
      handled.current.add(pending.id);
      setPending(null);
      onResolved?.(action === 'confirm');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!pending) return null;

  const why = PURPOSE_COPY[pending.purpose ?? ''] ?? 'so we can follow up';
  const changed =
    name.trim() !== (pending.heard_name ?? '').trim() ||
    email.trim() !== (pending.heard_email ?? '').trim();

  return (
    <div className="confirm mt2" role="region" aria-label="Confirm your contact details">
      <div className="ttl">Is this right?</div>
      <div className="why">We took these down {why}. Correct anything we misheard.</div>

      <label className="field">
        <span className="lbl">Name</span>
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)}
          className={changed ? 'editing' : undefined}
          autoComplete="name" disabled={busy}
        />
        {pending.heard_name && name.trim() !== pending.heard_name.trim() && (
          <span className="heard">we heard <b>{pending.heard_name}</b></span>
        )}
      </label>

      <label className="field" style={{ marginBottom: 12 }}>
        <span className="lbl">Email</span>
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          className={changed ? 'editing' : undefined}
          autoComplete="email" inputMode="email" disabled={busy}
          placeholder="you@company.com"
        />
        {pending.heard_email && email.trim() !== pending.heard_email.trim() && (
          <span className="heard">we heard <b>{pending.heard_email}</b></span>
        )}
      </label>

      {err && <div className="notice notice-err mb2" role="alert">{err}</div>}

      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={() => submit('confirm')} disabled={busy || !email.trim()}>
          {busy ? <><span className="spin" /> Saving</> : changed ? 'Save correction' : "Yes, that's right"}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => submit('skip')} disabled={busy}>
          Skip
        </button>
      </div>
    </div>
  );
}
