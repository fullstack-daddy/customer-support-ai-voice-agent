'use client';

// Review dashboard: conversations, their turns, tool calls, retrieval,
// tickets, escalations, and evaluation results.
//
// This is what makes testing evidence easy to produce, and it is a
// reasonable production feature in its own right — support ops would
// want exactly this view when a caller says "I rang yesterday and was
// told something different".

import { useCallback, useEffect, useState } from 'react';

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
  tool_calls: { tool_name: string; purpose: string | null; input_summary: string | null; result_summary: string | null; status: string; error_message: string | null; latency_ms: number | null; created_at: string }[];
  retrieval_logs: { query: string; source_title: string | null; result_count: number; used_in_answer: boolean; retrieval_mode: string; created_at: string }[];
  tickets: { ticket_id: string; category: string; priority: string; summary: string; status: string }[];
  escalations: { escalation_id: string; category: string; reason: string; user_email: string; call_booked: boolean; status: string }[];
}

interface Evaluation {
  scenario_id: string; scenario_description: string | null; expected_behavior: string | null;
  actual_behavior: string | null; pass: boolean; notes: string | null; run_at: string;
}

function statusPill(status: string | null) {
  if (!status) return <span className="pill">live</span>;
  const cls =
    status === 'resolved' ? 'pill pill-ok'
    : status === 'escalated' ? 'pill pill-warn'
    : status === 'declined' ? 'pill'
    : 'pill pill-err';
  return <span className={cls}>{status}</span>;
}

export default function ReviewDashboard({ reviewKey }: { reviewKey: string }) {
  const [tab, setTab] = useState<'conversations' | 'evaluations'>('conversations');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const authed = useCallback(
    (path: string) => fetch(path, { headers: { 'x-internal-secret': reviewKey }, cache: 'no-store' }),
    [reviewKey]
  );

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authed('/api/internal/conversations?limit=100');
      if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`);
      const j = await res.json();
      setConversations(j.conversations ?? []);
      setCounts(j.counts ?? {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [authed]);

  const loadEvaluations = useCallback(async () => {
    try {
      const res = await authed('/api/internal/evaluations');
      if (!res.ok) throw new Error(`Failed to load evaluations (${res.status})`);
      const j = await res.json();
      setEvaluations(j.evaluations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authed]);

  useEffect(() => { loadList(); loadEvaluations(); }, [loadList, loadEvaluations]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    (async () => {
      try {
        const res = await authed(`/api/internal/conversations/${encodeURIComponent(selected)}`);
        if (!res.ok) throw new Error(`Failed to load conversation (${res.status})`);
        setDetail(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selected, authed]);

  const passCount = evaluations.filter((e) => e.pass).length;

  return (
    <main className="page page-wide">
      <div className="between" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Internal review</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Conversations, tool calls, retrieval, tickets, escalations, and evaluation results.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => { loadList(); loadEvaluations(); }}>Refresh</button>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <button
          className={tab === 'conversations' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
          onClick={() => setTab('conversations')}
        >
          Conversations ({conversations.length})
        </button>
        <button
          className={tab === 'evaluations' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
          onClick={() => setTab('evaluations')}
        >
          Evaluations ({passCount}/{evaluations.length} passing)
        </button>
        {tab === 'evaluations' && evaluations.length > 0 && (
          <a className="btn btn-sm" href={`/api/internal/evaluations?format=csv&key=${encodeURIComponent(reviewKey)}`}>
            Export CSV
          </a>
        )}
      </div>

      {error && <div className="notice notice-err" style={{ marginBottom: 16 }}>{error}</div>}

      {tab === 'conversations' && (
        <>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            {loading ? (
              <div className="transcript-empty">Loading…</div>
            ) : conversations.length === 0 ? (
              <div className="transcript-empty">
                No conversations yet. Make a call, or run <code className="mono">npm run eval</code>.
              </div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Conversation</th><th>Channel</th><th>Status</th>
                    <th>Turns</th><th>Tools</th><th>Tickets</th><th>Esc.</th>
                    <th>Started</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map((c) => {
                    const n = counts[c.conversation_id] ?? { turns: 0, tools: 0, tickets: 0, escalations: 0 };
                    return (
                      <tr key={c.conversation_id}>
                        <td className="mono">{c.conversation_id}</td>
                        <td className="small">{c.channel}</td>
                        <td>{statusPill(c.final_status)}</td>
                        <td>{n.turns}</td><td>{n.tools}</td><td>{n.tickets}</td><td>{n.escalations}</td>
                        <td className="small muted">{new Date(c.started_at).toLocaleString()}</td>
                        <td>
                          <button className="btn btn-sm" onClick={() => setSelected(c.conversation_id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {detail && (
            <div className="card mt-3">
              <div className="between" style={{ marginBottom: 16 }}>
                <h2 style={{ margin: 0 }} className="mono">{detail.conversation.conversation_id}</h2>
                <button className="btn btn-sm" onClick={() => setSelected(null)}>Close</button>
              </div>

              {detail.conversation.summary && (
                <p className="small"><strong>Summary.</strong> {detail.conversation.summary}</p>
              )}
              {detail.conversation.metadata && (
                <p className="small muted mono">
                  {JSON.stringify(detail.conversation.metadata)}
                </p>
              )}

              <h3 className="mt-3">Turns ({detail.turns.length})</h3>
              <div className="transcript" style={{ maxHeight: 300 }}>
                {detail.turns.map((t) => (
                  <div key={t.turn_index} className={`turn turn-${t.role === 'user' ? 'user' : 'assistant'}`}>
                    <div className="turn-role">
                      {t.role === 'user' ? 'Caller' : 'Agent'}
                      {t.answer_type && <span className="pill" style={{ marginLeft: 8 }}>{t.answer_type}</span>}
                    </div>
                    <div className="small">{t.transcript ?? t.response}</div>
                    {t.confidence_note && (
                      <div className="small muted" style={{ marginTop: 4, fontStyle: 'italic' }}>{t.confidence_note}</div>
                    )}
                  </div>
                ))}
              </div>

              <h3 className="mt-3">Tool calls ({detail.tool_calls.length})</h3>
              <div style={{ overflowX: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr><th>Tool</th><th>Input</th><th>Result</th><th>Status</th><th>ms</th></tr>
                  </thead>
                  <tbody>
                    {detail.tool_calls.map((t, i) => (
                      <tr key={i}>
                        <td className="mono">{t.tool_name}</td>
                        <td className="small mono">{t.input_summary}</td>
                        <td className="small">{t.result_summary ?? t.error_message}</td>
                        <td>
                          <span className={t.status === 'success' ? 'pill pill-ok' : t.status === 'not_found' ? 'pill pill-warn' : 'pill pill-err'}>
                            {t.status}
                          </span>
                        </td>
                        <td className="small">{t.latency_ms ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detail.retrieval_logs.length > 0 && (
                <>
                  <h3 className="mt-3">Retrieval ({detail.retrieval_logs.length})</h3>
                  <table className="data">
                    <thead>
                      <tr><th>Query</th><th>Top source</th><th>Hits</th><th>Mode</th><th>Used</th></tr>
                    </thead>
                    <tbody>
                      {detail.retrieval_logs.map((r, i) => (
                        <tr key={i}>
                          <td className="small">{r.query}</td>
                          <td className="small">{r.source_title ?? '—'}</td>
                          <td>{r.result_count}</td>
                          <td><span className="pill">{r.retrieval_mode}</span></td>
                          <td>
                            <span className={r.used_in_answer ? 'pill pill-ok' : 'pill pill-warn'}>
                              {r.used_in_answer ? 'yes' : 'no'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {detail.tickets.length > 0 && (
                <>
                  <h3 className="mt-3">Tickets</h3>
                  <table className="data">
                    <thead><tr><th>Ticket</th><th>Category</th><th>Priority</th><th>Summary</th><th>Status</th></tr></thead>
                    <tbody>
                      {detail.tickets.map((t) => (
                        <tr key={t.ticket_id}>
                          <td className="mono">{t.ticket_id}</td><td>{t.category}</td><td>{t.priority}</td>
                          <td className="small">{t.summary}</td><td><span className="pill">{t.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {detail.escalations.length > 0 && (
                <>
                  <h3 className="mt-3">Escalations</h3>
                  <table className="data">
                    <thead><tr><th>Escalation</th><th>Category</th><th>Reason</th><th>Callback</th><th>Status</th></tr></thead>
                    <tbody>
                      {detail.escalations.map((e) => (
                        <tr key={e.escalation_id}>
                          <td className="mono">{e.escalation_id}</td><td>{e.category}</td>
                          <td className="small">{e.reason}</td>
                          <td>{e.call_booked ? 'requested' : 'no'}</td>
                          <td><span className="pill pill-warn">{e.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'evaluations' && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {evaluations.length === 0 ? (
            <div className="transcript-empty">
              No evaluation runs yet. Run <code className="mono">npm run eval</code>.
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Notes</th><th>Run</th></tr>
              </thead>
              <tbody>
                {evaluations.map((e, i) => (
                  <tr key={i}>
                    <td><strong>{e.scenario_id}</strong><div className="small muted">{e.scenario_description}</div></td>
                    <td className="small">{e.expected_behavior}</td>
                    <td className="small">{e.actual_behavior}</td>
                    <td><span className={e.pass ? 'pill pill-ok' : 'pill pill-err'}>{e.pass ? 'pass' : 'fail'}</span></td>
                    <td className="small muted">{e.notes}</td>
                    <td className="small muted">{new Date(e.run_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
