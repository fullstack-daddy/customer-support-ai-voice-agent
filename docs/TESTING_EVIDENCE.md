# Testing evidence

**RelayPay Support Agent · Week 6** · Emmanuel Aboyeji · 2026-10-03

Every result below comes from `scripts/acceptance.mjs` run against the **deployed** service at `customer-support-ai-voice-agent.onrender.com`, over the same HTTP surface Vapi uses. Nothing is mocked. The raw output is in [`docs/acceptance-run.json`](acceptance-run.json).

```bash
node scripts/with-env.mjs node scripts/acceptance.mjs https://<your-host>
```

Final run: **9/9 passed**. It took four runs to get there, and the three defects found along the way are the interesting part.

## Results

| Test case | Expected result | Actual result | Passed? | Notes or fix made |
| --- | --- | --- | --- | --- |
| **Knowledge-grounded answer** | Answer from the knowledge base, not invented | *"Fees vary based on the corridor, the payment method, and transaction type. RelayPay shows you the exact fees before you confirm."* 14.3s | Yes | Failed earlier in development: `websearch_to_tsquery` ANDs every term, so a whole question had to appear in one chunk. Added an OR fallback and stopped scoring against words the corpus cannot contain. |
| **Clarifying question** | Asks rather than guessing | *"Is this a payment you sent out to someone, or a payment you were expecting to receive?"* 5.7s | Yes | First recorded as a failure — my assertion demanded the word "reference". The agent's question was better than the one I had imagined. Assertion corrected, not the agent. |
| **Customer lookup** | Reads the real customer record | *"Yes, your account is verified and in good standing. Your KYC is approved… You're on our Growth plan."* 14.5s, `lookup_customer: success` | Yes | Verified in a clean conversation. In the long multi-topic run the agent prioritised the unresolved payout instead and never called the tool — correct prioritisation, but weak evidence, so it was retested on its own. |
| **Transaction / payout lookup** | Returns the seeded row | *"Your payout TXN-9001 for 2400 US dollars is showing as processing. The estimated arrival was the 19th of August, which is now more than a month ago."* 14.1s | Yes | Matches the seed exactly, and it noticed the date had passed without being asked. |
| **Ticket creation** | Creates a ticket, reads back the reference | `TICKET-3061627C`, row present, 20.2s | Yes | **Real defect found.** The first run created `TICKET-E8C67FAA` under `voice_session_dayo_ade_20261003` — an id the *model invented*. The MCP server read `conversation_id` from the tool arguments. Now injected from the server environment and overwritten at the tool boundary. |
| **Human escalation** | Escalates to a human, promises no timeline | *"Done. Your escalation reference is ESC-E31B9D5B. A RelayPay specialist will follow up."* `category: compliance`, 32.5s over two turns | Yes | Failed as a one-turn test, for a good reason: the agent asks about a callback preference before escalating. The test now plays the exchange out, which is what a real call does. |
| **Unsupported question** | Declines, does not answer from general knowledge | *"I'm here to help with RelayPay support…"* — no forecast given, 4.1s | Yes | Also a bad assertion at first: it rejected the word "forecast" even inside a refusal. |
| **Voice flow** | Greeting, streamed turn, end-of-call webhook | Greeting **0.42s** to first byte; streamed reply received; end-of-call **HTTP 200** | Yes | **Real defect found.** Live calls were dropping with `ejected`. Vapi's custom-LLM timeout is 20s "without needing to stream any tokens back", and a turn takes ~25s — the route built the whole SSE body at the end, so Vapi saw silence. The response now opens immediately and fills in later. |
| **Logging** | Every turn and tool call persisted | 4 conversations, 16 turns, **9 tool calls**, 1 ticket, 1 escalation — all linked to the right conversation | Yes | Initially read 0 because my query forgot the `vapi-` id prefix; then genuinely 0 tool rows, which is what exposed the invented-conversation-id defect above. |

Tools exercised in the final run: `search_knowledge_base`, `lookup_transaction`, `lookup_customer`, `create_support_ticket`, `create_escalation`, `log_conversation_event`.

## Other suites

| Suite | Command | Result |
| --- | --- | --- |
| Redaction (PAN/CVV/OTP/password) | `npm test` | 46 assertions pass |
| Vapi request authentication | `npm test` | 10 assertions pass |
| Transcript card grouping | `npm test` | 12 assertions pass |
| MCP server integration | `npm run mcp:smoke` | 34 pass, 0 fail |
| Adversarial security probes | `npm run test:agent` | 4/4 held |

The security probes are the ones worth naming: prompt extraction, tool disclosure, balance invention and authority bypass. All four were refused — *"I don't have access to account balances"*, *"I can't process that. Refunds need to go through the proper escalation process."*

## What is not covered

- **Real audio** is exercised by hand through the browser call widget, not by this harness. The harness drives the same endpoint Vapi drives, so it covers the agent and the transport contract, but not speech recognition or barge-in.
- **Email sending** is tested up to the draft. Actual delivery needs a verified Resend domain and is gated on human approval by design.
- **Concurrency.** An early run opened four agent sessions at once and the instance returned 502s. Sessions are now closed when a call ends, but sustained concurrent load has not been tested.
