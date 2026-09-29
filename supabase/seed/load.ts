// Idempotent seed loader.
//
//   npm run seed
//
// Reads the three CSVs from assets/seed-data/, upserts them into Supabase
// (ON CONFLICT DO UPDATE via supabase-js `upsert`), then chunks the
// knowledge base and upserts those chunks too — embedding them if an
// embeddings key is configured, otherwise leaving the lexical
// full-text path to do the work.
//
// Re-running is safe: no duplicate rows, no failures on the second pass.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin, embeddingProvider } from '@relaypay/shared';
import { chunkKnowledgeBase } from './chunk-kb.js';
import { embedTexts } from './embed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SEED_DIR = resolve(ROOT, 'assets', 'seed-data');
const KB_PATH = resolve(ROOT, 'assets', 'relaypay-knowledge-base.md');

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields containing
 * commas and escaped quotes. The seed files are simple, but a support
 * note with a comma in it would silently corrupt a naive split(',').
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
// eslint-disable-next-line no-continue
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  return body.map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => { obj[key.trim()] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}

/** Empty CSV cell -> null, so NOT NULL/date columns behave. */
function nullIfBlank(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

async function upsert(table: string, rows: Record<string, unknown>[], conflictKey: string) {
  if (!rows.length) {
    console.log(`  ${table.padEnd(18)} 0 rows (nothing to load)`);
    return;
  }
  const db = supabaseAdmin();
  const { error } = await db.from(table).upsert(rows, { onConflict: conflictKey });
  if (error) throw new Error(`upsert ${table} failed: ${error.message}`);
  console.log(`  ${table.padEnd(18)} ${String(rows.length).padStart(3)} rows upserted`);
}

async function loadSeedTables() {
  console.log('\nSeed tables');

  const customers = parseCsv(readFileSync(resolve(SEED_DIR, 'customers.csv'), 'utf8')).map((r) => ({
    customer_id: r.customer_id,
    company_name: r.company_name,
    contact_name: nullIfBlank(r.contact_name),
    contact_email: nullIfBlank(r.contact_email),
    plan: r.plan,
    account_status: r.account_status,
    region: nullIfBlank(r.region),
    kyc_status: r.kyc_status,
    support_notes: nullIfBlank(r.support_notes)
  }));
  await upsert('customers', customers, 'customer_id');

  const transactions = parseCsv(readFileSync(resolve(SEED_DIR, 'transactions.csv'), 'utf8')).map((r) => ({
    transaction_id: r.transaction_id,
    customer_id: r.customer_id,
    transaction_type: r.transaction_type,
    amount: Number(r.amount),
    currency: r.currency,
    destination_country: nullIfBlank(r.destination_country),
    status: r.status,
    created_at: nullIfBlank(r.created_at),
    estimated_arrival: nullIfBlank(r.estimated_arrival),
    support_summary: nullIfBlank(r.support_summary)
  }));
  await upsert('transactions', transactions, 'transaction_id');

  const payouts = parseCsv(readFileSync(resolve(SEED_DIR, 'payouts.csv'), 'utf8')).map((r) => ({
    payout_id: r.payout_id,
    transaction_id: nullIfBlank(r.transaction_id),
    customer_id: nullIfBlank(r.customer_id),
    recipient_name: nullIfBlank(r.recipient_name),
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    scheduled_for: nullIfBlank(r.scheduled_for),
    failure_reason: nullIfBlank(r.failure_reason)
  }));
  await upsert('payouts', payouts, 'payout_id');
}

async function loadKnowledgeBase() {
  console.log('\nKnowledge base');
  const md = readFileSync(KB_PATH, 'utf8');
  const chunks = chunkKnowledgeBase(md);
  console.log(`  chunked into ${chunks.length} sections`);

  const provider = embeddingProvider();
  let embeddings: number[][] | null = null;
  if (provider) {
    try {
      console.log(`  embedding with ${provider}…`);
      embeddings = await embedTexts(chunks.map((c) => `${c.title}\n\n${c.content}`));
      console.log(`  embedded ${embeddings.length} chunks`);
    } catch (e) {
      // Not fatal. The lexical path covers us.
      console.warn(`  embedding failed (${e instanceof Error ? e.message : e}) — continuing with lexical search only.`);
      embeddings = null;
    }
  } else {
    console.log('  no embeddings key configured — lexical full-text search will be used.');
  }

  const rows = chunks.map((c, i) => ({
    id: c.id,
    title: c.title,
    section_path: c.section_path,
    content: c.content,
    summary: c.summary,
    ...(embeddings?.[i] ? { embedding: embeddings[i], embedding_model: provider } : {})
  }));
  await upsert('knowledge_chunks', rows, 'id');
}

async function main() {
  console.log('RelayPay seed loader');
  try {
    await loadSeedTables();
    await loadKnowledgeBase();
    console.log('\nDone. Re-running this script is safe — every write is an upsert.\n');
  } catch (e) {
    console.error(`\nSeed failed: ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  }
}

main();
