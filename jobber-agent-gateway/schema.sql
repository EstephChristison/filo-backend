-- KGL Jobber Agent Gateway — D1 schema
-- Apply with: wrangler d1 execute kgl-jobber-agent --remote --file=schema.sql

-- Immutable prepared proposals (prepare/commit pattern).
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,               -- prop_<random>
  type TEXT NOT NULL,                -- request | quote | note
  payload_json TEXT NOT NULL,        -- exact validated payload, frozen at prepare time
  preview_text TEXT NOT NULL,        -- human preview shown for approval
  status TEXT NOT NULL DEFAULT 'prepared',  -- prepared | committed | expired | cancelled
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- 10 min customer-facing/financial, 30 min internal
  committed_at TEXT,
  jobber_id TEXT,                    -- Jobber record id after commit
  idempotency_key TEXT UNIQUE
);

-- Append-only audit log. No UPDATE or DELETE is ever issued against this table.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'Esteph via King''s Garden AI Agent',
  action TEXT NOT NULL,              -- e.g. clients.search, quotes.commit, auth.rejected
  object_type TEXT,
  object_id TEXT,
  proposal_id TEXT,
  before_json TEXT,
  after_json TEXT,
  approval_text TEXT,
  result TEXT NOT NULL,              -- ok | error | blocked
  error TEXT
);

-- Idempotency: repeated commit attempts return the original result.
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Design manifests (Phase 7 — used from stage two onward).
CREATE TABLE IF NOT EXISTS design_manifests (
  id TEXT PRIMARY KEY,               -- des_<random>
  client_id TEXT NOT NULL,
  request_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS design_revisions (
  manifest_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,       -- immutable once written
  approval_status TEXT NOT NULL DEFAULT 'draft',
  approval_text TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, revision)
);
