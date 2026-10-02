'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginForm() {
  const sp = useSearchParams();
  const next = sp.get('next') || '/admin';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const j = await res.json().catch(() => ({ error: 'Sign-in failed.' }));
      if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
      // Hard navigation, not router.push — the session cookie was just
      // set and a client-side transition can race the middleware.
      window.location.assign(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="row" style={{ marginBottom: 24 }}>
          <span className="brand-mark" aria-hidden="true">RP</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>RelayPay</div>
            <div className="xs dim">Support console</div>
          </div>
        </div>

        <h1 style={{ fontSize: 21, marginBottom: 6 }}>Sign in</h1>
        <p className="sm dim" style={{ marginBottom: 22 }}>
          Administrator access. Conversations, tickets and outbound mail.
        </p>

        <form onSubmit={submit} noValidate>
          <label className="field">
            <span className="lbl">Email</span>
            <input
              type="email" value={email} autoFocus autoComplete="username"
              onChange={(e) => setEmail(e.target.value)} required
            />
          </label>

          <label className="field">
            <span className="lbl">Password</span>
            <input
              type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} required
            />
          </label>

          {err && <div className="notice notice-err mb2" role="alert">{err}</div>}

          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? <><span className="spin" /> Signing in</> : 'Sign in'}
          </button>
        </form>

        <p className="xs faint mt3" style={{ textAlign: 'center', margin: '20px 0 0' }}>
          There is no sign-up. The account is set in the server environment.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth"><div className="auth-card">Loading…</div></main>}>
      <LoginForm />
    </Suspense>
  );
}
