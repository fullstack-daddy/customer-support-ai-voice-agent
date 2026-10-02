import CallWidget from '@/components/CallWidget';
import Toasts from '@/components/Toast';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  // Only NEXT_PUBLIC_* reaches the browser. The Vapi publishable key is
  // safe here by design; the private API key never leaves the server.
  const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? null;
  const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">RP</span>
          RelayPay
        </a>
        <span className="xs faint">Support</span>
      </header>

      <main className="wrap">
        <div className="mb3">
          <h1>How can we help?</h1>
          <p className="lede" style={{ marginTop: 6 }}>
            Ask about payments, invoicing, payouts, fees, or verification. For anything specific to your
            account, we&apos;ll take your details and arrange for a specialist to follow up.
          </p>
        </div>

        <CallWidget publicKey={publicKey} assistantId={assistantId} />

        <div className="g2 mt3">
          <div className="card">
            <h3>What it can do</h3>
            <ul className="sm dim" style={{ margin: '10px 0 0', paddingLeft: 17, lineHeight: 1.75 }}>
              <li>Answer questions using RelayPay&apos;s approved documentation</li>
              <li>Look up a transaction or payout from its reference</li>
              <li>Raise a support ticket and email you the reference</li>
              <li>Arrange a callback with a specialist</li>
            </ul>
          </div>
          <div className="card">
            <h3>What it won&apos;t do</h3>
            <ul className="sm dim" style={{ margin: '10px 0 0', paddingLeft: 17, lineHeight: 1.75 }}>
              <li>Read out account balances</li>
              <li>Explain why a compliance review happened</li>
              <li>Promise a date for a dispute, refund, or review</li>
              <li>Guess at anything it can&apos;t confirm</li>
            </ul>
          </div>
        </div>
      </main>

      <Toasts />
    </div>
  );
}
