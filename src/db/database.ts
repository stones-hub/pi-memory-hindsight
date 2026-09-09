/**
 * SQLite governance store wrapper (architecture.md "Local SQLite model").
 * Uses built-in `node:sqlite`. WAL mode, busy timeout, foreign keys, and
 * short explicit transactions are mandatory; never hold a transaction across
 * a network or model call.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { buildLegacyOwnedDocumentId } from "../provider/validation.js";
import type { Scope } from "./types.js";

export type OpenDatabaseResult =
  | { ok: true; db: MemoryDatabase }
  | { ok: false; reason: string };

const BUSY_TIMEOUT_MS = 5000;

export class MemoryDatabase {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Opens (creating directories as needed) and migrates the database at
   * `<agentDir>/memory/pi-memory-hindsight.db`. Any failure (including a
   * `node:sqlite` load failure or a migration error) is reported as a
   * structured failure rather than thrown, so callers can disable memory
   * functionality safely without crashing Pi.
   */
  static async open(agentDir: string): Promise<OpenDatabaseResult> {
    const dir = path.join(agentDir, "memory");
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      return { ok: false, reason: `failed to create database directory: ${String(err)}` };
    }
    const filePath = path.join(dir, "pi-memory-hindsight.db");
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(filePath);
    } catch (err) {
      return { ok: false, reason: `failed to open database: ${String(err)}` };
    }
    try {
      raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA foreign_keys = ON");
    } catch (err) {
      raw.close();
      return { ok: false, reason: `failed to configure database: ${String(err)}` };
    }
    const instance = new MemoryDatabase(raw);
    try {
      instance.migrate();
    } catch (err) {
      raw.close();
      return { ok: false, reason: `migration failed: ${String(err)}` };
    }
    return { ok: true, db: instance };
  }

  /** Opens an in-memory database for tests. Still runs migrations. */
  static openInMemory(): MemoryDatabase {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    raw.exec("PRAGMA foreign_keys = ON");
    const instance = new MemoryDatabase(raw);
    instance.migrate();
    return instance;
  }

  private migrate(): void {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const pending = MIGRATIONS.filter((m) => m.version > current).sort(
      (a, b) => a.version - b.version,
    );
    for (const migration of pending) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    this.backfillLegacyDocumentKeys();
  }

  /**
   * Additive local-only backfill: mark rows whose stored document id still
   * recomputes from the pre-fix text-hash formula. Does not touch provider data.
   */
  private backfillLegacyDocumentKeys(): void {
    const rows = this.db
      .prepare(
        `SELECT id, scope, project_identity, document_id, text_hash, legacy_document_text_hash
         FROM memories
         WHERE legacy_document_text_hash IS NULL`,
      )
      .all() as Array<{
      id: string;
      scope: Scope;
      project_identity: string | null;
      document_id: string;
      text_hash: string;
      legacy_document_text_hash: string | null;
    }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(
      "UPDATE memories SET legacy_document_text_hash = ? WHERE id = ? AND legacy_document_text_hash IS NULL",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (
          row.document_id ===
          buildLegacyOwnedDocumentId(row.scope, row.project_identity, row.text_hash)
        ) {
          update.run(row.text_hash, row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Runs `fn` inside a short, synchronous `BEGIN IMMEDIATE` transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure; original error is more relevant.
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
