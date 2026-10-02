'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toast';

interface Evaluation {
  scenario_id: string;
  scenario_description: string | null;
  expected_behavior: string | null;
  actual_behavior: string | null;
  pass: boolean;
  notes: string | null;
  run_at: string;
}

export default function EvaluationsView() {
  const [rows, setRows] = useState<Evaluation[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/evaluations', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const j = await res.json();
      setRows(j.evaluations ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = onlyFailed ? rows.filter((r) => !r.pass) : rows;
  const passed = rows.filter((r) => r.pass).length;

  return (
    <main className="wrap wrap-wide">
      <div className="btw mb3">
        <div>
          <h1>Evaluations</h1>
          <p className="lede" style={{ marginTop: 4 }}>
            Scenario runs against the agent backend. Exported from here, not hand-written.
          </p>
        </div>
        <div className="row">
          <button
            className={onlyFailed ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setOnlyFailed((v) => !v)}
          >
            Failures only
          </button>
          <a className="btn btn-sm" href="/api/admin/evaluations?format=csv">Export CSV</a>
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            {loading ? <><span className="spin" /> Loading</> : 'Refresh'}
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="stats mb3">
          <div className="stat">
            <div className="k">Passing</div>
            <div className="v num" style={{ color: passed === rows.length ? 'var(--ok)' : 'var(--warn)' }}>
              {passed}/{rows.length}
            </div>
          </div>
          <div className="stat">
            <div className="k">Last run</div>
            <div className="v" style={{ fontSize: 15 }}>
              {rows[0] ? new Date(rows[0].run_at).toLocaleString() : '—'}
            </div>
          </div>
        </div>
      )}

      <div className="card card-pad-0">
        {loading ? (
          <div className="empty"><p>Loading…</p></div>
        ) : shown.length === 0 ? (
          <div className="empty">
            <h4>{onlyFailed ? 'No failures' : 'No evaluation runs'}</h4>
            <p>{onlyFailed ? 'Everything passed.' : 'Run npm run eval to populate this.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <div className="mono" style={{ color: 'var(--t0)' }}>{e.scenario_id}</div>
                      <div className="xs dim">{e.scenario_description}</div>
                    </td>
                    <td className="xs" style={{ maxWidth: 260 }}>{e.expected_behavior}</td>
                    <td className="xs" style={{ maxWidth: 300 }}>{e.actual_behavior}</td>
                    <td><span className={`pill ${e.pass ? 'pill-ok' : 'pill-err'}`}>{e.pass ? 'pass' : 'fail'}</span></td>
                    <td className="xs dim" style={{ maxWidth: 240 }}>{e.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
