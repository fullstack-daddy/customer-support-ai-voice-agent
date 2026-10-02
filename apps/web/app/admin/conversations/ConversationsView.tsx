'use client';

// Conversation history and the full audit trail for any one call.
//
// Split layout: the list stays on screen while a conversation is open, so
// an admin working through a queue does not lose their place every time
// they inspect one.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/Toast';

interface Conversation {
  conversation_id: string;
  channel: string;
  started_at: string;
  ended_at: string | null;
  final_status: string | null;
  summary: string | null;
  customer_id: string | null;
  metadata: Record<string, unknown> | null;
}
interface Counts { turns: number; tools: number; tickets: number; escalations: number; }

interface Detail {
  conversation: Conversation;
  turns: { turn_index: number; role: string; transcript: string | null; response: string | null; answer_type: string | null; confidence_note: string | null }[];
  tool_calls: { tool_name: string; purpose: string | null; input_summary: string | null; result_summary: string | null; status: string; error_message: string | null; latency_ms: number | null }[];
  retrieval_logs: { query: string; source_title: string | null; result_count: number; used_in_answer: boolean; retrieval_mode: string }[];
  tickets: { ticket_id: string; category: string; priority: string; summary: string; status: string }[];
  escalations: { escalation_id: string; category: string; reason: string; call_booked: boolean; status: string }[];
}

function statusPill(s: string | null) {
  if (!s) return <span className="pill pill-info">live</span>;
  const cls = s === 'resolved' ? 'pill-ok' : s === 'escalated' ? 'pill-warn' : s === 'abandoned' ? 'pill-err' : 'pill';
  return <span className={`pill ${cls}`}>{s}</span>;
}

const ANSWER_PILL: Record<string, string> = {
  direct_answer: 'pill-ok', clarifying_question: 'pill-info',
  escalation: 'pill-warn', decline: 'pill-err', tool_result: 'pill'
};

export default function ConversationsView() {
  const [list, setList] = useState<Conversation[]>([]);
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/conversations?limit=200', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const j = await res.json();
      setList(j.conversations ?? []);
      setCounts(j.counts ?? {});
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    (async () => {
      try {
        const res = await fetch(`/api/admin/conversations/${encodeURIComponent(sel)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Could not open conversation (${res.status})`);
        setDetail(await res.json());
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'err');
      }
    })();
  }, [sel]);

  const shown = useMemo(() => list.filter((c) => {
    if (!q) return true;
    const hay = `${c.conversation_id} ${c.summary ?? ''} ${c.customer_id ?? ''} ${c.final_status ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [list, q]);

  return (
    <main className="wrap wrap-wide">
      <div className="btw mb3">
        <div>
          <h1>Conversations</h1>
          <p className="lede" style={{ marginTop: 4 }}>
            Every call, with the transcript, tool calls and retrieval behind it.
          </p>
        </div>
        <div className="row">
          <input
            type="search" placeholder="Search…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }}
          />
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            {loading ? <><span className="spin" /> Loading</> : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="split">
        <div className="card card-pad-0">
          {loading ? (
            <div className="empty"><p>Loading…</p></div>
          ) : shown.length === 0 ? (
            <div className="empty">
              <h4>No conversations</h4>
              <p>Make a call, or run the evaluation suite.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Conversation</th><th>Channel</th><th>Status</th>
                    <th className="r">Turns</th><th className="r">Tools</th><th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const n = counts[c.conversation_id] ?? { turns: 0, tools: 0, tickets: 0, escalations: 0 };
                    return (
                      <tr
                        key={c.conversation_id}
                        data-sel={sel === c.conversation_id}
                        onClick={() => setSel(c.conversation_id)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className="mono" style={{ color: 'var(--t0)' }}>
                          {c.conversation_id}
                          {(n.tickets > 0 || n.escalations > 0) && (
                            <div className="row mt1" style={{ gap: 4 }}>
                              {n.tickets > 0 && <span className="pill pill-bare xs">{n.tickets} ticket</span>}
                              {n.escalations > 0 && <span className="pill pill-warn xs">{n.escalations} esc</span>}
                            </div>
                          )}
                        </td>
                        <td className="xs dim">{c.channel}</td>
                        <td>{statusPill(c.final_status)}</td>
                        <td className="r num">{n.turns}</td>
                        <td className="r num">{n.tools}</td>
                        <td className="xs dim" style={{ whiteSpace: 'nowrap' }}>
                          {new Date(c.started_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card" style={{ position: 'sticky', top: 70 }}>
          {!detail ? (
            <div className="empty">
              <h4>Select a conversation</h4>
              <p>The full audit trail appears here.</p>
            </div>
          ) : (
            <>
              <div className="btw mb2">
                <h2 className="mono" style={{ fontSize: 13 }}>{detail.conversation.conversation_id}</h2>
                <button className="btn btn-sm btn-ghost" onClick={() => setSel(null)}>Close</button>
              </div>

              {detail.conversation.summary && (
                <p className="sm" style={{ color: 'var(--t1)' }}>{detail.conversation.summary}</p>
              )}

              <h3 className="mt3">Transcript</h3>
              <div className="transcript" style={{ background: 'var(--s0)', borderRadius: 'var(--r-sm)', maxHeight: 300 }}>
                {detail.turns.map((t) => (
                  <div key={t.turn_index} className={`bubble ${t.role === 'user' ? 'bubble-user' : 'bubble-agent'}`}>
                    <div className="who">
                      {t.role === 'user' ? 'Caller' : 'Agent'}
                      {t.answer_type && (
                        <span className={`pill ${ANSWER_PILL[t.answer_type] ?? 'pill'} xs`} style={{ marginLeft: 6 }}>
                          {t.answer_type.replace('_', ' ')}
                        </span>
                      )}
                    </div>
                    {t.transcript ?? t.response}
                    {t.confidence_note && <div className="xs dim mt1"><em>{t.confidence_note}</em></div>}
                  </div>
                ))}
              </div>

              <h3 className="mt3">Tool calls ({detail.tool_calls.length})</h3>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="tbl">
                  <tbody>
                    {detail.tool_calls.map((t, i) => (
                      <tr key={i}>
                        <td className="mono xs" style={{ color: 'var(--brand)' }}>{t.tool_name}</td>
                        <td className="xs">{t.result_summary ?? t.error_message}</td>
                        <td className="r">
                          <span className={`pill ${t.status === 'success' ? 'pill-ok' : t.status === 'not_found' ? 'pill-warn' : 'pill-err'} xs`}>
                            {t.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detail.retrieval_logs.length > 0 && (
                <>
                  <h3 className="mt3">Retrieval</h3>
                  <table className="tbl">
                    <tbody>
                      {detail.retrieval_logs.map((r, i) => (
                        <tr key={i}>
                          <td className="xs">{r.query}</td>
                          <td className="r">
                            {/* "used" is the interesting column: retrieval that
                                ran and was then ignored is the quiet failure. */}
                            <span className={`pill ${r.used_in_answer ? 'pill-ok' : 'pill-warn'} xs`}>
                              {r.used_in_answer ? 'used' : 'unused'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
