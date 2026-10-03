# Deploying

## Where this can run

The Claude Agent SDK spawns a Claude Code subprocess. That one fact decides the host.

| | **Render / Railway / Fly** | **Vercel** |
| --- | --- | --- |
| Agent subprocess | Works | **Does not work** |
| Size limit | None that matters | 250MB unzipped per function |
| Subprocess lifetime | Survives between requests | Re-spawned on every cold start |
| Good for | The whole app | Nothing here |

**Vercel cannot host this app.** It is worth stating plainly because the build succeeds and the failure only shows up as the agent saying "I'm having trouble processing that right now" on every turn:

- The SDK's per-platform native CLI is about **238MB**. A Vercel function is capped at 250MB unzipped, and Next plus the rest of `node_modules` does not fit in what is left. The function deploys, then every turn fails with `Native CLI binary for linux-x64 not found`.
- The SDK also ships a smaller `cli.js` that does fit, and pointing `pathToClaudeCodeExecutable` at it was tried. The agent starts, but **MCP tools never attach**: it loops on `ToolSearch` and never finds `lookup_transaction`, so it cannot answer anything factual. Reproduced on consecutive runs.

There is no configuration that resolves both, so the app is deployed to a persistent Node host.

---

## Render

`render.yaml` in the repo is a Blueprint. In Render: **New → Blueprint**, point it at the repo, and it reads that file.

| Setting | Value | Why |
| --- | --- | --- |
| Runtime | Node | |
| Build Command | `npm install && npm run build` | builds the workspace packages, then Next |
| Start Command | `npm start` | `next start`, which honours Render's `PORT` |
| Health Check Path | `/api/vapi` | returns a small JSON payload |
| `NODE_VERSION` | `22` | Node 22 has a native WebSocket, which `supabase-js` requires |

### Plan

The **free** plan spins the service down after about 15 minutes idle, and the next request pays a cold start *plus* the agent subprocess spawn. On a voice call that is the caller waiting through silence. **Starter** keeps it running, which also means the warm-session work survives between calls rather than only within one.

### Environment variables

Set these in the Render dashboard (the Blueprint declares them `sync: false`, so Render prompts rather than storing them in git):

| Variable | Notes |
| --- | --- |
| `ANTHROPIC_API_KEY` | |
| `SUPABASE_URL` | Bare project URL, no `/rest/v1` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Never prefix with `NEXT_PUBLIC_`. |
| `AUTH_SECRET` | 32+ random chars. Changing it logs everyone out. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | There is no sign-up; this is the only account |
| `VAPI_SERVER_SECRET` | Must match the Vapi assistant's secret |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | Publishable; safe in the browser |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | Publishable |
| `RESEND_API_KEY`, `EMAIL_FROM` | `EMAIL_FROM` must be on a **verified** Resend domain |
| `ALLOWED_ORIGINS`, `APP_BASE_URL` | Your Render URL |
| `VOYAGE_API_KEY` *or* `OPENAI_API_KEY` | Optional; without either, retrieval uses Postgres full-text |
| `CLAUDE_MODEL` | Optional; defaults to `claude-sonnet-4-5` |
| `AGENT_TURN_TIMEOUT_MS` | Optional; defaults to 90s |

**`NEXT_PUBLIC_*` variables are baked in at build time.** Adding one after a deploy does nothing until you redeploy. If the call page says "Voice isn't configured" where the variable is clearly set, this is why.

### Point Vapi at it

See [vapi-configuration.md](./vapi-configuration.md). In short:

- **Model → Custom LLM URL:** `https://<your-service>.onrender.com/api/vapi`
- **Server URL:** `https://<your-service>.onrender.com/api/vapi/end-of-call`
- Both secrets equal to `VAPI_SERVER_SECRET`

---

## Local development

Everything reads **one `.env` at the repo root**.

Next only auto-loads `.env` from its own directory (`apps/web`), so every env-dependent npm script runs through `scripts/with-env.mjs`, which loads the root file into the environment *before* Next starts. That ordering matters: loading it from `next.config.mjs` is too late, because Next restores its own snapshot of `process.env` afterwards and edge middleware cannot read files at all.

```bash
npm install
cp .env.example .env     # fill it in
npm run build            # workspace packages must be built before the agent can spawn the MCP server
npm run dev
```

### Exposing localhost to Vapi

Vapi calls your server from its cloud, so `localhost` is unreachable:

```bash
npx ngrok http 3000
```

Point the assistant's Custom LLM URL at `https://<id>.ngrok.app/api/vapi`. The free tier changes the subdomain on every restart.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every turn says "I'm having trouble processing that right now" | The agent ran but failed. The response carries `x-relaypay-degraded` with the reason — read it with curl, it is only visible to a caller holding `VAPI_SERVER_SECRET`. |
| `Native CLI binary for linux-x64 not found` | You are on Vercel, or a host that omitted optional dependencies. See the top of this page. |
| Agent replies but calls no tools, looping on `ToolSearch` | MCP never attached. Check `packages/mcp-server/dist` exists (`npm run build`). |
| "Voice isn't configured" despite the env being set | `NEXT_PUBLIC_*` is build-time. Redeploy. Locally, check the `.env` is at the **repo root**. |
| Build fails on `@relaypay/shared` not found | The workspace packages were not compiled. `apps/web`'s `prebuild` hook does this. |
| Vapi gets 401 | `VAPI_SERVER_SECRET` differs between the deployment and the assistant settings. |
| Emails fail with a domain error | `EMAIL_FROM` is not on a domain verified in Resend. |
| Admin login returns 500 `not_configured` | `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `AUTH_SECRET` not set. Auth fails closed by design. |
| First turn of a call is slow, later turns fine | The agent subprocess spawning. Expected; a paid plan that never idles reduces it. |
