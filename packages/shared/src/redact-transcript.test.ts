// Transcript redaction tests.
//   npx tsx packages/shared/src/redact-transcript.test.ts
//
// The false-negative tests (does it catch secrets?) matter. The
// FALSE-POSITIVE tests matter more — over-redaction silently destroys the
// audit trail and breaks the agent, and nobody notices until a reviewer
// opens a transcript full of [redacted] and cannot tell what happened.

import { redactTranscript, luhnValid } from './redact-transcript.js';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`); }
}
function section(t: string) { console.log(`\n${t}`); }

/** Real-looking test PANs — these are the public test numbers every payment processor publishes. */
const VISA = '4111111111111111';
const MC = '5555555555554444';
const AMEX = '378282246310005';

section('Luhn');
check('accepts a valid test PAN', luhnValid(VISA));
check('accepts Mastercard test PAN', luhnValid(MC));
check('accepts Amex test PAN', luhnValid(AMEX));
check('rejects a near-miss', !luhnValid('4111111111111112'));
check('rejects something too short', !luhnValid('411111'));

section('Catches what it should');
const caught: Array<[string, string]> = [
  [`my card is ${VISA}`, 'card_number'],
  [`the number is 4111 1111 1111 1111`, 'card_number'],
  [`it's 4111-1111-1111-1111`, 'card_number'],
  [`four one one one one one one one one one one one one one one one`, 'spoken_card_number'],
  ['the cvv is 123', 'cvv'],
  ['security code 4567', 'cvv'],
  ['my one-time code is 889213', 'otp'],
  ['the verification code is 55213', 'otp'],
  ['my password is hunter2correct', 'password'],
  ['password: Tr0ub4dor', 'password'],
  ['my pin is 4821', 'password'],
  ['sort code 20-00-00', 'sort_code'],
  ['GB29 NWBK 6016 1331 9268 19', 'iban'],
  ['my ssn is 123-45-6789', 'national_id']
];
for (const [input, kind] of caught) {
  const r = redactTranscript(input);
  check(`${kind}: "${input.slice(0, 44)}"`, r.redacted && r.hits.some((h) => h.kind === kind), { got: r.hits, text: r.text });
}

section('Leaves business data alone — the part that breaks support if wrong');
const untouched = [
  'can you check transaction TXN-9001',
  'what about payout PAY-7002',
  'my customer id is CUS-1003',
  'the ticket is TICKET-4F2A91',
  'escalation ESC-9B22C1 please',
  'the amount was 2400 USD',
  'it was 5300 GBP on the 16th',
  'my invoice is for 1200 euros',
  'call me on 07700 900123',
  'my number is 555 0199',
  'it was due 2026-08-18',
  'we have about 40 employees',
  'reference 9001 please',
  'order 100045 shipped',
  'I sent 3100 to Rwanda',
  'the payout is scheduled for 2026-08-16'
];
for (const input of untouched) {
  const r = redactTranscript(input);
  check(`untouched: "${input}"`, !r.redacted, { text: r.text, hits: r.hits });
}

section('Preserves surrounding sentence');
const mixed = redactTranscript(`hi, my card is ${VISA} and the transaction is TXN-9001`);
check('redacts the card', mixed.text.includes('[redacted: card number]'), mixed.text);
check('keeps the reference', mixed.text.includes('TXN-9001'), mixed.text);
check('keeps the sentence readable', mixed.text.startsWith('hi, my card is'), mixed.text);
check('does not leak any part of the PAN', !mixed.text.includes('4111'), mixed.text);

section('Edge cases');
check('empty string is safe', redactTranscript('').redacted === false);
check('null is safe', redactTranscript(null).text === '');
check('undefined is safe', redactTranscript(undefined).text === '');
const multi = redactTranscript(`card ${VISA} cvv 123 password: letmein`);
check('catches several kinds in one turn', multi.hits.length >= 3, multi.hits);
check('reports kinds without values', multi.hits.every((h) => !JSON.stringify(h).includes('4111')), multi.hits);

section('Does not leak the value in the audit record');
const r = redactTranscript(`my card number is ${VISA}`);
check('hit records the kind only', r.hits[0]?.kind === 'card_number' && !('value' in (r.hits[0] as object)), r.hits[0]);
check('cleaned text has no digits from the PAN', !/4111/.test(r.text), r.text);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
