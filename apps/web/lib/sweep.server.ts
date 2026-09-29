// Stale-conversation sweeper.
//
// The end-of-call webhook can fail to arrive: a network blip, a Vapi
// outage, a deploy mid-call. Without this, those conversations sit open
// forever with a null ended_at and the review dashboard slowly fills with
// calls that look live but ended hours ago.
//
// Runs opportunistically on reads of the internal dashboard rather than
// as a cron, so there is no scheduler to deploy or keep alive. Cheap:
// one indexed UPDATE, throttled to once every few minutes per process.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';

const STALE_AFTER_HOURS = 2;
const THROTTLE_MS = 5 * 60_000;

let lastSweep = 0;

export async function sweepStaleConversations(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastSweep < THROTTLE_MS) return 0;
  lastSweep = now;

  const cutoff = new Date(now - STALE_AFTER_HOURS * 3600_000).toISOString();
  const db = supabaseAdmin();

  const res = await withTimeout('sweep stale conversations', () =>
    db
      .from('conversations')
      .update({
        ended_at: new Date().toISOString(),
        final_status: 'abandoned',
        summary: 'Closed automatically: no end-of-call report was received for this call.'
      })
      .is('ended_at', null)
      .lt('started_at', cutoff)
      .select('conversation_id')
  );

  if (!res.ok) {
    console.error(`[sweep] failed: ${res.error}`);
    return 0;
  }
  const rows = ((res.data as { data: unknown[] | null }).data ?? []);
  if (rows.length) console.warn(`[sweep] closed ${rows.length} stale conversation(s)`);
  return rows.length;
}
