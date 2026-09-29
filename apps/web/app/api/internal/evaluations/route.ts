// Internal review: evaluation results.
//
// Supports ?format=csv so the testing-evidence table can be EXPORTED
// rather than hand-typed, which the brief asks for explicitly.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { verifyInternalSecret, json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const authError = verifyInternalSecret(req.headers, url);
  if (authError) return json({ error: 'Unauthorized' }, { status: 401 });

  const db = supabaseAdmin();
  const res = await withTimeout('internal: evaluations', () =>
    db.from('evaluations').select('*').order('run_at', { ascending: false }).limit(200)
  );
  if (!res.ok) return json({ error: res.error }, { status: 500 });

  const evaluations = ((res.data as { data: Record<string, unknown>[] | null }).data ?? []);
  const format = url.searchParams.get('format');

  if (format === 'csv') {
    const cols = ['scenario_id', 'scenario_description', 'expected_behavior', 'actual_behavior', 'pass', 'notes', 'conversation_id', 'run_at'];
    const lines = [cols.join(',')];
    for (const row of evaluations) lines.push(cols.map((c) => csvCell(row[c])).join(','));
    return new Response(lines.join('\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="relaypay-testing-evidence.csv"'
      }
    });
  }

  if (format === 'md') {
    const header = '| Scenario | Expected | Actual | Pass | Notes |\n| --- | --- | --- | --- | --- |';
    const esc = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const body = evaluations
      .map((r) => `| ${esc(r.scenario_id)} | ${esc(r.expected_behavior)} | ${esc(r.actual_behavior)} | ${r.pass ? 'PASS' : 'FAIL'} | ${esc(r.notes)} |`)
      .join('\n');
    return new Response(`${header}\n${body}\n`, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  }

  return json({ evaluations });
}
