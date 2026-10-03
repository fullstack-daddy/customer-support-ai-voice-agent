# Vapi configuration

Everything the Vapi dashboard needs so the assistant and this repo agree.

## The architecture decision comes first

Vapi can be wired to a backend in two ways, and they are mutually exclusive.

| | **Custom LLM** (what this repo implements) | **Custom tool** |
| --- | --- | --- |
| Who reasons | Our agent, via `/api/vapi/chat/completions` | Vapi's own LLM |
| Who holds the system prompt | `packages/agent/src/system-prompt.ts` | The Vapi dashboard |
| Who calls the MCP tools | Our agent | Our agent, behind a `support_agent` tool |
| Dashboard prompt is | **Ignored** — the route drops Vapi's system message | The whole brain |
| Extra work needed | None | A `support_agent` tool endpoint, which does not exist yet |

**This repo implements Custom LLM.** `docs/vapi-system-prompt.md` was written for the *custom tool* shape. Pasting it into an assistant that has no `support_agent` tool is what produces a call where the agent answers "what are you?" normally but says *"I can't reach our support system"* for every real question: the prompt orders it to call a tool it does not have, and the quoted sentence is the prompt's own failure line.

Pick Custom LLM unless you specifically want Vapi's LLM handling small talk.

## 1. Model

**Assistant → Model**

| Field | Value |
| --- | --- |
| Provider | **Custom LLM** |
| URL | `https://<your-host>/api/vapi` |
| Secret / API key | the same string as `VAPI_SERVER_SECRET` in your env |
| Model name | anything (e.g. `relaypay-support-agent`) — our route ignores it |
| System prompt | leave empty or one line; **the route discards it** |

On the URL: **Vapi appends `/chat/completions` to whatever you type.** The dashboard says so directly under the field — it previews the full URL it will call. So enter the base and let it append:

| You type | Vapi calls | Result |
| --- | --- | --- |
| `https://<host>/api/vapi` | `https://<host>/api/vapi/chat/completions` | correct |
| `https://<host>/api/vapi/chat/completions` | `.../chat/completions/chat/completions` | 404 every turn |
| `https://<host>/chat/completions` | `/chat/completions/chat/completions` | 404 every turn |

Read that preview line before saving; it is the fastest way to catch this. The repo also serves the handler at `/api/vapi` itself, so a GET to the base returns a health payload you can check in a browser.

The system prompt genuinely does not matter here. The route drops Vapi's system message on purpose and uses the agent's own, which carries the security rules. Changing the dashboard prompt will not change the agent's behaviour — edit `packages/agent/src/system-prompt.ts` instead.

## 2. Server URL (end-of-call)

**Assistant → Advanced → Server URL**

| Field | Value |
| --- | --- |
| Server URL | `https://<your-host>/api/vapi/end-of-call` |
| Secret | the same `VAPI_SERVER_SECRET` |

This is what persists the transcript for admin review. Without it, calls happen but nothing is saved.

## 3. First message

Set **First message** to something short, or leave Vapi to ask our endpoint. Our route already returns a greeting when there is no user turn yet:

> Hi, thanks for calling RelayPay support. This call may be recorded for quality and support purposes. How can I help today?

Set it in one place only, or the caller hears two greetings.

## 4. Local development

Vapi calls your server from its cloud, so `localhost` is unreachable. Expose it:

```bash
npx ngrok http 3000
```

Then set the Model URL to `https://<id>.ngrok.app/api/vapi` and the Server URL to `https://<id>.ngrok.app/api/vapi/end-of-call`. The free tier changes the subdomain on every restart, so both have to be updated each time.

## 5. Checking it without making a call

```bash
curl -X POST http://localhost:3000/api/vapi \
  -H 'content-type: application/json' \
  -H 'x-vapi-secret: YOUR_VAPI_SERVER_SECRET' \
  -d '{"model":"x","stream":true,"call":{"id":"t1"},
       "messages":[{"role":"user","content":"What is the status of TXN-9001?"}]}'
```

Expected: `data:` lines ending in `data: [DONE]`. What you get tells you where the problem is:

| Response | Meaning |
| --- | --- |
| `401 Unauthorized` | `VAPI_SERVER_SECRET` missing or different from the header |
| `404` | wrong path — use `/api/vapi` |
| A real answer | backend is healthy; any remaining fault is in the Vapi dashboard |
| "I'm having trouble processing that right now" | the agent ran but a tool failed — check the server log for `[agent]` |

## 6. Prerequisites that are easy to miss

- **Run all four migrations** in `supabase/migrations/` against the project `SUPABASE_URL` points at, then `npm run seed`. If `lookup_transaction` cannot find `TXN-9001`, the schema or the seed is missing — or `SUPABASE_URL` is pointing at a different project.
- **`npm run build` before `npm run dev`.** The agent spawns `packages/mcp-server/dist/index.js`; if it was never built, every tool-using turn fails.
- **Node 20 or later.** On Node < 22 the Supabase client needs a WebSocket implementation, which `packages/shared` now supplies via `ws`.
