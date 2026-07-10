# Gateway Setup — Esteph's Checklist

Everything in this folder is ready to deploy. These are the steps only you
can do (they need your Cloudflare, Jobber, and ChatGPT logins). Rough time:
30–45 minutes.

## 0. Prerequisites (one time)

```bash
# On your Mac — anywhere:
npm install -g wrangler
wrangler login          # opens browser, sign in to Cloudflare
```

Copy this `jobber-agent-gateway/` folder somewhere on your Mac (or clone
the filo-backend branch).

## 1. Rotate the exposed key (do this first, independent of everything)

A secret value was pasted into an AI chat earlier. In the **Jobber
Developer Center**, rotate the client secret of your OAuth app. Keep the
new value in a password manager only.

## 2. Create the Cloudflare resources

```bash
cd jobber-agent-gateway

wrangler d1 create kgl-jobber-agent
# → copy the database_id it prints into wrangler.toml

wrangler kv namespace create CONTROL
# → copy the id it prints into wrangler.toml

wrangler r2 bucket create kgl-jobber-agent-files

wrangler d1 execute kgl-jobber-agent --remote --file=schema.sql
```

## 3. Set the secrets (typed into hidden prompts — never into chat)

```bash
# Generate the ChatGPT->gateway key; keep the output visible for step 7:
openssl rand -hex 32

wrangler secret put KGL_AGENT_API_KEY      # paste the value you just generated
wrangler secret put JOBBER_CLIENT_ID       # from Jobber Developer Center
wrangler secret put JOBBER_CLIENT_SECRET   # the NEW rotated secret from step 1
```

## 4. Redirect URI + deploy

In the Jobber Developer Center, set your app's redirect URI to:
`https://agent-jobber.kingsgardenlandscaping.com/oauth/callback`
(or, before the custom domain exists, the workers.dev URL wrangler prints —
update `JOBBER_REDIRECT_URI` in wrangler.toml to match, then redeploy).

```bash
wrangler deploy
```

Attach the custom domain in the Cloudflare dashboard (Worker → Settings →
Domains & Routes) when ready.

## 5. Authorize Jobber (once)

1. Open `https://<your-worker-url>/auth` in your browser.
2. Sign in to Jobber, pick the King's Garden account, approve.
3. The callback page shows your `account_id`. Put it in `wrangler.toml` as
   `JOBBER_ACCOUNT_ID` and `wrangler deploy` again — this pins the gateway
   to the KGL account forever.
4. Check `https://<your-worker-url>/status` → `jobber_authorized: true`.

## 6. Set the operating mode (shadow mode first)

```bash
# Shadow/read-only to start — writes stay off:
wrangler kv key put --binding=CONTROL INTEGRATION_ENABLED true --remote
wrangler kv key put --binding=CONTROL WRITES_ENABLED false --remote
```

`WRITES_ENABLED=false` is also your **kill switch** — commits return 403
instantly whenever it's false.

## 7. Create the Custom GPT

1. ChatGPT (desktop web) → Explore GPTs → **Create** → Configure.
2. Name: **King's Garden AI Agent**.
3. Instructions: paste the contents of `gpt/instructions.md` (below the line).
4. Capabilities: enable **Image generation** and **Code Interpreter**.
   Do not enable Apps.
5. Actions → **Create new action** → paste `gpt/openapi.yaml`.
   Fix the server URL if you're still on workers.dev.
6. Action Authentication → **API Key** → **Bearer** → paste the
   `KGL_AGENT_API_KEY` value from step 3. Nothing else ever goes in this
   field — not the Jobber client secret, not any OAuth token.
7. Save the GPT as **Only me**.

## 8. Smoke test (in the GPT)

- "Check the gateway health." → should show `jobber_authorized: true`.
- "Find client <a real client name>." → live results.
- "Search the catalog for 15-gallon shrubs." → eligible items only.
- "Prepare an internal note for that client saying 'gateway test'." →
  preview + proposal_id appears.
- Reply "Approve." → should be **refused with 403** (writes are off —
  correct shadow-mode behavior).

Direct API checks, if you prefer curl:

```bash
curl https://<worker-url>/v1/health                       # 200, no auth needed
curl https://<worker-url>/v1/clients/search -X POST \
  -H 'Content-Type: application/json' -d '{"query":"test"}'   # 401 — auth gate works
```

## 9. Rollout stages (flip when each stage is earned)

| Stage | Setting | Gate to advance |
|---|---|---|
| 1. Shadow (now) | `WRITES_ENABLED=false` | 2 weeks, <2 corrections/week |
| 2. Draft writes | `WRITES_ENABLED=true` | notes/requests/draft quotes only (that's all that exists in V1) |
| 3+. More endpoints | new code | payment recording, invoices, scheduling — built after stage 2 proves out |

## Known follow-ups (tracked, not blockers)

- The GraphQL field names in `src/index.js` follow Jobber's public schema
  as used by the existing FILO adapter; expect to adjust 1–2 field names
  against the live schema on first test — each operation's query lives in
  one labeled place.
- The old `jobber-api` Worker still needs its auth gate (build runbook
  Phase 4) — this gateway doesn't depend on it, but don't leave it open.
- Invoice, payment-recording, scheduling, control-tower, and design-manifest
  endpoints are stage-2+ work in the build runbook.
