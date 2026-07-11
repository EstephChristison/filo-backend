// ═══════════════════════════════════════════════════════════════════
// KGL Jobber Agent Gateway
// Narrow, authenticated gateway between the King's Garden AI Agent
// (private GPT) and the Jobber GraphQL API.
//
// Security model (from docs/jobber-ai-agent/*):
//  - ChatGPT authenticates with KGL_AGENT_API_KEY (bearer). It never
//    sees Jobber OAuth tokens — those live only in this Worker.
//  - Prohibited operations (delete, send quote, initiate payment, …)
//    have NO endpoint. Enforcement by omission, not instruction.
//  - Consequential writes use prepare -> approve -> commit. Commit
//    accepts a proposal_id only; the payload was frozen at prepare.
//  - Kill switches in KV: INTEGRATION_ENABLED, WRITES_ENABLED.
//  - Every write and consequential read is audited, append-only.
// ═══════════════════════════════════════════════════════════════════

const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const JOBBER_AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_GRAPHQL_VERSION = '2024-12-18';

// Proposal lifetimes per spec Q26: 10 min financial/customer-facing, 30 min internal.
const PROPOSAL_TTL_MIN = { quote: 10, request: 30, note: 30 };

// Strict allowed fields per proposal type (unknown fields are rejected).
const PREPARE_FIELDS = {
  request: ['client_id', 'title', 'description', 'source'],
  quote: ['client_id', 'property_id', 'title', 'line_items', 'message_internal'],
  note: ['client_id', 'body', 'pinned'],
};
const QUOTE_LINE_FIELDS = ['name', 'description', 'quantity', 'unit_price', 'taxable'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // ── Public routes (no bearer auth) ──────────────────────────
      if (path === '/v1/health' || path === '/status') return status(env);
      if (path === '/auth') return authRedirect(env, url);
      if (path === '/oauth/callback') return oauthCallback(env, url);

      // ── Everything else requires the agent key ──────────────────
      if (!(await checkAgentKey(request, env))) {
        await audit(env, { action: 'auth.rejected', result: 'blocked', error: path });
        return json({ error: 'unauthorized' }, 401);
      }
      if ((await env.CONTROL.get('INTEGRATION_ENABLED')) === 'false') {
        return json({ error: 'integration disabled by kill switch' }, 503);
      }

      // Reads
      if (path === '/v1/clients/search' && request.method === 'POST')
        return clientsSearch(env, await body(request));
      const brief = path.match(/^\/v1\/clients\/([^/]+)\/brief$/);
      if (brief && request.method === 'GET') return clientBrief(env, decodeURIComponent(brief[1]));
      if (path === '/v1/catalog/search' && request.method === 'POST')
        return catalogSearch(env, await body(request));

      // Prepare / commit
      const prep = path.match(/^\/v1\/(requests|quotes|notes)\/prepare$/);
      if (prep && request.method === 'POST')
        return prepare(env, prep[1].slice(0, -1), await body(request));
      const com = path.match(/^\/v1\/(requests|quotes|notes)\/commit$/);
      if (com && request.method === 'POST')
        return commit(env, com[1].slice(0, -1), await body(request));

      // No delete, send, payment, payroll, or credential routes exist. Ever.
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e.response) return e.response; // validation errors carry their own status
      await audit(env, { action: 'gateway.error', result: 'error', error: String(e) }).catch(() => {});
      return json({ error: 'internal error', detail: String(e.message || e) }, 500);
    }
  },
};

// ── Auth ─────────────────────────────────────────────────────────────
async function checkAgentKey(request, env) {
  const header = request.headers.get('Authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = env.KGL_AGENT_API_KEY || '';
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Jobber OAuth ─────────────────────────────────────────────────────
async function authRedirect(env, url) {
  const state = crypto.randomUUID();
  await env.CONTROL.put(`oauth_state:${state}`, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.JOBBER_CLIENT_ID,
    redirect_uri: env.JOBBER_REDIRECT_URI,
    response_type: 'code',
    state,
  });
  return Response.redirect(`${JOBBER_AUTHORIZE_URL}?${q}`, 302);
}

async function oauthCallback(env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !(await env.CONTROL.get(`oauth_state:${state}`)))
    return json({ error: 'invalid oauth state' }, 400);
  await env.CONTROL.delete(`oauth_state:${state}`);

  const res = await fetch(JOBBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
      redirect_uri: env.JOBBER_REDIRECT_URI,
    }),
  });
  if (!res.ok) return json({ error: `token exchange failed: ${res.status}` }, 502);
  const tok = await res.json();
  await storeTokens(env, tok);

  // Account pinning: record which Jobber account authorized us.
  const acct = await jobberGraphQL(env, `query { account { id name } }`);
  const accountId = acct?.account?.id || 'unknown';
  await env.CONTROL.put('jobber_account_id', accountId);
  if (env.JOBBER_ACCOUNT_ID && env.JOBBER_ACCOUNT_ID !== accountId) {
    await env.CONTROL.delete('jobber_tokens');
    await audit(env, { action: 'auth.account_mismatch', result: 'blocked', error: accountId });
    return json({ error: 'account mismatch — tokens discarded' }, 403);
  }
  await audit(env, { action: 'auth.authorized', result: 'ok', object_id: accountId });
  return json({ ok: true, account: acct?.account?.name, account_id: accountId,
    note: 'Set JOBBER_ACCOUNT_ID to this account_id in wrangler.toml to pin the gateway.' });
}

async function storeTokens(env, tok) {
  await env.CONTROL.put('jobber_tokens', JSON.stringify({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ? tok.expires_in * 1000 : 55 * 60 * 1000),
  }));
}

async function getAccessToken(env) {
  const raw = await env.CONTROL.get('jobber_tokens');
  if (!raw) throw new Error('Jobber not authorized — visit /auth once');
  let t = JSON.parse(raw);
  if (Date.now() > t.expires_at - 60_000) {
    const res = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: env.JOBBER_CLIENT_ID,
        client_secret: env.JOBBER_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`Jobber token refresh failed: ${res.status}`);
    const tok = await res.json();
    if (!tok.access_token) throw new Error('Jobber refresh response missing access_token');
    if (!tok.refresh_token) tok.refresh_token = t.refresh_token;
    await storeTokens(env, tok);
    t = JSON.parse(await env.CONTROL.get('jobber_tokens'));
  }
  return t.access_token;
}

async function jobberGraphQL(env, query, variables = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_GRAPHQL_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Jobber GraphQL HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Jobber GraphQL: ${data.errors[0].message}`);
  return data.data;
}

// ── Reads ────────────────────────────────────────────────────────────
// NOTE: field names below follow Jobber's public GraphQL schema as used by
// the existing FILO JobberAdapter. Validate against the live schema during
// the mock/test phase and adjust here — queries are intentionally kept in
// one place per operation.
async function clientsSearch(env, b) {
  requireFields(b, ['query'], ['query', 'limit']);
  const data = await jobberGraphQL(env, `
    query Search($term: String!, $first: Int!) {
      clients(searchTerm: $term, first: $first) {
        nodes { id name isCompany
          emails { address primary }
          phones { number primary }
          billingAddress { street city province postalCode }
        }
      }
    }`, { term: b.query, first: Math.min(b.limit || 10, 25) });
  await audit(env, { action: 'clients.search', result: 'ok', object_type: 'client' });
  return json({ results: data.clients?.nodes || [] });
}

async function clientBrief(env, id) {
  const data = await jobberGraphQL(env, `
    query Brief($id: EncodedId!) {
      client(id: $id) {
        id name isCompany
        emails { address primary } phones { number primary }
        billingAddress { street city province postalCode }
        properties { nodes { id address { street city province postalCode } } }
        quotes(first: 10) { nodes { id quoteNumber quoteStatus amounts { total } } }
        jobs(first: 10) { nodes { id jobNumber jobStatus } }
        invoices(first: 10) { nodes { id invoiceNumber invoiceStatus amounts { total invoiceBalance } } }
        notes(first: 5) { nodes { message createdAt } }
      }
    }`, { id });
  await audit(env, { action: 'clients.brief', result: 'ok', object_type: 'client', object_id: id });
  return json({ client: data.client, source: 'live-jobber', retrieved_at: new Date().toISOString() });
}

async function catalogSearch(env, b) {
  requireFields(b, ['query'], ['query', 'limit']);
  const data = await jobberGraphQL(env, `
    query Catalog($term: String!, $first: Int!) {
      productOrServices(searchTerm: $term, first: $first) {
        nodes { id name description category defaultUnitCost taxable }
      }
    }`, { term: b.query, first: Math.min(b.limit || 15, 50) });
  // Spec Q131/Q132: hide $0 "ghost" items and description-less items from recommendations.
  const all = data.productOrServices?.nodes || [];
  const eligible = all.filter((i) => i.defaultUnitCost > 0 && i.description);
  await audit(env, { action: 'catalog.search', result: 'ok' });
  return json({ results: eligible, hidden_ineligible_count: all.length - eligible.length });
}

// ── Prepare / commit ────────────────────────────────────────────────
async function prepare(env, type, b) {
  const allowed = PREPARE_FIELDS[type];
  requireFields(b, allowedRequired(type), allowed);
  if (type === 'quote') {
    if (!Array.isArray(b.line_items) || b.line_items.length === 0)
      return json({ error: 'quote requires line_items' }, 422);
    for (const li of b.line_items) requireFields(li, ['name', 'quantity', 'unit_price'], QUOTE_LINE_FIELDS);
    if (b.line_items.some((li) => !(li.unit_price > 0)))
      return json({ error: 'refused: $0 or negative line item (catalog-only pricing rule)' }, 422);
  }
  const id = `prop_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const now = new Date();
  const expires = new Date(now.getTime() + PROPOSAL_TTL_MIN[type] * 60_000);
  const preview = buildPreview(type, b);
  await env.DB.prepare(
    `INSERT INTO proposals (id, type, payload_json, preview_text, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, type, JSON.stringify(b), preview, now.toISOString(), expires.toISOString()).run();
  await audit(env, { action: `${type}s.prepare`, result: 'ok', proposal_id: id, after_json: JSON.stringify(b) });
  return json({
    proposal_id: id, type, preview,
    expires_at: expires.toISOString(),
    instruction: 'Show this preview to Esteph verbatim. Commit only after explicit approval, by calling the commit endpoint with proposal_id only.',
  });
}

async function commit(env, type, b) {
  requireFields(b, ['proposal_id', 'approval_text'], ['proposal_id', 'approval_text', 'idempotency_key']);
  if ((await env.CONTROL.get('WRITES_ENABLED')) !== 'true')
    return json({ error: 'writes disabled (shadow/draft mode or kill switch)' }, 403);

  // Idempotency: same key returns the original result.
  if (b.idempotency_key) {
    const dup = await env.DB.prepare('SELECT id, jobber_id, status FROM proposals WHERE idempotency_key = ?')
      .bind(b.idempotency_key).first();
    if (dup) return json({ proposal_id: dup.id, jobber_id: dup.jobber_id, status: dup.status, idempotent_replay: true });
  }

  const p = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(b.proposal_id).first();
  if (!p || p.type !== type) return json({ error: 'unknown proposal' }, 404);
  if (p.status === 'committed') return json({ proposal_id: p.id, jobber_id: p.jobber_id, status: 'committed', idempotent_replay: true });
  if (p.status !== 'prepared') return json({ error: `proposal is ${p.status}` }, 409);
  if (new Date(p.expires_at) < new Date())
    return json({ error: 'approval window expired — re-prepare and re-approve' }, 410);

  const payload = JSON.parse(p.payload_json); // committed exactly as frozen; b carries no payload
  const jobberId = await executeWrite(env, type, payload);

  await env.DB.prepare(
    `UPDATE proposals SET status='committed', committed_at=?, jobber_id=?, idempotency_key=? WHERE id=? AND status='prepared'`
  ).bind(new Date().toISOString(), jobberId, b.idempotency_key || p.id, p.id).run();
  await audit(env, {
    action: `${type}s.commit`, result: 'ok', proposal_id: p.id,
    object_type: type, object_id: jobberId,
    before_json: p.payload_json, approval_text: b.approval_text,
  });
  return json({ proposal_id: p.id, jobber_id: jobberId, status: 'committed' });
}

async function executeWrite(env, type, p) {
  if (type === 'note') {
    const data = await jobberGraphQL(env, `
      mutation Note($clientId: EncodedId!, $message: String!) {
        clientCreateNote(clientId: $clientId, input: { message: $message }) {
          clientNote { id } userErrors { message }
        }
      }`, { clientId: p.client_id, message: p.body });
    return firstId(data, 'clientCreateNote', 'clientNote');
  }
  if (type === 'request') {
    const data = await jobberGraphQL(env, `
      mutation Req($input: RequestCreateInput!) {
        requestCreate(input: $input) { request { id } userErrors { message } }
      }`, { input: { clientId: p.client_id, title: p.title, companyName: undefined, source: p.source, note: p.description } });
    return firstId(data, 'requestCreate', 'request');
  }
  if (type === 'quote') {
    const data = await jobberGraphQL(env, `
      mutation Quote($input: QuoteCreateInput!) {
        quoteCreate(input: $input) { quote { id quoteNumber } userErrors { message } }
      }`, {
      input: {
        clientId: p.client_id,
        propertyId: p.property_id,
        title: p.title,
        lineItems: p.line_items.map((li) => ({
          name: li.name, description: li.description || undefined,
          quantity: li.quantity, unitPrice: li.unit_price, taxable: li.taxable !== false,
        })),
      },
    });
    return firstId(data, 'quoteCreate', 'quote');
  }
  throw new Error(`no write handler for ${type}`);
}

function firstId(data, mutation, node) {
  const m = data?.[mutation];
  if (m?.userErrors?.length) throw new Error(`Jobber rejected: ${m.userErrors[0].message}`);
  const id = m?.[node]?.id;
  if (!id) throw new Error(`Jobber returned no ${node} id`);
  return id;
}

// ── Helpers ──────────────────────────────────────────────────────────
async function body(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(422, 'request body must be valid JSON');
  }
}

function allowedRequired(type) {
  return { request: ['client_id', 'title'], quote: ['client_id', 'title', 'line_items'], note: ['client_id', 'body'] }[type];
}

function requireFields(obj, required, allowed) {
  if (!obj || typeof obj !== 'object') throw httpError(422, 'body must be a JSON object');
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) throw httpError(422, `unknown field rejected: ${k}`);
  for (const k of required)
    if (obj[k] === undefined || obj[k] === null || obj[k] === '')
      throw httpError(422, `missing required field: ${k}`);
}

function buildPreview(type, b) {
  if (type === 'quote') {
    const total = b.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
    const lines = b.line_items.map((li) => `  • ${li.name} × ${li.quantity} @ $${li.unit_price.toFixed(2)}`).join('\n');
    return `DRAFT QUOTE for client ${b.client_id}\n${b.title}\n${lines}\nSubtotal: $${total.toFixed(2)} (plus applicable tax)\nApproval window: 10 minutes.`;
  }
  if (type === 'request') return `NEW REQUEST for client ${b.client_id}\nTitle: ${b.title}\nSource: ${b.source || 'n/a'}\n${b.description || ''}\nApproval window: 30 minutes.`;
  return `INTERNAL NOTE for client ${b.client_id}\n${b.body}\nApproval window: 30 minutes.`;
}

async function status(env) {
  const authorized = !!(await env.CONTROL.get('jobber_tokens'));
  return json({
    service: 'kgl-jobber-agent-gateway',
    jobber_authorized: authorized,
    account_id: (await env.CONTROL.get('jobber_account_id')) || null,
    integration_enabled: (await env.CONTROL.get('INTEGRATION_ENABLED')) !== 'false',
    writes_enabled: (await env.CONTROL.get('WRITES_ENABLED')) === 'true',
  });
}

async function audit(env, e) {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, action, object_type, object_id, proposal_id, before_json, after_json, approval_text, result, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(new Date().toISOString(), e.action, e.object_type || null, e.object_id || null,
    e.proposal_id || null, e.before_json || null, e.after_json || null,
    e.approval_text || null, e.result, e.error || null).run();
}

function json(obj, code = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: code, headers: { 'Content-Type': 'application/json' },
  });
}

function httpError(code, message) {
  const e = new Error(message);
  e.response = json({ error: message }, code);
  return e;
}
