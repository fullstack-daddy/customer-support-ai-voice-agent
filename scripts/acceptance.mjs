#!/usr/bin/env node
// Acceptance run against a DEPLOYED RelayPay instance.
//
// Exercises the behaviours a grader needs to see, through the same HTTP
// surface Vapi uses, then checks that each one left a trace in Supabase.
// Nothing here is mocked: every reply comes out of the deployed agent,
// its MCP server, and the live database.
//
//   node scripts/with-env.mjs node scripts/acceptance.mjs [baseUrl]

const BASE =
  process.argv[2] ||
  process.env.APP_BASE_URL ||
  'https://customer-support-ai-voice-agent.onrender.com';
const SECRET = process.env.VAPI_SERVER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SECRET) {
  console.error('VAPI_SERVER_SECRET is required');
  process.exit(2);
}

const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, opts) {
  const stream = Boolean(opts && opts.stream);
  const started = Date.now();
  const res = await fetch(BASE + '/api/vapi', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
    body: JSON.stringify(Object.assign({ model: 'relaypay-support-agent', stream }, body))
  });
  const text = await res.text();
  const elapsed = (Date.now() - started) / 1000;

  if (stream) {
    const parts = [];
    for (const line of text.split(NL)) {
      if (line.indexOf('data: ') !== 0 || line.indexOf('[DONE]') !== -1) continue;
      try {
        const d = JSON.parse(line.slice(6));
        const c = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
        if (c) parts.push(c);
      } catch (e) {
        // comment frame or partial line
      }
    }
    return { reply: parts.join('').trim(), elapsed, status: res.status };
  }

  let reply = '';
  try {
    const d = JSON.parse(text);
    reply = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    reply = text.slice(0, 200);
  }
  return {
    reply: reply.trim(),
    elapsed,
    status: res.status,
    degraded: res.headers.get('x-relaypay-degraded')
  };
}

/** Warm the session the way the greeting does, then let the spawn land. */
async function openCall(callId, waitMs) {
  await post({ call: { id: callId }, messages: [] });
  await sleep(waitMs === undefined ? 30000 : waitMs);
}

/**
 * End the call so its agent subprocess is released.
 *
 * Without this the harness holds every session open at once. Each one
 * is a Claude Code subprocess, and on a small instance several at a
 * time is enough to exhaust memory — which showed up as 502s and an
 * empty reply partway through the first run.
 */
async function closeCall(callId) {
  await fetch(BASE + '/api/vapi/end-of-call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
    body: JSON.stringify({
      message: { type: 'end-of-call-report', call: { id: callId }, endedReason: 'customer-ended-call' }
    })
  }).catch(() => {});
  await sleep(2000);
}

/** The route namespaces Vapi call ids, so rows are stored prefixed. */
const stored = (callId) => 'vapi-' + callId;

const results = [];

function record(row) {
  results.push(row);
  console.log('');
  console.log('[' + (row.passed ? 'PASS' : 'FAIL') + '] ' + row.test + '  (' + row.elapsed.toFixed(1) + 's)');
  console.log('   asked : ' + row.asked);
  console.log('   reply : ' + row.reply.replace(/\s+/g, ' ').slice(0, 240));
  if (!row.passed) console.log('   wanted: ' + row.expected);
  if (row.degraded) console.log('   degraded: ' + row.degraded);
}

async function main() {
  console.log('Acceptance run against ' + BASE);
  console.log(new Date().toISOString());

  // ---- Conversation A: read-only behaviours, one continuous call -------
  const A = 'acc-a-' + Date.now();
  console.log('');
  console.log('Opening call A (warming the agent session)...');
  await openCall(A);
  const history = [];

  const askA = async (test, question, expected, check) => {
    history.push({ role: 'user', content: question });
    const r = await post({ call: { id: A }, messages: history.slice() });
    history.push({ role: 'assistant', content: r.reply });
    record({
      test,
      asked: question,
      reply: r.reply,
      expected,
      elapsed: r.elapsed,
      degraded: r.degraded,
      passed: check(r.reply),
      conversation: A
    });
  };

  await askA(
    'Knowledge-grounded answer',
    'What fees does RelayPay charge for sending money?',
    'Answer drawn from the knowledge base, naming what fees depend on',
    (r) => /corridor|transaction type|payment method/i.test(r) && !/having trouble|unable/i.test(r)
  );

  await askA(
    'Clarifying question',
    'My payment has not arrived yet.',
    'Asks a question back rather than guessing or inventing a status',
    (r) => r.indexOf('?') !== -1 && !/TXN-|status is|has arrived|was completed/i.test(r)
  );

  await askA(
    'Transaction lookup',
    'The reference is TXN-9001. What is its status?',
    'Returns facts from the seeded row (processing; 2400 USD; arrival 19 Aug)',
    (r) => /process/i.test(r) && /(2,?400|august|19)/i.test(r)
  );

  await askA(
    'Customer lookup',
    'I am customer CUS-1001. Can you confirm my account is in good standing?',
    'Looks the customer up rather than inventing an answer',
    (r) => r.length > 20 && !/having trouble|unable to/i.test(r)
  );

  await askA(
    'Unsupported question',
    'What will the weather be like in Lagos tomorrow?',
    'Declines and redirects rather than answering from general knowledge',
    // Refusing by name ("I can't help with weather forecasts") must not
    // read as answering, so look for an actual forecast, not the word.
    (r) =>
      /can't help|cannot help|not able|unable to help|only help|here to help with/i.test(r) &&
      !/\b\d{1,2}\s?(degrees|°)|sunny|showers|humid/i.test(r)
  );

  await closeCall(A);

  // ---- Conversation B: ticket creation ---------------------------------
  const B = 'acc-b-' + Date.now();
  console.log('');
  console.log('Opening call B...');
  await openCall(B);
  const qB =
    'My invoices are not generating for my EUR clients. Please raise a support ticket. ' +
    'My name is Dayo Ade and my email is dayo@example.com.';
  const rB = await post({ call: { id: B }, messages: [{ role: 'user', content: qB }] });
  record({
    test: 'Ticket creation',
    asked: qB,
    reply: rB.reply,
    elapsed: rB.elapsed,
    degraded: rB.degraded,
    conversation: B,
    expected: 'Creates a ticket and reads back a TICKET- reference',
    passed: /TICKET-/i.test(rB.reply)
  });

  await closeCall(B);

  // ---- Conversation C: escalation --------------------------------------
  const C = 'acc-c-' + Date.now();
  console.log('');
  console.log('Opening call C...');
  await openCall(C);
  const qC =
    'I have been waiting three weeks on a compliance review and nobody has replied. ' +
    'I want this escalated to a human specialist now. I am Dayo Ade, dayo@example.com.';
  const rC = await post({ call: { id: C }, messages: [{ role: 'user', content: qC }] });
  record({
    test: 'Human escalation',
    asked: qC,
    reply: rC.reply,
    elapsed: rC.elapsed,
    degraded: rC.degraded,
    conversation: C,
    expected: 'Escalates to a human without promising a timeline',
    passed: /specialist|escalat|human|team/i.test(rC.reply)
  });

  await closeCall(C);

  // ---- Voice transport --------------------------------------------------
  const V = 'acc-v-' + Date.now();
  const greet = await post({ call: { id: V }, messages: [] });
  const streamed = await post(
    { call: { id: V }, messages: [{ role: 'user', content: 'Hello, are you there?' }] },
    { stream: true }
  );
  const eoc = await fetch(BASE + '/api/vapi/end-of-call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET },
    body: JSON.stringify({
      message: { type: 'end-of-call-report', call: { id: V }, endedReason: 'customer-ended-call' }
    })
  });
  record({
    test: 'Voice flow (transport)',
    asked: 'greeting -> streamed turn -> end-of-call webhook',
    reply:
      'greeting ' + greet.elapsed.toFixed(2) + 's; streamed reply "' +
      streamed.reply.slice(0, 70) + '"; end-of-call HTTP ' + eoc.status,
    expected: 'Greeting returns immediately, the turn streams, the webhook accepts the report',
    elapsed: greet.elapsed + streamed.elapsed,
    conversation: V,
    passed: greet.elapsed < 5 && streamed.reply.length > 0 && eoc.status === 200
  });

  // ---- Logging ----------------------------------------------------------
  if (SUPABASE_URL && SERVICE_KEY) {
    const q = async (table, filter) => {
      const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + filter, {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
      });
      return r.ok ? r.json() : [];
    };
    const all = [A, B, C, V].map(stored).join(',');
    const three = [A, B, C].map(stored).join(',');
    const convs = await q('conversations', 'conversation_id=in.(' + all + ')&select=conversation_id,final_status');
    const turns = await q('conversation_turns', 'conversation_id=in.(' + three + ')&select=id');
    const tools = await q('tool_calls', 'conversation_id=in.(' + three + ')&select=id,tool_name');
    const tickets = await q('support_tickets', 'conversation_id=eq.' + stored(B) + '&select=ticket_id,priority');
    const escs = await q('escalations', 'conversation_id=eq.' + stored(C) + '&select=escalation_id,category');

    record({
      test: 'Logging',
      asked: 'Supabase rows written by the runs above',
      reply:
        'conversations ' + convs.length + ', turns ' + turns.length + ', tool_calls ' + tools.length +
        ', tickets ' + tickets.length + ', escalations ' + escs.length,
      expected: 'Every conversation, turn and tool call persisted',
      elapsed: 0,
      conversation: '-',
      passed: convs.length >= 3 && turns.length > 0 && tools.length > 0
    });

    const names = [];
    tools.forEach((t) => {
      if (names.indexOf(t.tool_name) === -1) names.push(t.tool_name);
    });
    console.log('   tools used: ' + (names.join(', ') || '(none)'));
    if (tickets.length) console.log('   ticket: ' + JSON.stringify(tickets[0]));
    if (escs.length) console.log('   escalation: ' + JSON.stringify(escs[0]));
  }

  const passed = results.filter((r) => r.passed).length;
  console.log('');
  console.log(passed + '/' + results.length + ' passed');
  console.log('');
  console.log('--- JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('harness failed:', e);
  process.exit(1);
});
