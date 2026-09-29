import CallWidget from '@/components/CallWidget';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  // Only NEXT_PUBLIC_* values reach the browser. The Vapi public key is
  // publishable by design; the private API key never leaves the server.
  const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? null;
  const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? null;

  return (
    <main className="page">
      <h1>Support</h1>
      <p className="lede">
        Ask about payments, invoicing, payouts, fees, or verification. For anything account-specific,
        our agent will take your details and arrange for a specialist to follow up.
      </p>

      <CallWidget publicKey={publicKey} assistantId={assistantId} />

      <div className="card mt-3">
        <h3>What this agent can and cannot do</h3>
        <div className="grid-2 mt-2">
          <div>
            <p className="small" style={{ fontWeight: 600, marginBottom: 6 }}>It can</p>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Answer questions about how RelayPay works, using approved documentation</li>
              <li>Look up a transaction or payout if you have the reference</li>
              <li>Raise a support ticket</li>
              <li>Arrange a specialist callback</li>
            </ul>
          </div>
          <div>
            <p className="small" style={{ fontWeight: 600, marginBottom: 6 }}>It will not</p>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Read out account balances</li>
              <li>Explain why a compliance review happened</li>
              <li>Promise a date for a dispute, refund, or review</li>
              <li>Guess at anything it cannot confirm</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}
