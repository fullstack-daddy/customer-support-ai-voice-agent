'use client';

// The voice call surface.
//
// Vapi's Web SDK handles mic capture, streaming, turn-taking and
// barge-in. We drive it and render state. Two things worth noting:
//
//  - Barge-in is left ENABLED. It is tempting to disable interruption
//    "for simplicity", but a support caller who has to wait out a long
//    answer before correcting you has a bad time.
//  - The transcript is not decoration. It is the captions-equivalent for
//    anyone who cannot use audio, and it is in an ARIA live region so a
//    screen reader announces new turns.

import { useCallback, useEffect, useRef, useState } from 'react';

type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

const STATE_LABEL: Record<CallState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Working on it',
  speaking: 'Speaking',
  error: 'Something went wrong',
  ended: 'Call ended'
};

export default function CallWidget({
  publicKey,
  assistantId
}: {
  publicKey: string | null;
  assistantId: string | null;
}) {
  const [state, setState] = useState<CallState>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const vapiRef = useRef<any>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const configured = Boolean(publicKey && assistantId);

  // Keep the transcript pinned to the newest turn.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Tear the call down if the component unmounts mid-call, so the mic is
  // always released even if the user navigates away.
  useEffect(() => {
    return () => {
      try { vapiRef.current?.stop?.(); } catch { /* already gone */ }
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setTurns([]);
    setState('connecting');

    try {
      const { default: Vapi } = await import('@vapi-ai/web');
      const vapi = new Vapi(publicKey!);
      vapiRef.current = vapi;

      vapi.on('call-start', () => setState('listening'));
      vapi.on('call-end', () => setState('ended'));
      vapi.on('speech-start', () => setState('speaking'));
      vapi.on('speech-end', () => setState('listening'));

      vapi.on('message', (msg: any) => {
        // Only final transcripts go in — partials would make the panel
        // flicker and would confuse a screen reader.
        if (msg?.type === 'transcript' && msg?.transcriptType === 'final') {
          const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
          const text = String(msg.transcript ?? '').trim();
          if (text) setTurns((prev) => [...prev, { role, text, at: Date.now() }]);
          // A finished user turn means the agent is now thinking.
          if (role === 'user') setState('thinking');
        }
      });

      vapi.on('error', (e: any) => {
        const message = e?.message ?? e?.error?.message ?? 'The call failed unexpectedly.';
        setError(String(message));
        setState('error');
      });

      await vapi.start(assistantId!);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Microphone permission is the single most common failure. Say so
      // plainly rather than surfacing a raw DOMException.
      setError(
        /permission|denied|notallowed/i.test(message)
          ? 'RelayPay needs microphone access to take the call. Allow it in your browser, then try again.'
          : message
      );
      setState('error');
    }
  }, [publicKey, assistantId]);

  const stop = useCallback(() => {
    try { vapiRef.current?.stop?.(); } catch { /* ignore */ }
    setState('ended');
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    try { vapiRef.current?.setMuted?.(next); setMuted(next); } catch { /* ignore */ }
  }, [muted]);

  const downloadTranscript = useCallback(() => {
    const body = turns
      .map((t) => `${t.role === 'user' ? 'You' : 'RelayPay Support'}: ${t.text}`)
      .join('\n\n');
    const blob = new Blob(
      [`RelayPay support call\n${new Date().toLocaleString()}\n\n${body}\n`],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relaypay-call-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [turns]);

  const live = state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'connecting';

  return (
    <div className="card">
      <div className="between" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Talk to RelayPay Support</h2>
        <span className="call-state" data-state={state} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {STATE_LABEL[state]}
        </span>
      </div>

      {/* Consent is shown, not only spoken — a caller should be able to
          read it before they start, not learn it once the line is open. */}
      <div className="consent">
        This call is handled by an AI support agent. The conversation is recorded and logged so
        RelayPay can review support quality. Do not share passwords or full card numbers.
      </div>

      {!configured && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          Voice is not configured on this deployment. Set <code className="mono">NEXT_PUBLIC_VAPI_PUBLIC_KEY</code>{' '}
          and <code className="mono">NEXT_PUBLIC_VAPI_ASSISTANT_ID</code> to enable calling.
        </div>
      )}

      {error && (
        <div className="notice notice-err" style={{ marginBottom: 16 }} role="alert">
          {error}
          <div style={{ marginTop: 6 }}>
            If this keeps happening, email{' '}
            <a href="mailto:support@relaypay.example">support@relaypay.example</a> instead.
          </div>
        </div>
      )}

      <div className="row row-wrap">
        {!live ? (
          <button className="btn btn-primary btn-lg" onClick={start} disabled={!configured}>
            {state === 'ended' ? 'Start another call' : 'Start call'}
          </button>
        ) : (
          <>
            <button className="btn btn-danger btn-lg" onClick={stop}>End call</button>
            <button className="btn" onClick={toggleMute} aria-pressed={muted}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
          </>
        )}
        {turns.length > 0 && !live && (
          <button className="btn" onClick={downloadTranscript}>Download transcript</button>
        )}
      </div>

      <div className="mt-4">
        <h3 id="transcript-heading">Live transcript</h3>
        <div
          className="transcript"
          ref={transcriptRef}
          role="log"
          aria-live="polite"
          aria-labelledby="transcript-heading"
          tabIndex={0}
        >
          {turns.length === 0 ? (
            <div className="transcript-empty">
              {live ? 'Listening — say something to get started.' : 'The transcript appears here as you talk.'}
            </div>
          ) : (
            turns.map((t, i) => (
              <div key={`${t.at}-${i}`} className={`turn turn-${t.role}`}>
                <div className="turn-role">{t.role === 'user' ? 'You' : 'RelayPay Support'}</div>
                <div>{t.text}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
