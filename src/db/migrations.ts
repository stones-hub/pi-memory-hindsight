/**
 * Embedded SQL migrations, applied in order and tracked via `PRAGMA user_version`.
 * Embedding SQL as string literals (rather than reading `.sql` files at
 * runtime) keeps the packaged tarball simple and avoids asset-copy build steps.
 */

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  anonymous_profile_id TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'zh')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (
    (scope = 'profile' AND memory_type IN ('preference', 'habit') AND project_identity IS NULL)
    OR
    (
      scope = 'project'
      AND memory_type IN ('project_fact', 'decision', 'lesson', 'task_state', 'inference')
      AND project_identity IS NOT NULL
      AND length(trim(project_identity)) > 0
    )
  ),
  memory_type TEXT NOT NULL,
  project_identity TEXT,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  unit_id TEXT,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'reconciling')),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_session_id TEXT,
  source_ref TEXT,
  supersedes_memory_id TEXT REFERENCES memories (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  UNIQUE (bank_id, document_id)
);

CREATE INDEX idx_memories_scope_status ON memories (scope, project_identity, status);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (
    (scope = 'profile' AND memory_type IN ('preference', 'habit') AND project_identity IS NULL)
    OR
    (
      scope = 'project'
      AND memory_type IN ('project_fact', 'decision', 'lesson', 'task_state', 'inference')
      AND project_identity IS NOT NULL
      AND length(trim(project_identity)) > 0
    )
  ),
  memory_type TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL CHECK (proposed_action IN ('create', 'update', 'supersede', 'ignore')),
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_candidates_state ON candidates (state, expires_at);

CREATE TABLE operations (
  idempotency_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories (id),
  action TEXT NOT NULL CHECK (action IN ('create', 'replace', 'delete')),
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  expected_text_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_progress', 'committed', 'failed', 'reconciling')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_operations_memory ON operations (memory_id);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'contradiction', 'cross_scope')),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN ('open', 'resolved_keep_existing', 'resolved_superseded', 'resolved_both_kept', 'dismissed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  memory_id TEXT,
  candidate_id TEXT,
  outcome TEXT NOT NULL,
  redacted_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('extraction')),
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE candidates RENAME TO candidates_v1;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (
    (scope = 'profile' AND memory_type IN ('preference', 'habit') AND project_identity IS NULL)
    OR
    (
      scope = 'project'
      AND memory_type IN ('project_fact', 'decision', 'lesson', 'task_state', 'inference')
      AND project_identity IS NOT NULL
      AND length(trim(project_identity)) > 0
    )
  ),
  memory_type TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL CHECK (proposed_action IN ('create', 'update', 'supersede', 'ignore')),
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'approving', 'approved', 'rejected', 'expired', 'failed', 'reconciling')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_memory_id TEXT REFERENCES memories (id),
  failure_code TEXT
);

INSERT INTO candidates (
  id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
  proposed_action, target_memory_id, project_identity, state, created_at, updated_at,
  expires_at, approved_memory_id, failure_code
)
SELECT
  id,
  scope,
  memory_type,
  text,
  evidence_summary,
  source_session_id,
  source_ref,
  proposed_action,
  target_memory_id,
  project_identity,
  CASE state
    WHEN 'pending' THEN 'pending'
    WHEN 'approved' THEN 'approved'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'expired' THEN 'expired'
  END,
  created_at,
  updated_at,
  expires_at,
  NULL,
  NULL
FROM candidates_v1;

ALTER TABLE conflicts RENAME TO conflicts_v1;
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'contradiction', 'cross_scope')),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN ('open', 'resolved_keep_existing', 'resolved_superseded', 'resolved_both_kept', 'dismissed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO conflicts (id, candidate_id, memory_id, kind, resolution_state, created_at, updated_at)
SELECT id, candidate_id, memory_id, kind, resolution_state, created_at, updated_at
FROM conflicts_v1;

DROP TABLE conflicts_v1;
DROP TABLE candidates_v1;
CREATE INDEX idx_candidates_state ON candidates (state, expires_at);
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE candidates ADD COLUMN expected_target_text_hash TEXT;
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE memories ADD COLUMN legacy_document_text_hash TEXT;
`,
  },
  {
    version: 5,
    sql: `
ALTER TABLE memories ADD COLUMN mutation_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN mutation_owner_key TEXT;
ALTER TABLE operations ADD COLUMN memory_generation INTEGER;
`,
  },
  {
    version: 6,
    sql: `
ALTER TABLE operations ADD COLUMN provider_mutation_issued INTEGER NOT NULL DEFAULT 0
  CHECK (provider_mutation_issued IN (0, 1));
ALTER TABLE memories ADD COLUMN mutation_progress_token TEXT;
`,
  },
  {
    version: 7,
    sql: `
ALTER TABLE memories RENAME TO memories_v6;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (
    (scope = 'profile' AND memory_type IN ('preference', 'habit') AND project_identity IS NULL)
    OR
    (
      scope = 'project'
      AND memory_type IN ('project_fact', 'decision', 'lesson', 'task_state', 'inference')
      AND project_identity IS NOT NULL
      AND length(trim(project_identity)) > 0
    )
  ),
  memory_type TEXT NOT NULL,
  project_identity TEXT,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  unit_id TEXT,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'reconciling', 'expired')),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_session_id TEXT,
  source_ref TEXT,
  supersedes_memory_id TEXT REFERENCES memories (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  legacy_document_text_hash TEXT,
  mutation_generation INTEGER NOT NULL DEFAULT 1,
  mutation_owner_key TEXT,
  mutation_progress_token TEXT,
  UNIQUE (bank_id, document_id)
);

INSERT INTO memories (
  id, scope, memory_type, project_identity, bank_id, document_id, unit_id,
  text_hash, text_length, status, verification_state, source_session_id, source_ref,
  supersedes_memory_id, created_at, updated_at, last_verified_at, expires_at,
  legacy_document_text_hash, mutation_generation, mutation_owner_key, mutation_progress_token
)
SELECT
  id, scope, memory_type, project_identity, bank_id, document_id, unit_id,
  text_hash, text_length, status, verification_state, source_session_id, source_ref,
  supersedes_memory_id, created_at, updated_at, last_verified_at, expires_at,
  legacy_document_text_hash, mutation_generation, mutation_owner_key, mutation_progress_token
FROM memories_v6;

ALTER TABLE operations RENAME TO operations_v6;
CREATE TABLE operations (
  idempotency_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories (id),
  action TEXT NOT NULL CHECK (action IN ('create', 'replace', 'delete')),
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  expected_text_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_progress', 'committed', 'failed', 'reconciling')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  memory_generation INTEGER,
  provider_mutation_issued INTEGER NOT NULL DEFAULT 0
    CHECK (provider_mutation_issued IN (0, 1))
);
INSERT INTO operations (
  idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
  state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
)
SELECT
  idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
  state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
FROM operations_v6;
DROP TABLE operations_v6;
CREATE INDEX idx_operations_memory ON operations (memory_id);

ALTER TABLE candidates RENAME TO candidates_v6;
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (
    (scope = 'profile' AND memory_type IN ('preference', 'habit') AND project_identity IS NULL)
    OR
    (
      scope = 'project'
      AND memory_type IN ('project_fact', 'decision', 'lesson', 'task_state', 'inference')
      AND project_identity IS NOT NULL
      AND length(trim(project_identity)) > 0
    )
  ),
  memory_type TEXT NOT NULL,
  text TEXT,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL CHECK (proposed_action IN ('create', 'update', 'supersede', 'ignore')),
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'approving', 'approved', 'rejected', 'expired', 'failed', 'reconciling')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_memory_id TEXT REFERENCES memories (id),
  failure_code TEXT,
  expected_target_text_hash TEXT,
  text_hash TEXT,
  body_purged_at TEXT
);
INSERT INTO candidates (
  id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
  proposed_action, target_memory_id, project_identity, state, created_at, updated_at,
  expires_at, approved_memory_id, failure_code, expected_target_text_hash, text_hash, body_purged_at
)
SELECT
  id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
  proposed_action, target_memory_id, project_identity, state, created_at, updated_at,
  expires_at, approved_memory_id, failure_code, expected_target_text_hash, NULL, NULL
FROM candidates_v6;
DROP TABLE candidates_v6;
CREATE INDEX idx_candidates_state ON candidates (state, expires_at);

ALTER TABLE conflicts RENAME TO conflicts_v6;
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'contradiction', 'cross_scope')),
  resolution_state TEXT NOT NULL CHECK (
    resolution_state IN ('open', 'resolved_keep_existing', 'resolved_superseded', 'resolved_both_kept', 'dismissed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO conflicts (id, candidate_id, memory_id, kind, resolution_state, created_at, updated_at)
SELECT id, candidate_id, memory_id, kind, resolution_state, created_at, updated_at
FROM conflicts_v6;
DROP TABLE conflicts_v6;

DROP TABLE memories_v6;
CREATE INDEX idx_memories_scope_status ON memories (scope, project_identity, status);
CREATE INDEX idx_memories_expires ON memories (status, expires_at);

CREATE TABLE maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  last_status_json TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO maintenance_state (id, last_success_at, lease_owner, lease_until, last_status_json, updated_at)
VALUES (1, NULL, NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`,
  },
];
