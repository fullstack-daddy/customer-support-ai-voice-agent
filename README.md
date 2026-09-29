# RelayPay Support Agent

A production-style voice customer-support agent for RelayPay, a B2B cross-border payments platform.

Vapi handles the voice layer. The Claude Agent SDK handles the support logic. A custom-built MCP server is the only path to business data. Every decision the agent makes is written to Supabase so a reviewer can reconstruct any call.

**The agent never invents an answer.** Product and policy questions are grounded in an approved knowledge base or declined.

---

## Architecture

```
                      ┌──────────────────────────┐
  Customer's browser  │  Web app (Next.js)       │
  or phone call       │  - Vapi Web SDK widget   │
                      │  - Call UI + transcript  │
                      │  - Internal review page  │
                      └────────────┬─────────────┘
                                   │ voice (WebRTC) / PSTN
                      ┌────────────▼─────────────┐
                      │          Vapi            │  <- voice layer only:
                      │ STT → orchestration → TTS│     turn-taking, interruption,
                      └────────────┬─────────────┘     audio, telephony
                                   │ HTTPS, OpenAI-compatible
                                   │ Custom LLM request per turn
                      ┌────────────▼─────────────┐
                      │ /api/vapi/chat/completions│  <- Next.js route, NODE runtime
                      │ (verifies shared secret)  │     (must spawn a child process)
                      └────────────┬─────────────┘
                                   │ Agent SDK query()
                      ┌────────────▼─────────────┐
                      │   Claude Agent SDK agent │  <- decision rules, tone,
                      │  (system prompt encodes  │     escalation stop-condition
                      │   the four response paths)│
                      └────────────┬─────────────┘
                                   │ MCP (stdio)
                      ┌────────────▼─────────────┐
                      │   RelayPay MCP server    │  <- lookup_customer,
                      │ (@modelcontextprotocol)  │     lookup_transaction,
                      │                          │     lookup_payout,
                      │                          │     create_support_ticket,
                      │                          │     create_escalation,
                      │                          │     log_conversation_event,
                      │                          │     search_knowledge_base
                      └────────────┬─────────────┘
                                   │ supabase-js (service role, server-only)
                      ┌────────────▼─────────────┐
                      │         Supabase         │  seed tables + runtime tables
                      └──────────────────────────┘
```

**Vapi runs as a Custom LLM client, not the other way around.** It never sees the MCP tools, Supabase, or the knowledge base — only a plain assistant message to speak. All tool use, retrieval and decision logic happens inside the Agent SDK call.

**Retrieval is a tool the agent calls, not a step that runs before it.** `search_knowledge_base` is an MCP tool, so every retrieval is logged with the query the model actually used, and the agent stays in control of when it needs grounding — including refusing to answer when retrieval comes back empty.

### Layout

```
apps/web              Next.js app: voice widget, call UI, review dashboard, API routes
packages/mcp-server   Standalone MCP server (tools + Supabase access)
packages/agent        Agent SDK wiring, system prompt, turn orchestration
packages/shared       Zod schemas, types, Supabase client factory, constants
supabase/migrations   SQL migrations (schema + RLS)
supabase/seed         Seed loader, KB chunker, embeddings
scripts/eval          Test-scenario runner
docs/                 One-pager and Loom script
```

---

## Setup

### 1. Install

```bash
npm install
```

Node 20.11+ required.

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | console.anthropic.com → API Keys |
| `SUPABASE_URL` | yes | Supabase → Settings → API → Project URL (bare, no `/rest/v1`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Same page → `service_role` → Reveal. **Server-only.** |
| `SUPABASE_ANON_KEY` | no | Same page → `anon public`. Currently unused. |
| `VAPI_API_KEY` | for voice | Vapi dashboard → API Keys |
| `VAPI_SERVER_SECRET` | for voice | Invent one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Paste the same value into the Vapi assistant's Server URL settings. |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | for voice | Vapi dashboard → publishable key. Browser-safe. |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | for voice | Vapi assistant id. Browser-safe. |
| `INTERNAL_REVIEW_SECRET` | yes | Invent one, same generator. Gates `/internal/review`. |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | no | Enables vector retrieval. Without either, retrieval uses Postgres full-text search and logs `retrieval_mode: 'lexical'`. |

### 3. Migrate

Supabase dashboard → SQL Editor. Run in order:

1. `supabase/migrations/0001_seed_tables.sql`
2. `supabase/migrations/0002_runtime_tables.sql`
3. `supabase/migrations/0003_embeddings.sql` — optional; skip if you are not using embeddings

All three are idempotent.

### 4. Seed

```bash
npm run seed
```

Upserts the three CSVs and chunks the knowledge base. Safe to re-run.

### 5. Verify the data layer before anything else

```bash
npm run build                # packages must be built; the agent spawns dist/index.js
npm run mcp:smoke            # 40+ assertions against seeded data
```

If this passes, the MCP server and Supabase are sound. Debug this layer first when something breaks later.

### 6. Run

```bash
npm run dev                  # http://localhost:3000
```

---

## Vapi configuration

Create an assistant in the Vapi dashboard with:

**Model** — provider `custom-llm`, URL `https://<your-host>/api/vapi/chat/completions`.

**Server URL secret** — the same value as `VAPI_SERVER_SECRET`. The endpoint rejects unauthenticated requests with 401; it triggers Claude API spend, so it must not be publicly callable.

**First message** — doubles as the recording-consent disclosure:

> Hi, thanks for calling RelayPay support. This call may be recorded for quality and support purposes. How can I help today?

**Voice** — a calm, professional preset. No playful voices; `brand-direction.md` is explicit.

**Interruption / barge-in** — leave enabled. A caller who must wait out a long answer before correcting you has a bad time.

**Silence timeout** — ~20s with a gentle re-prompt, and a max call duration. Both end the call cleanly.

**Server URL (end-of-call-report)** — `https://<your-host>/api/vapi/end-of-call`, same secret.

### Local testing

Vapi needs a public URL. Tunnel:

```bash
npx ngrok http 3000
```

Then point the assistant at the ngrok URL.

---

## Deployment

The chat-completions route **must not** run as an Edge Function. The Agent SDK spawns the MCP server as a child process; Edge cannot do that.

Two options:

| Option | Notes |
| --- | --- |
| **Persistent Node service** (Render, Railway, Fly.io) — recommended | The MCP subprocess is not re-spawned per call. Lower latency, and the rate limiter's in-memory window actually means something. |
| **Vercel with Node.js serverless runtime** | Works. `maxDuration` is set to 60s on the route. The MCP subprocess cold-starts on each invocation, adding latency to the first turn. |

Set `RELAYPAY_MCP_ENTRYPOINT` to the absolute path of the built MCP server if your host's working directory differs from the repo root.

---

## Testing

```bash
npm run eval                 # 9 PRD scenarios + 4 safety probes
npm run eval -- S5           # one scenario
npm run eval -- --safety     # injection/safety probes only
```

Each run writes one row per scenario to `evaluations`. Export the evidence table rather than hand-typing it:

```
GET /api/internal/evaluations?format=md&key=$INTERNAL_REVIEW_SECRET
GET /api/internal/evaluations?format=csv&key=$INTERNAL_REVIEW_SECRET
```

Scenario 9 (voice flow) is verified at the data layer by the script and **must also be run once as a real voice call** — STT and TTS actually working is the one thing a scripted suite cannot check.

Other checks that need no credentials:

```bash
npx tsx supabase/seed/chunk-kb.test.ts    # KB chunking assertions
npm run check:secrets                      # secret-leak CI check
```

---

## Security

| Control | Where |
| --- | --- |
| Service-role key never reaches the browser | `scripts/check-secrets.mjs` fails the build if it appears under `apps/web/` outside a server-only file, or if any secret is hung off `NEXT_PUBLIC_*` |
| RLS enabled on all 11 tables, no permissive policies | `0001`/`0002`. All access is server-side via the service role; the browser never queries Supabase directly |
| Vapi endpoints verify a shared secret | `lib/security.server.ts`, constant-time compare, **fails closed** if the secret is unset |
| Input validated before any query | Every MCP tool validates with Zod first; malformed IDs are rejected, not coerced |
| No balance, raw notes, or risk detail can reach the model | Structural: there is no `balance` column, and `support_notes` is renamed to `internal_flag` at the tool boundary. Prompt rules are the second line of defence, not the only one |
| Timeouts + fail-soft on every external call | Supabase 5s with one retry; Agent SDK turn under an AbortController; embeddings 8s at query time |
| Rate limiting | 40 turns/min per client on the chat-completions endpoint |
| CORS restricted | `ALLOWED_ORIGINS`, never `*` |
| PII redacted in logs | `redact.ts` masks emails and names in `input_summary` |
| Duplicate tickets/escalations prevented | Tool-level check plus a partial unique index in Postgres |

**Known limitation:** the rate limiter is in-memory and per-process. Behind multiple instances each gets its own window. Adequate for a demo deployment; a production multi-instance deployment should move it to Redis or Supabase.

---

## Design decisions

**`support_notes` is returned as `internal_flag`.** `mcp-tool-requirements.md` lists `support_notes` in the `lookup_customer` output. In the seed data that field holds instructions aimed at the agent — `CUS-1003` reads *"Account is under compliance review. Escalate account-specific questions."* Returning it under a name that sits alongside speakable fields invites the model to read it aloud, which would leak an internal compliance signal. Renaming preserves the routing value the spec intended while making the confusion structurally impossible.

**`lookup_customer` gains `multiple_matches` + `candidates`.** The spec has no shape for "two customers match this company name". Guessing between them is exactly what the PRD warns against, so an ambiguous match returns a safe disambiguation list (ids and company names only) and the agent asks which one.

**No `balance` column exists.** The knowledge base states that automated and voice-based systems have no access to account balances. Enforcing that by omitting the column is stronger than a prompt instruction, which can be argued with.

**`answer_type` is derived, not self-reported.** Asking the model to classify its own turn produces turns labelled `direct_answer` that were actually declines. It is derived from observed behaviour: which tools ran, whether retrieval found anything, whether the reply ends in a question.

**Escalation state is read from the database each turn, not held in the prompt.** `escalation-rules.md` says the agent must stop troubleshooting once it has escalated. A model asked to remember that across turns sometimes will not, and the custom-LLM endpoint is stateless per request anyway.

**Non-streaming completions.** The endpoint returns a single well-formed OpenAI-compatible response. Vapi accepts this; streaming would shave perceived latency and is the obvious next improvement.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Environment is not configured correctly` | A required var is missing or malformed. The message names the exact variable. |
| `SUPABASE_URL must NOT include /rest/v1` | Paste the bare project URL. |
| MCP tools all fail with "table not found" | Migrations not run, or run against a different project. |
| `npm run mcp:smoke` fails on lookups | Seed not run. `npm run seed`. |
| Agent answers but calls no tools | Packages not built — the agent spawns `packages/mcp-server/dist/index.js`. Run `npm run build`. |
| Vapi returns 401 | `VAPI_SERVER_SECRET` differs between `.env` and the Vapi assistant's Server URL settings. |
| Assistant goes silent mid-call | Check the chat-completions logs. The route always returns a spoken fallback rather than a 500, so silence means the request never arrived — usually a tunnel or URL problem. |
| Retrieval always says `lexical` | No embeddings key set. Expected, and not a fault — the fallback is a designed path. |
| Review dashboard says "Access denied" | Append `?key=<INTERNAL_REVIEW_SECRET>`. |

---

## What still needs a human

- **The Loom recording.** Script in `docs/loom-script.md`.
- **The reflection sheet.**
- **One real voice call** to confirm STT/TTS end-to-end (scenario 9).
- **A phone number**, optionally, if your Vapi plan supports provisioning one.
