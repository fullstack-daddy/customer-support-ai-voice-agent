# Deploying

## Short answer on Vercel

Yes — with one real caveat you should decide on before you commit to it.

The Claude Agent SDK **spawns the MCP server as a child process**. That works on Vercel's Node.js serverless runtime, but not on Edge, and the subprocess is re-spawned on every cold start. For a demo that is fine. For a production voice line it adds latency to the first turn of a cold call, which is exactly the turn a caller notices.

| | Vercel | Persistent Node host (Render / Railway / Fly) |
| --- | --- | --- |
| Setup | Connect the repo, done | Dockerfile or buildpack |
| MCP subprocess | Re-spawned per cold start | Spawned once, reused |
| First-turn latency on a cold call | +2–5s | None |
| Cost at low volume | Free tier is enough | ~$5–7/month |
| Good for | Submission, demos, review | A real support line |

**Recommendation:** Vercel for the submission. If this ever takes real calls, move the backend to a persistent host.

---

## Vercel setup

### 1. Project settings

Import the repo, then in **Settings → General**:

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js |
| Root Directory | repo root **or** `apps/web` — both work |
| Build Command | `npm run build` |
| Output Directory | `apps/web/.next` |
| Install Command | `npm install` |
| Node.js Version | 20.x or later |

This is an npm-workspaces monorepo: the web app imports `@relaypay/shared`, `@relaypay/agent` and `@relaypay/mcp-server`, and those packages have to be **compiled** before Next can resolve them — their `exports` point at `dist/`, which does not exist in a fresh clone.

Vercel only runs the build script of the app it detects, so with Root Directory set to `apps/web` it ran `next build` alone and failed with `Module not found: Can't resolve '@relaypay/shared'`. The web package now has a `prebuild` hook that compiles the workspace packages first, so either Root Directory setting works.

`vercel.json` in the repo already sets the build commands and the 60-second `maxDuration` on the chat-completions route, so most of this is applied for you.

### 2. Environment variables

**Settings → Environment Variables.** Add every one of these to **Production** (and Preview, if you want preview deploys to work):

| Variable | Notes |
| --- | --- |
| `ANTHROPIC_API_KEY` | |
| `SUPABASE_URL` | Bare project URL, no `/rest/v1` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Never prefix with `NEXT_PUBLIC_`. |
| `SUPABASE_ANON_KEY` | Optional; currently unused |
| `AUTH_SECRET` | 32+ random chars. Changing it logs everyone out. |
| `ADMIN_EMAIL` | |
| `ADMIN_PASSWORD` | |
| `ADMIN_NAME` | Optional |
| `VAPI_SERVER_SECRET` | Must match the Vapi assistant's Server URL secret |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | Publishable; safe in the browser |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | Publishable |
| `RESEND_API_KEY` | |
| `EMAIL_FROM` | Must be on a **verified** Resend domain |
| `EMAIL_REPLY_TO` | Optional |
| `VOYAGE_API_KEY` *or* `OPENAI_API_KEY` | Optional; without either, retrieval uses Postgres full-text |
| `ALLOWED_ORIGINS` | Your deployed URL, e.g. `https://yourapp.vercel.app` |
| `APP_BASE_URL` | Same |

**`NEXT_PUBLIC_*` variables are baked in at build time.** Adding one after a deploy does nothing until you redeploy. If the call page says "Voice isn't configured" on a deployment where the variable is clearly set, this is almost always why — redeploy.

### 3. Point Vapi at the deployment

In the Vapi assistant:

- **Model → custom-llm URL:** `https://<your-app>.vercel.app/api/vapi` (not the full `/chat/completions` path — see [vapi-configuration.md](./vapi-configuration.md))
- **Server URL:** `https://<your-app>.vercel.app/api/vapi/end-of-call`
- **Server URL Secret:** the same string as `VAPI_SERVER_SECRET`

### 4. Build the workspace packages

The root `npm run build` already builds `shared` → `mcp-server` → `agent` → `web` in order. The agent resolves the MCP entrypoint relative to `process.cwd()`, which on Vercel is the repo root, so `packages/mcp-server/dist/index.js` resolves correctly. If you ever see "MCP server not found" in the logs, set `RELAYPAY_MCP_ENTRYPOINT` to the absolute path.

---

## Local development

Everything reads **one `.env` at the repo root**.

Next normally only auto-loads `.env` from its own directory (`apps/web`), which silently ignores a root `.env` in a monorepo. Every env-dependent npm script therefore runs through `scripts/with-env.mjs`, which loads the root `.env` into the environment *before* Next starts.

That ordering matters. Loading the file from `next.config.mjs` is not enough: Next restores its own snapshot of `process.env` after reading the config, so server-side values set there never reach a route handler — the admin login fails with `not_configured` while the value sits in the file — and edge middleware, which cannot read files at all, never sees them either. Only a variable that is already in the environment when Next boots reaches all three runtimes (node handlers, edge middleware, and `NEXT_PUBLIC_*` in the client bundle).

So: keep your `.env` at the top level, not inside `apps/web`, and start the app with `npm run dev` rather than calling `next` directly. Real environment variables always win over the file, which is why nothing changes on Vercel.

```bash
npm install
cp .env.example .env     # fill it in
npm run build            # workspace packages must be built before the agent can spawn the MCP server
npm run dev
```

### Exposing localhost to Vapi

Vapi needs a public URL to call:

```bash
npx ngrok http 3000
```

Then point the assistant's custom-llm URL at the ngrok address. It changes every restart on the free tier.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Voice isn't configured" despite the env being set | `NEXT_PUBLIC_*` is build-time. Redeploy (Vercel) or restart the dev server (local). Locally, also check the `.env` is at the **repo root**. |
| Build fails on `@relaypay/shared` not found | The workspace packages were not compiled. `apps/web`'s `prebuild` hook does this; if you changed the build command, make sure it still runs `npm run build:packages`. |
| Agent replies but calls no tools | Workspace packages not built. `npm run build`. |
| "WebRTC not supported or suppressed" when starting a call | The page is open on a plain-http address that is not loopback, e.g. `http://192.168.x.x:3000`. Browsers only expose the microphone in a secure context. Use `http://localhost:3000`, or serve over https. The app now detects this up front and says so instead of failing on click. |
| Vapi gets 401 | `VAPI_SERVER_SECRET` differs between the deployment and the assistant settings. |
| Emails fail with a domain error | `EMAIL_FROM` is not on a domain verified in Resend. |
| Admin login returns 500 `not_configured` | `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `AUTH_SECRET` not in the environment. Auth fails closed by design. Locally, check they are in the **root** `.env` and that you started with `npm run dev` (which runs `scripts/with-env.mjs`). |
| First turn of a call is slow, later turns fine | Cold start spawning the MCP subprocess. Expected on serverless; move to a persistent host if it matters. |
