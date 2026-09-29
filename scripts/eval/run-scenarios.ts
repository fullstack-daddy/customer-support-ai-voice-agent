// Scenario runner.
//
//   npm run eval              all nine PRD scenarios + safety probes
//   npm run eval -- S5        one scenario
//   npm run eval -- --safety  safety probes only
//
// Drives the Agent SDK backend directly (text in, text out). Voice is not
// needed at this layer — STT/TTS is Vapi's job and is verified by a real
// call, which is the one thing a scripted suite genuinely cannot check.
//
// Writes one `evaluations` row per scenario so the testing-evidence table
// is EXPORTED from Supabase rather than hand-typed.

import { randomUUID } from 'node:crypto';
import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { runAgentTurn, type AgentTurnResult } from '@relaypay/agent';
import { SCENARIOS, SAFETY_SCENARIOS, type Scenario } from './scenarios.js';

interface Outcome {
  scenario: Scenario;
  conversationId: string;
  turns: AgentTurnResult[];
  failures: string[];
  passed: boolean;
  error?: string;
  elapsedMs: number;
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const conversationId = `eval-${scenario.id.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const turns: AgentTurnResult[] = [];
  const history: { role: 'user' | 'assistant'; content: string }[] = [];

  process.stdout.write(`\n${scenario.id}  ${scenario.description}\n`);

  try {
    for (const message of scenario.messages) {
      process.stdout.write(`   caller: ${message}\n`);
      const result = await runAgentTurn({
        conversationId,
        userMessage: message,
        history: [...history],
        channel: 'text_eval'
      });
      turns.push(result);
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: result.text });

      const toolList = result.toolsCalled.map((t) => t.name).join(', ') || 'none';
      process.stdout.write(`   agent : ${result.text.replace(/\n/g, ' ').slice(0, 160)}\n`);
      process.stdout.write(`   tools : ${toolList}   type: ${result.answerType}\n`);
      if (result.degraded) process.stdout.write(`   NOTE  : degraded — ${result.degraded}\n`);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    process.stdout.write(`   ERROR : ${error}\n`);
    return { scenario, conversationId, turns, failures: [`threw: ${error}`], passed: false, error, elapsedMs: Date.now() - started };
  }

  const failures: string[] = [];
  for (const check of scenario.checks) {
    const reason = check.check(turns);
    if (reason) {
      failures.push(`${check.label} — ${reason}`);
      process.stdout.write(`   FAIL  ${check.label}\n          ${reason}\n`);
    } else {
      process.stdout.write(`   ok    ${check.label}\n`);
    }
  }

  return { scenario, conversationId, turns, failures, passed: failures.length === 0, elapsedMs: Date.now() - started };
}

/** Describe what actually happened, for the evaluations row. */
function describeActual(outcome: Outcome): string {
  if (outcome.error) return `Run failed: ${outcome.error}`;
  const tools = [...new Set(outcome.turns.flatMap((t) => t.toolsCalled.map((c) => c.name)))];
  const types = outcome.turns.map((t) => t.answerType);
  const reply = outcome.turns[outcome.turns.length - 1]?.text.replace(/\s+/g, ' ').slice(0, 300) ?? '';
  return [
    `Tools: ${tools.join(', ') || 'none'}.`,
    `Answer types: ${types.join(' -> ')}.`,
    `Final reply: "${reply}"`
  ].join(' ');
}

async function persist(outcome: Outcome): Promise<void> {
  const db = supabaseAdmin();
  const res = await withTimeout('write evaluation', () =>
    db.from('evaluations').insert({
      scenario_id: outcome.scenario.id,
      scenario_description: outcome.scenario.description,
      expected_behavior: outcome.scenario.expected,
      actual_behavior: describeActual(outcome),
      pass: outcome.passed,
      notes: outcome.failures.length ? outcome.failures.join(' | ') : null,
      conversation_id: outcome.conversationId
    })
  );
  if (!res.ok) console.error(`   (could not persist evaluation: ${res.error})`);
}

async function main() {
  const args = process.argv.slice(2);
  const safetyOnly = args.includes('--safety');
  const includeSafety = safetyOnly || !args.includes('--no-safety');
  const idFilter = args.filter((a) => /^[SX]\d+$/i.test(a)).map((a) => a.toUpperCase());

  let queue: Scenario[] = safetyOnly ? [] : [...SCENARIOS];
  if (includeSafety) queue = [...queue, ...SAFETY_SCENARIOS];
  if (idFilter.length) queue = queue.filter((s) => idFilter.includes(s.id));

  if (!queue.length) {
    console.error('No scenarios matched.');
    process.exitCode = 1;
    return;
  }

  console.log(`RelayPay evaluation — ${queue.length} scenario(s)`);
  console.log('='.repeat(72));

  const outcomes: Outcome[] = [];
  for (const scenario of queue) {
    const outcome = await runScenario(scenario);
    outcomes.push(outcome);
    await persist(outcome);
  }

  console.log(`\n${'='.repeat(72)}\nSummary\n`);
  const width = Math.max(...outcomes.map((o) => o.scenario.description.length));
  for (const o of outcomes) {
    const status = o.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${o.scenario.id.padEnd(4)} ${o.scenario.description.padEnd(width)}  ${(o.elapsedMs / 1000).toFixed(1)}s`);
    for (const f of o.failures) console.log(`          ${f}`);
  }

  const passed = outcomes.filter((o) => o.passed).length;
  console.log(`\n  ${passed}/${outcomes.length} passing`);
  console.log(`\n  Rows written to the evaluations table. Export the evidence table with:`);
  console.log(`    GET /api/internal/evaluations?format=md&key=$INTERNAL_REVIEW_SECRET\n`);

  process.exitCode = passed === outcomes.length ? 0 : 1;
}

main().catch((e) => {
  console.error(`\nEval runner crashed: ${e instanceof Error ? e.stack : e}`);
  process.exitCode = 1;
});
