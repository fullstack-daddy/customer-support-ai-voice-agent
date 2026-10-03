'use client';

// The voice call surface.
//
// Vapi's Web SDK handles mic capture, streaming, turn-taking and
// barge-in. We drive it and render state.
//
// Two things worth noting:
//  - Barge-in stays ENABLED. A support caller who has to wait out a long
//    answer before correcting you has a bad time.
//  - The transcript is not decoration. It is the captions-equivalent for
//    anyone who cannot use audio, it is in an ARIA live region, and every
//    line is scrubbed of volunteered secrets before it renders.

import { useCallback, useEffect, useRef, useState } from 'react';
import { redactTranscript } from '@relaypay/shared/client';
import ContactConfirm from './ContactConfirm';
import { toast } from './Toast';
import { checkWebrtcSupport, explainCallError, type PreflightResult } from '@/lib/webrtc-preflight';

type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended';

interface Turn { role: 'user' | 'assistant'; text: string; at: number; }

const LABEL: Record<CallState, string> = {
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
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Browser capability, resolved in the browser. Null until then, so the
  // server and the first client render agree.
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);

  const vapiRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const configured = Boolean(publicKey && assistantId);
  const live = state === 'connecting' || state === 'listening' || state === 'thinking' || state === 'speaking';

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Whether this browser can do WebRTC at all. Checked up front so the
  // Start button is honest rather than failing on click.
  useEffect(() => { setPreflight(checkWebrtcSupport()); }, []);

  // Release the microphone if the component unmounts mid-call.
  useEffect(() => () => { try { vapiRef.current?.stop?.(); } catch { /* already gone */ } }, []);

  const start = useCallback(async () => {
    setError(null);
    setTurns([]);
    setConversationId(null);
    setState('connecting');

    // Re-check rather than trusting the mount-time result: permissions
    // and browser state can change while the page is open.
    const support = checkWebrtcSupport();
    if (!support.ok) {
      setError(support.hint ? `${support.message} ${support.hint}` : support.message);
      setState('error');
      return;
    }

    try {
      const { default: Vapi } = await import('@vapi-ai/web');
      const vapi = new Vapi(publicKey!);
      vapiRef.current = vapi;

      vapi.on('call-start', () => setState('listening'));
      vapi.on('call-end', () => setState('ended'));
      vapi.on('speech-start', () => setState('speaking'));
      vapi.on('speech-end', () => setState('listening'));

      vapi.on('message', (msg: any) => {
        // The call id is how the transcript, the tickets and the audit
        // trail all tie together. Grab it the first time it appears.
        const callId = msg?.call?.id ?? msg?.callId;
        if (callId) setConversationId((prev) => prev ?? `vapi-${callId}`);

        // Only final transcripts render — partials would flicker and
        // would make a screen reader unusable.
        if (msg?.type === 'transcript' && msg?.transcriptType === 'final') {
          const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
          // Scrub before it reaches the screen. The panel is a real
          // disclosure surface and it is what the download button writes.
          const text = redactTranscript(String(msg.transcript ?? '').trim()).text;
          if (text) setTurns((prev) => [...prev, { role, text, at: Date.now() }]);
          if (role === 'user') setState('thinking');
        }
      });

      vapi.on('error', (e: any) => {
        setError(String(e?.message ?? e?.error?.message ?? 'The call failed unexpectedly.'));
        setState('error');
      });

      await vapi.start(assistantId!);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Turn DOMExceptions and Daily's opaque "WebRTC not supported or
      // suppressed" into something the caller can actually act on.
      setError(explainCallError(message));
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

  const download = useCallback(() => {
    const body = turns.map((t) => `${t.role === 'user' ? 'You' : 'RelayPay Support'}: ${t.text}`).join('\n\n');
    const blob = new Blob([`RelayPay support call\n${new Date().toLocaleString()}\n\n${body}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relaypay-call-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [turns]);

  return (
    <div className="card">
      <div className="btw mb3">
        <h2>Talk to support</h2>
        <span className="callstate" data-state={state} role="status" aria-live="polite">
          <span className="orb" aria-hidden="true" />
          {LABEL[state]}
        </span>
      </div>

      {/* Consent is shown, not only spoken — a caller should be able to
          read it before starting, not learn it once the line is open. */}
      <div className="notice notice-info mb3">
        <div>
          This call is handled by an AI agent and is recorded so RelayPay can review support quality.
          Please don&apos;t share passwords, card numbers, or security codes.
        </div>
      </div>

      {!configured && (
        <div className="notice notice-warn mb3">
          <div>
            Voice isn&apos;t configured on this deployment. Set{' '}
            <code>NEXT_PUBLIC_VAPI_PUBLIC_KEY</code> and <code>NEXT_PUBLIC_VAPI_ASSISTANT_ID</code>.
          </div>
        </div>
      )}

      {preflight && !preflight.ok && (
        <div className="notice notice-warn mb3">
          <div>
            {preflight.message}
            {preflight.hint && <div className="sm mt1">{preflight.hint}</div>}
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-err mb3" role="alert">
          <div>
            {error}
            <div className="sm mt1">
              If this keeps happening, email <a href="mailto:support@relaypay.example">support@relaypay.example</a>.
            </div>
          </div>
        </div>
      )}

      <div className="row row-wrap">
        {!live ? (
          <button
            className="btn btn-primary btn-lg"
            onClick={start}
            disabled={!configured || preflight?.ok === false}
          >
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
          <button className="btn" onClick={download}>Download transcript</button>
        )}
      </div>

      {/* Appears the moment the agent takes contact details, so a misheard
          email is corrected while the caller is still on the line. */}
      <ContactConfirm
        conversationId={conversationId}
        active={live}
        onResolved={(confirmed) =>
          toast(confirmed ? 'Thanks — we have got that.' : 'No problem, skipped.')
        }
      />

      <div className="mt3">
        <div className="btw mb2">
          <h3 id="tx-head">Live transcript</h3>
          {turns.length > 0 && <span className="xs faint">{turns.length} turns</span>}
        </div>
        <div
          className="card card-pad-0"
          style={{ background: 'var(--s0)' }}
        >
          <div
            className="transcript"
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-labelledby="tx-head"
            tabIndex={0}
          >
            {turns.length === 0 ? (
              <div className="empty" style={{ padding: '32px 16px' }}>
                <p>{live ? 'Listening — say something to get started.' : 'Your conversation appears here as you talk.'}</p>
              </div>
            ) : (
              turns.map((t, i) => (
                <div key={`${t.at}-${i}`} className={`bubble ${t.role === 'user' ? 'bubble-user' : 'bubble-agent'}`}>
                  <div className="who">{t.role === 'user' ? 'You' : 'RelayPay'}</div>
                  {t.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
