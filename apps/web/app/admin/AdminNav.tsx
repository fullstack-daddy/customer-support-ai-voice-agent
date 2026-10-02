'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/conversations', label: 'Conversations' },
  { href: '/admin/tickets', label: 'Tickets & mail' },
  { href: '/admin/evaluations', label: 'Evaluations' }
];

export default function AdminNav({ adminName, adminEmail }: { adminName: string; adminEmail: string }) {
  const pathname = usePathname();

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.assign('/admin/login');
  }

  return (
    <header className="topbar">
      <div className="row">
        <Link href="/admin" className="brand">
          <span className="brand-mark" aria-hidden="true">RP</span>
          RelayPay
        </Link>
        <span className="pill pill-bare xs" style={{ marginLeft: 2 }}>Console</span>
      </div>

      <nav className="nav" aria-label="Admin sections">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            // Exact match on /admin so the overview tab is not permanently
            // highlighted on every sub-page.
            data-on={l.href === '/admin' ? pathname === '/admin' : pathname.startsWith(l.href)}
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <div className="row">
        <div className="col" style={{ alignItems: 'flex-end', lineHeight: 1.3 }}>
          <span className="xs" style={{ fontWeight: 500 }}>{adminName}</span>
          <span className="xs faint">{adminEmail}</span>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}
