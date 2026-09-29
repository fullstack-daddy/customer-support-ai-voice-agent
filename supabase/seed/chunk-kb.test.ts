// Chunker sanity check — runs without any credentials.
//   npx tsx supabase/seed/chunk-kb.test.ts

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkKnowledgeBase } from './chunk-kb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const md = readFileSync(resolve(ROOT, 'assets', 'relaypay-knowledge-base.md'), 'utf8');
const chunks = chunkKnowledgeBase(md);

console.log(`TOTAL CHUNKS: ${chunks.length}\n`);
for (const c of chunks) {
  console.log(`${c.id.padEnd(58)} ${String(c.content.length).padStart(5)} chars  | ${c.section_path}`);
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\nAssertions');

const fee = chunks.find((c) => /how does relaypay charge fees/i.test(c.title));
check('fee chunk exists (scenario 1)', Boolean(fee));
check('fee chunk keeps its answer', Boolean(fee && /corridor/i.test(fee.content)), fee?.summary);

const delayed = chunks.find((c) => /why is my payment delayed/i.test(c.title));
check('delay chunk exists', Boolean(delayed));
check('delay chunk keeps Q+A together', Boolean(delayed && /compliance reviews/i.test(delayed.content)));

const timelines = chunks.find((c) => /guarantee payment timelines/i.test(c.title));
check('no-guarantee chunk exists (scenario 8)', Boolean(timelines));

const crypto = chunks.find((c) => /cryptocurrency/i.test(c.content));
check('crypto-unsupported fact retrievable', Boolean(crypto));

const balances = chunks.find((c) => /account balances/i.test(c.content));
check('balance-exclusion policy retrievable', Boolean(balances));

const processing = chunks.find((c) => /how long do payments take/i.test(c.title));
check('payout timing chunk exists (scenario 8)', Boolean(processing));
check('payout timing has the 2-5 day range', Boolean(processing && /2 to 5 business days/i.test(processing.content)));

check('every chunk has content', chunks.every((c) => c.content.trim().length > 0));
check('every chunk id is unique', new Set(chunks.map((c) => c.id)).size === chunks.length);
check('no chunk is a bare heading', chunks.every((c) => c.content.replace(/\s+/g, ' ').length >= 40));

console.log(`\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) failed.`}`);
process.exitCode = failures === 0 ? 0 : 1;
