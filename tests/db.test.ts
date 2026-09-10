import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditRepository, UsageRepository } from "../src/db/audit-conflicts-usage-repository.js";
import { CandidatesRepository } from "../src/db/candidates-repository.js";
import { MemoryDatabase } from "../src/db/database.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import {
  candidateExpiryFrom,
  defaultVerificationState,
  memoryExpiryFrom,
} from "../src/db/lifecycle.js";
import { MemoriesRepository } from "../src/db/memories-repository.js";
import { OperationsRepository } from "../src/db/operations-repository.js";
import { ProfileRepository } from "../src/db/profile-repository.js";

const tempDirs: string[] = [];
const V6_TEXT_HASH = "a".repeat(64);

async function seedPopulatedV6Database(dir: string, corrupt: boolean): Promise<void> {
  const file = path.join(dir, "memory", "pi-memory-hindsight.db");
  await mkdir(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 6).sort((a, b) => a.version - b.version)) {
    raw.exec(migration.sql);
    raw.exec(`PRAGMA user_version = ${migration.version}`);
  }
  raw.exec(`
    INSERT INTO profile VALUES (1, 'p-v6', 'en', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO memories (
      id, scope, memory_type, project_identity, bank_id, document_id, unit_id,
      text_hash, text_length, status, verification_state, source_session_id, source_ref,
      supersedes_memory_id, created_at, updated_at, last_verified_at, expires_at,
      legacy_document_text_hash, mutation_generation, mutation_owner_key, mutation_progress_token
    ) VALUES (
      'm-v6', 'profile', 'preference', NULL, 'bank-v6', 'doc-v6', 'unit',
      '${V6_TEXT_HASH}', 4, 'active', 'verified', NULL, NULL, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
      NULL, 1, NULL, NULL
    );
  `);
  if (corrupt) {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      INSERT INTO operations (
        idempotency_key, memory_id, action, bank_id, document_id, expected_text_hash,
        state, attempt_count, created_at, updated_at, memory_generation, provider_mutation_issued
      ) VALUES (
        'orphan:delete', 'missing-memory', 'delete', 'bank-v6', 'doc-v6', '${V6_TEXT_HASH}',
        'committed', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0
      );
    `);
    raw.exec("PRAGMA foreign_keys = ON");
  }
  raw.close();
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  delete process.env.LANG;
});

describe("database and repositories", () => {
  it("opens and configures the database with migrations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-db-"));
    tempDirs.push(dir);
    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const foreignKeys = opened.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const busyTimeout = opened.db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    const userVersion = opened.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(busyTimeout.timeout).toBe(5000);
    expect(userVersion.user_version).toBe(7);

    const memoryColumns = (
      opened.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(memoryColumns).not.toContain("text");
    const profileSql = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile'")
      .get() as { sql: string };
    const candidateSql = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidates'")
      .get() as { sql: string };
    const memorySql = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get() as { sql: string };
    expect(profileSql.sql).toContain("language IN ('en', 'zh')");
    expect(candidateSql.sql).toContain("project_identity IS NULL");
    expect(memorySql.sql).toContain("project_identity IS NOT NULL");
    expect(memorySql.sql).toContain("supersedes_memory_id TEXT REFERENCES memories (id)");
    opened.db.close();
  });

  it("safely migrates a populated v1 database with candidate conflict references through v5", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v1-"));
    tempDirs.push(dir);
    const file = path.join(dir, "memory", "pi-memory-hindsight.db");
    await mkdir(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  anonymous_profile_id TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'zh')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  project_identity TEXT,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  unit_id TEXT,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  source_session_id TEXT,
  source_ref TEXT,
  supersedes_memory_id TEXT REFERENCES memories (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  UNIQUE (bank_id, document_id)
);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL,
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE operations (
  idempotency_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories (id),
  action TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  expected_text_hash TEXT,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
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
  purpose TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 1;
`);
    raw.exec(`
INSERT INTO profile VALUES (1, 'p1', 'en', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO memories VALUES ('m1', 'profile', 'preference', NULL, 'bank', 'doc', 'unit', 'hash', 4, 'active', 'verified', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
INSERT INTO candidates VALUES ('c1', 'profile', 'preference', 'pending body', 'e1', NULL, NULL, 'create', NULL, NULL, 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
INSERT INTO candidates VALUES ('c2', 'profile', 'preference', 'approved body', 'e2', NULL, NULL, 'create', NULL, NULL, 'approved', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
INSERT INTO conflicts VALUES ('x1', 'c1', 'm1', 'duplicate', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`);
    raw.close();

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const userVersion = opened.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(userVersion.user_version).toBe(7);
    expect(opened.db.prepare("SELECT state FROM candidates WHERE id = 'c1'").get()).toEqual({ state: "pending" });
    expect(opened.db.prepare("SELECT state FROM candidates WHERE id = 'c2'").get()).toEqual({ state: "approved" });
    expect(opened.db.prepare("SELECT candidate_id FROM conflicts WHERE id = 'x1'").get()).toEqual({ candidate_id: "c1" });
    expect(opened.db.prepare("SELECT expected_target_text_hash FROM candidates WHERE id = 'c1'").get()).toEqual({
      expected_target_text_hash: null,
    });
    expect(opened.db.prepare("SELECT legacy_document_text_hash FROM memories WHERE id = 'm1'").get()).toEqual({
      legacy_document_text_hash: null,
    });
    expect(opened.db.prepare("SELECT mutation_generation, mutation_owner_key, mutation_progress_token FROM memories WHERE id = 'm1'").get()).toEqual({
      mutation_generation: 1,
      mutation_owner_key: null,
      mutation_progress_token: null,
    });
    expect(opened.db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "provider_mutation_issued" })]),
    );
    expect(opened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const approvedCandidate = opened.db
      .prepare("SELECT text, body_purged_at, text_hash FROM candidates WHERE id = 'c2'")
      .get() as { text: string | null; body_purged_at: string | null; text_hash: string | null };
    expect(approvedCandidate.text).toBeNull();
    expect(approvedCandidate.body_purged_at).toBeTruthy();
    expect(approvedCandidate.text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.db.prepare("SELECT text FROM candidates WHERE id = 'c1'").get()).toEqual({ text: "pending body" });
    expect(
      (opened.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql: string }).sql,
    ).toContain("'expired'");
    expect(opened.db.prepare("SELECT id FROM maintenance_state WHERE id = 1").get()).toEqual({ id: 1 });
    opened.db.close();
  });

  it("purges all legacy terminal candidate bodies on open in bounded chunks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v1-bulk-purge-"));
    tempDirs.push(dir);
    const file = path.join(dir, "memory", "pi-memory-hindsight.db");
    await mkdir(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(MIGRATIONS[0]!.sql);
    raw.exec("PRAGMA user_version = 1");
    raw.exec(`
      INSERT INTO profile VALUES (1, 'p-bulk', 'en', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO memories VALUES (
        'm-bulk', 'profile', 'preference', NULL, 'bank', 'doc', 'unit', 'hash', 4, 'active', 'verified',
        NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
    `);
    const insert = raw.prepare(`
      INSERT INTO candidates (
        id, scope, memory_type, text, evidence_summary, source_session_id, source_ref,
        proposed_action, target_memory_id, project_identity, state, created_at, updated_at, expires_at
      ) VALUES (?, 'profile', 'preference', ?, NULL, NULL, NULL, 'create', NULL, NULL, 'approved', ?, ?, ?)
    `);
    for (let i = 0; i < 550; i++) {
      insert.run(
        `c-bulk-${i}`,
        `approved body ${i}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );
    }
    insert.run(
      "c-pending",
      "pending body",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
    raw.exec("UPDATE candidates SET state='pending' WHERE id='c-pending'");
    raw.close();

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(
      opened.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE text IS NOT NULL AND state='approved'").get(),
    ).toEqual({ n: 0 });
    expect(opened.db.prepare("SELECT text FROM candidates WHERE id='c-pending'").get()).toEqual({ text: "pending body" });
    opened.db.close();
  });

  it("migrates a populated v2 database through v5 and preserves rows while leaving legacy target snapshots null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v2-"));
    tempDirs.push(dir);
    const file = path.join(dir, "memory", "pi-memory-hindsight.db");
    await mkdir(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  anonymous_profile_id TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'zh')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  project_identity TEXT,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  unit_id TEXT,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  source_session_id TEXT,
  source_ref TEXT,
  supersedes_memory_id TEXT REFERENCES memories (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  UNIQUE (bank_id, document_id)
);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL,
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_memory_id TEXT REFERENCES memories (id),
  failure_code TEXT
);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE operations (
  idempotency_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories (id),
  action TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  expected_text_hash TEXT,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
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
  purpose TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 2;
`);
    raw.exec(`
INSERT INTO profile VALUES (1, 'p2', 'en', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO memories VALUES ('m2', 'profile', 'preference', NULL, 'bank', 'doc2', 'unit', '${"a".repeat(64)}', 4, 'active', 'verified', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
INSERT INTO candidates VALUES ('c-update', 'profile', 'preference', 'legacy update body', NULL, NULL, NULL, 'update', 'm2', NULL, 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NULL, NULL);
`);
    raw.close();

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const userVersion = opened.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(userVersion.user_version).toBe(7);
    const migrated = opened.db
      .prepare("SELECT target_memory_id, expected_target_text_hash, state FROM candidates WHERE id = 'c-update'")
      .get() as { target_memory_id: string; expected_target_text_hash: string | null; state: string };
    expect(migrated).toEqual({
      target_memory_id: "m2",
      expected_target_text_hash: null,
      state: "pending",
    });
    expect(opened.db.prepare("SELECT id FROM memories WHERE id = 'm2'").get()).toEqual({ id: "m2" });
    expect(opened.db.prepare("SELECT legacy_document_text_hash FROM memories WHERE id = 'm2'").get()).toEqual({
      legacy_document_text_hash: null,
    });
    opened.db.close();
  });

  it("backfills legacy_document_text_hash for populated v2 rows whose document recomputes from text hash", async () => {
    const { createHash } = await import("node:crypto");
    const { buildLegacyOwnedDocumentId } = await import("../src/provider/validation.js");
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v2-legacy-doc-"));
    tempDirs.push(dir);
    const file = path.join(dir, "memory", "pi-memory-hindsight.db");
    await mkdir(path.dirname(file), { recursive: true });
    const text = "Legacy preference text.";
    const textHash = createHash("sha256").update(text).digest("hex");
    const documentId = buildLegacyOwnedDocumentId("profile", null, textHash);
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  anonymous_profile_id TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'zh')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  project_identity TEXT,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  unit_id TEXT,
  text_hash TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  source_session_id TEXT,
  source_ref TEXT,
  supersedes_memory_id TEXT REFERENCES memories (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  expires_at TEXT,
  UNIQUE (bank_id, document_id)
);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_summary TEXT,
  source_session_id TEXT,
  source_ref TEXT,
  proposed_action TEXT NOT NULL,
  target_memory_id TEXT REFERENCES memories (id),
  project_identity TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_memory_id TEXT REFERENCES memories (id),
  failure_code TEXT
);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates (id),
  memory_id TEXT REFERENCES memories (id),
  kind TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE operations (
  idempotency_key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories (id),
  action TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  expected_text_hash TEXT,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
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
  purpose TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 2;
`);
    raw.exec(`
INSERT INTO profile VALUES (1, 'p-legacy', 'en', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`);
    raw
      .prepare(
        `INSERT INTO memories VALUES (?, 'profile', 'preference', NULL, 'pi-memory-hindsight:profile:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 'unit', ?, ?, 'active', 'verified', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run("legacy-m1", documentId, textHash, text.length);
    raw.close();

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((opened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    expect(
      opened.db.prepare("SELECT legacy_document_text_hash, document_id, mutation_generation, mutation_owner_key FROM memories WHERE id = 'legacy-m1'").get(),
    ).toEqual({
      legacy_document_text_hash: textHash,
      document_id: documentId,
      mutation_generation: 1,
      mutation_owner_key: null,
    });
    opened.db.close();
  });

  it("creates a stable profile id and persists language", async () => {
    process.env.LANG = "zh_CN.UTF-8";
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-profile-"));
    tempDirs.push(dir);
    const opened1 = await MemoryDatabase.open(dir);
    if (!opened1.ok) throw new Error(opened1.reason);
    const profiles1 = new ProfileRepository(opened1.db);
    const first = profiles1.getOrCreate();
    expect(first.language).toBe("zh");
    profiles1.setLanguage("en");
    opened1.db.close();

    const opened2 = await MemoryDatabase.open(dir);
    if (!opened2.ok) throw new Error(opened2.reason);
    const profiles2 = new ProfileRepository(opened2.db);
    const second = profiles2.getOrCreate();
    expect(second.anonymous_profile_id).toBe(first.anonymous_profile_id);
    expect(second.language).toBe("en");
    expect(() => profiles2.setLanguage("fr")).toThrow(/unsupported language/);
    expect(() =>
      opened2.db.exec(
        "UPDATE profile SET language = 'fr', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 1",
      ),
    ).toThrow();
    opened2.db.close();
  });

  it("enforces candidate/memory scope invariants in repositories and direct SQL", () => {
    const db = MemoryDatabase.openInMemory();
    const candidates = new CandidatesRepository(db);
    const memories = new MemoriesRepository(db);

    expect(() =>
      candidates.create({
        scope: "profile",
        memoryType: "decision",
        text: "x",
        evidenceSummary: null,
        sourceSessionId: null,
        sourceRef: null,
        proposedAction: "create",
        targetMemoryId: null,
        projectIdentity: null,
      }),
    ).toThrow(/profile scope/);
    expect(() =>
      memories.create({
        scope: "project",
        memoryType: "decision",
        projectIdentity: null,
        bankId: "bank",
        documentId: "doc",
        unitId: null,
        textHash: "h",
        textLength: 1,
        verificationState: "verified",
        sourceSessionId: null,
        sourceRef: null,
        supersedesMemoryId: null,
        expiresAt: null,
      }),
    ).toThrow(/projectIdentity/);

    expect(() =>
      db.exec(
        "INSERT INTO candidates (id, scope, memory_type, text, evidence_summary, source_session_id, source_ref, proposed_action, target_memory_id, project_identity, state, created_at, updated_at, expires_at) VALUES ('c1', 'profile', 'decision', 'x', NULL, NULL, NULL, 'create', NULL, NULL, 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z')",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO memories (id, scope, memory_type, project_identity, bank_id, document_id, unit_id, text_hash, text_length, status, verification_state, source_session_id, source_ref, supersedes_memory_id, created_at, updated_at, last_verified_at, expires_at) VALUES ('m1', 'project', 'decision', NULL, 'bank', 'doc', NULL, 'hash', 4, 'active', 'verified', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)",
      ),
    ).toThrow();
    db.close();
  });

  it("supports guarded candidate transitions and operation idempotency", () => {
    const db = MemoryDatabase.openInMemory();
    const candidates = new CandidatesRepository(db);
    const memories = new MemoriesRepository(db);
    const operations = new OperationsRepository(db);
    const candidate = candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Use concise commit messages.",
      evidenceSummary: "User asked for concise style.",
      sourceSessionId: "s1",
      sourceRef: "entry:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    const memory = memories.create({
      scope: "profile",
      memoryType: "preference",
      projectIdentity: null,
      bankId: "bank-1",
      documentId: "doc-1",
      unitId: "unit-1",
      textHash: "hash-1",
      textLength: 10,
      verificationState: "verified",
      sourceSessionId: "s1",
      sourceRef: "entry:1",
      supersedesMemoryId: null,
      expiresAt: null,
    });

    expect(candidates.tryMarkRejected(candidate.id)).toBe(true);

    const failedCandidate = candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Definite failure.",
      evidenceSummary: "e",
      sourceSessionId: "s1",
      sourceRef: "entry:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    db.prepare("UPDATE candidates SET state='failed', failure_code='stale_target' WHERE id=?").run(failedCandidate.id);
    expect(candidates.tryMarkRejected(failedCandidate.id)).toBe(true);
    const reconcilingCandidate = candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Maybe issued.",
      evidenceSummary: "e",
      sourceSessionId: "s1",
      sourceRef: "entry:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    db.prepare("UPDATE candidates SET state='reconciling' WHERE id=?").run(reconcilingCandidate.id);
    expect(candidates.tryMarkRejected(reconcilingCandidate.id)).toBe(false);
    expect(candidates.getById(reconcilingCandidate.id)!.text).toBe("Maybe issued.");

    expect(
      candidates.tryMarkApproved(candidate.id, memory.id, {
        scope: "profile",
        memoryType: "preference",
        projectIdentity: null,
        textHash: "a".repeat(64),
      }),
    ).toBe(false);
    expect(candidates.tryMarkExpired(candidate.id)).toBe(false);

    const candidate2 = candidates.create({
      scope: "profile",
      memoryType: "preference",
      text: "Use concise commit messages.",
      evidenceSummary: "User asked for concise style.",
      sourceSessionId: "s1",
      sourceRef: "entry:1",
      proposedAction: "create",
      targetMemoryId: null,
      projectIdentity: null,
    });
    expect(candidates.tryClaimForApproval(candidate2.id)).toBe(true);
    expect(candidates.tryClaimForApproval(candidate2.id)).toBe(false);

    expect(
      operations.tryCreate({
        idempotencyKey: "op-1",
        memoryId: memory.id,
        action: "create",
        bankId: "bank-1",
        documentId: "doc-1",
        expectedTextHash: "hash-1",
      }),
    ).toBe(true);
    expect(
      operations.tryCreate({
        idempotencyKey: "op-1",
        memoryId: memory.id,
        action: "create",
        bankId: "bank-1",
        documentId: "doc-1",
        expectedTextHash: "hash-1",
      }),
    ).toBe(false);
    expect(operations.tryTransition("op-1", "pending", "in_progress")).toBe(true);
    expect(operations.tryTransition("op-1", "pending", "committed")).toBe(false);
    db.close();
  });

  it("records approved-memory locators without storing bodies in audit or usage", () => {
    const db = MemoryDatabase.openInMemory();
    const memories = new MemoriesRepository(db);
    const audit = new AuditRepository(db);
    const usage = new UsageRepository(db);

    const memory = memories.create({
      scope: "project",
      memoryType: "decision",
      projectIdentity: "repo",
      bankId: "bank",
      documentId: "doc",
      unitId: "unit",
      textHash: "abc",
      textLength: 12,
      verificationState: "verified",
      sourceSessionId: "session",
      sourceRef: "entry:2",
      supersedesMemoryId: null,
      expiresAt: null,
    });
    audit.record({ eventType: "remember", memoryId: memory.id, outcome: "written", redactedCode: "ok" });
    usage.record({ modelId: "model-x", inputTokens: 12, outputTokens: 4, costUsd: 0.1, outcome: "stop" });

    const stored = memories.getById(memory.id);
    expect(stored?.document_id).toBe("doc");
    expect(Object.keys(audit.listRecent(1)[0] ?? {})).not.toContain("text");
    expect(Object.keys(usage.listRecent(1)[0] ?? {})).not.toContain("response");
    expect(() =>
      audit.record({
        eventType: "remember",
        memoryId: memory.id,
        outcome: "written",
        redactedCode: "Authorization: Bearer nope",
      }),
    ).toThrow(/redactedCode rejected/);
    expect(() =>
      audit.record({
        eventType: "bad event",
        memoryId: memory.id,
        outcome: "written",
      }),
    ).toThrow(/unsupported characters/);
    expect(() =>
      usage.record({
        modelId: "Bearer totally-not-allowed",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        outcome: "stop",
      }),
    ).toThrow(/modelId rejected/);
    expect(() =>
      usage.record({
        modelId: "model-x",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        outcome: "bad outcome",
      }),
    ).toThrow(/unsupported characters/);
    db.close();
  });

  it("rolls back v7 migration on foreign key violations and leaves v6 data intact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v6-corrupt-"));
    tempDirs.push(dir);
    await seedPopulatedV6Database(dir, true);

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(false);
    if (opened.ok) {
      opened.db.close();
      return;
    }
    expect(opened.reason).toContain("foreign key violation");

    const raw = new DatabaseSync(path.join(dir, "memory", "pi-memory-hindsight.db"));
    raw.exec("PRAGMA foreign_keys = ON");
    const userVersion = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(userVersion.user_version).toBe(6);
    expect(raw.prepare("SELECT id FROM memories WHERE id = 'm-v6'").get()).toEqual({ id: "m-v6" });
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories', 'memories_v6')")
        .all(),
    ).toEqual([{ name: "memories" }]);
    expect(raw.prepare("SELECT idempotency_key FROM operations WHERE idempotency_key = 'orphan:delete'").get()).toEqual({
      idempotency_key: "orphan:delete",
    });
    raw.close();
  });

  it("migrates a valid populated v6 database to v7 with zero foreign key violations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-memory-hindsight-v6-valid-"));
    tempDirs.push(dir);
    await seedPopulatedV6Database(dir, false);

    const opened = await MemoryDatabase.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((opened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    expect(opened.db.prepare("SELECT id FROM memories WHERE id = 'm-v6'").get()).toEqual({ id: "m-v6" });
    expect(opened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((opened.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const memorySql = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get() as { sql: string };
    expect(memorySql.sql).toContain("supersedes_memory_id TEXT REFERENCES memories (id)");
    opened.db.close();
  });
});

describe("lifecycle definitions", () => {
  it("matches documented expiry and verification defaults", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(candidateExpiryFrom(now)).toBe("2026-01-31T00:00:00.000Z");
    expect(memoryExpiryFrom("project_fact", now)).toBe("2026-06-30T00:00:00.000Z");
    expect(memoryExpiryFrom("task_state", now)).toBe("2026-01-31T00:00:00.000Z");
    expect(memoryExpiryFrom("inference", now)).toBe("2026-04-01T00:00:00.000Z");
    expect(memoryExpiryFrom("decision", now)).toBeNull();
    expect(defaultVerificationState("inference")).toBe("unverified");
    expect(defaultVerificationState("lesson")).toBe("verified");
  });
});
