# KGL Jobber AI Agent — Master Build Runbook

The 14-phase execution plan for building the King's Garden AI Agent, from
secret rotation through staged rollout. Governed by `discovery-answers.md`
(policy) and `implementation-answers.md` (build decisions).

**Execution ownership.** Every step is tagged:

- **[ESTEPH]** — requires your logins (Jobber Developer Center, Cloudflare
  dashboard, ChatGPT GPT builder, your Mac's filesystem). No AI session has
  these credentials, and none should.
- **[CLAUDE]** — code, schemas, and configuration I write once the source
  is reachable (via GitHub repo or Cloudflare access approval).
- **[BOTH]** — I produce the artifact; you review and execute it.

---

## Phase 1 — Replace the exposed Jobber client secret [ESTEPH]

A Jobber-related secret value was pasted into an AI chat and is permanently
retired. Assume compromise; rotate.

1. Sign in to the Jobber Developer Center.
2. Open the app behind the existing integration → OAuth credentials.
3. Rotate/regenerate the client secret.
4. Store the new value only in a password manager, then Cloudflare (Phase 2).
5. Never paste any secret into any chat, code, GitHub, GPT instructions, or
   uploaded file — this applies to every phase below.

## Phase 2 — Put the new Jobber secret into Cloudflare [ESTEPH]

1. Cloudflare dashboard → Workers & Pages → the Jobber middleware Worker
   (`jobber-api` or equivalent) → Settings → Variables and Secrets.
2. Update the client-secret variable (likely `JOBBER_CLIENT_SECRET`) as type
   **Secret**, not plain text. Save and deploy.
3. Confirm `JOBBER_CLIENT_ID` and the redirect-URI variable exist and match
   what the source code reads — verify names against the code, don't guess.

## Phase 3 — Reauthorize Jobber [ESTEPH]

1. Open the Worker's `/status` endpoint; look for a healthy/authenticated
   response.
2. If unauthorized/expired: open the Worker's `/auth` route, sign in to
   Jobber, select the King's Garden account, approve, confirm `/status`
   is healthy afterward.

## Phase 4 — Secure the existing jobber-api Worker [BOTH]

Do **not** connect ChatGPT to the Worker while it has no auth gate.

1. **[ESTEPH]** Generate an internal service key (`openssl rand -hex 32`)
   and store it as Worker secret `JOBBER_INTERNAL_API_KEY`.
2. **[CLAUDE]** Write the middleware requiring
   `Authorization: Bearer <JOBBER_INTERNAL_API_KEY>` on all routes except
   `/status`, `/auth`, `/oauth/callback`; wrong/missing → `401`.
3. **[CLAUDE]** Add the account restriction: every operation verified
   against the KGL Jobber account ID; other accounts fail even with a
   valid key.
4. **[ESTEPH]** Review, deploy, and test: `/status` works; protected route
   without key → 401; with key → succeeds; token refresh still works; no
   secret or internal cost appears in any response or log.

## Phase 5 — Get both codebases reviewable [ESTEPH]

1. `jobber-api`: confirm/create a **private** GitHub repo excluding
   `.env`, `.env.*`, `.dev.vars`, `*.secrets`, `.wrangler/`, `node_modules/`.
2. `jobber-mcp`: same. Before the first push: add the `.gitignore`, run
   `find` for secret files, `git status`, and inspect
   `git diff --cached --name-only` — push only after confirming no secret
   values are staged.
3. Grant this session access to both repos (name them; they get added via
   `add_repo`).

> Alternative that skips the Mac entirely: approve the Cloudflare MCP tool
> calls in this session — `workers_get_worker_code` can pull the deployed
> `jobber-api` source directly from Cloudflare.

## Phase 6 — Build the dedicated ChatGPT gateway [CLAUDE, Esteph reviews]

New private repo: `kgl-jobber-agent-gateway`. Architecture:

    Private GPT → KGL Jobber Agent Gateway → secured jobber-api → Jobber OAuth/GraphQL

**Read endpoints (first):**
`POST /v1/clients/search`, `GET /v1/clients/{id}/brief`,
`POST /v1/catalog/search`, `GET /v1/requests/{id}`, `GET /v1/quotes/{id}`,
`GET /v1/jobs/{id}`, `GET /v1/invoices/{id}`, `GET /v1/control-tower`

**Controlled write endpoints (second):** prepare/commit pairs for requests,
designs (+ `/designs/{id}/approve`), quotes, notes; plus
`POST /v1/renderings/{id}/upload`. No generic GraphQL endpoint, ever.

**Permanently omitted (no endpoint exists):** all deletes, send quote,
charge/initiate/refund payment, payroll, vendor/insurer/attorney contact,
credential changes. Customer sending never shares a route with creation
or upload.

**Prepare-and-commit contract:** prepare validates and stores an immutable
proposal → returns `proposal_id` + preview → Esteph approves that exact
preview → commit accepts `proposal_id` **only** (no revised prices,
quantities, recipients, or scope) → gateway commits the locked proposal,
verifies the Jobber result, returns the Jobber link.

**Safety controls:** dedicated ChatGPT API key; account-ID allowlist;
unknown-field rejection; separate read/write rate limits; idempotency key
on every write; duplicate detection; append-only audit log with
before/after snapshots and approval text + timestamp; emergency write kill
switch; read-only fallback mode; 3 transient retries with backoff (same
idempotency key); verification after unknown outcomes; no secrets in logs;
no raw Jobber tokens returned; minimum customer data returned.

## Phase 7 — Gateway storage [CLAUDE defines, ESTEPH provisions or approves MCP calls]

- **D1:** design manifests + immutable revisions, prepared proposals,
  approvals, idempotency records, audit events, retry/exception queues,
  current-version pointers.
- **R2:** source photos, preliminary + approved renderings, annotated proof
  images, manifest JSON, submittal PDFs, raw transcripts kept out of Jobber.
- **KV:** operational flags only — `WRITES_ENABLED`, `INTEGRATION_ENABLED`,
  `ACTIVE_GATEWAY_KEY_VERSION` — plus the env-level master disable as the
  second shutdown layer.

## Phase 8 — ChatGPT gateway API key [ESTEPH]

Two distinct keys, neither is the Jobber client secret:

- `KGL_AGENT_API_KEY` — ChatGPT → gateway. Generate locally
  (`openssl rand -hex 32`), store as a gateway Worker secret and in the GPT
  Action auth screen only.
- `JOBBER_INTERNAL_API_KEY` — gateway → jobber-api. Same value on both
  Workers, stored as secrets on both.

## Phase 9 — Deploy and test the gateway [ESTEPH deploys, CLAUDE writes tests]

Custom domain: `agent-jobber.kingsgardenlandscaping.com`.
Manual test order: health → auth rejection → client search → client brief →
catalog search → request prepare → request commit (internal test record) →
design manifest → rendering upload → draft quote prepare → draft quote
commit → audit log verification. **No customer sends in this phase.**

## Phase 10 — Create the private GPT [ESTEPH]

ChatGPT web → Explore GPTs → Create. Name: **King's Garden AI Agent**.
Instructions contain only sanitized rules (catalog-only pricing, suppliers,
manifest rules, tax/deposit, approval behavior, no-deletion, customer-send
rule, audit requirements, style, live-Jobber-wins) — never the full master
context, never customer data. Enable image generation + Actions (+ Code
Interpreter if useful). Actions and Apps are mutually exclusive — use
Actions.

## Phase 11 — Add the OpenAPI Action [BOTH]

1. **[CLAUDE]** Produce the gateway's OpenAPI schema, server URL
   `https://agent-jobber.kingsgardenlandscaping.com`, with
   `x-openai-isConsequential: true` on every commit/upload/send-class
   operation (client creation, request commit, assessment scheduling,
   rendering upload, quote commit, job creation, visit scheduling, invoice
   commit, payment recording, invoice sending). Reads and prepares are not
   consequential.
2. **[ESTEPH]** Paste schema into the GPT Action, set auth to API Key /
   Bearer, paste `KGL_AGENT_API_KEY` — never the Jobber client secret,
   access/refresh tokens, or `JOBBER_INTERNAL_API_KEY`.

## Phase 12 — Customer sending stays separated [design invariant]

The GPT may retrieve, prepare, render, package, attach internally, and
draft. It may not send anything because it created or uploaded it. The send
sequence is always: Esteph requests the send → agent retrieves live
recipient details → shows exact document/recipients/channel/message →
Esteph approves that exact preview → agent sends only that item → verifies
and audits. Upload ≠ send.

## Phase 13 — Shadow-mode testing [ESTEPH drives, CLAUDE reviews results]

Read-only prompts against the internal test client ("King's Garden AI Agent
Test") and Esteph's own property (10003 Briar Forest Drive), then the full
design workflow test ("Design and quote the front yard at 10003 Briar
Forest Drive") — expecting the complete 15-step pipeline with **zero Jobber
writes before approval**, then the approved internal batch test (reply
"Approve." to the preview) — expecting the 8 internal actions and **no
customer send**.

## Phase 14 — Staged rollout [ESTEPH gates each stage]

1. **Shadow mode** — 2 weeks, proposals only, compared against manual
   actions; <2 corrections/week to advance.
2. **Draft-only writes** — notes, tasks, manifests, rendering uploads,
   draft requests/quotes/invoices. Sending and money records disabled.
3. **Approved internal writes** — preview-bound commits for clients,
   requests, assessments, jobs, visits, draft invoices, status changes,
   payment recording. Payment initiation remains impossible.
4. **Invoice sending last** — full preview (customer, property, invoice #,
   total, balance, email, mobile, exact message, channels) + specific
   approval. Quotes remain manually sent unless policy is deliberately
   revised later.

## Standing prohibitions (all phases)

No secrets in chat/GitHub/GPT instructions. No Jobber client secret or
OAuth tokens in GPT Action auth. No GPT connection to the unauthenticated
Worker. No raw GraphQL to the GPT. Upload is not delivery. No disputed or
high-risk customer as a first test. No payment testing before search,
catalog, and drafting are stable.
