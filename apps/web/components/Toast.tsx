'use client';

import { useEffect, useState } from 'react';

interface Item { id: string; msg: string; kind: 'ok' | 'err'; }

export function toast(msg: string, kind: 'ok' | 'err' = 'ok') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('rp-toast', { detail: { msg, kind } }));
}

export default function Toasts() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    function on(e: Event) {
      const { msg, kind } = (e as CustomEvent).detail as { msg: string; kind: 'ok' | 'err' };
      const id = Math.random().toString(36).slice(2);
      setItems((prev) => [...prev, { id, msg, kind }]);
      // Errors linger — they usually need reading twice.
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'err' ? 6500 : 3600);
    }
    window.addEventListener('rp-toast', on);
    return () => window.removeEventListener('rp-toast', on);
  }, []);

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
