import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "./database.js";
import type { ProfileRow } from "./types.js";
import { detectLanguageFromEnv } from "../i18n/messages.js";
import { assertLanguage } from "./validation.js";

/** Gets the single profile row, creating an anonymous profile ID on first use. */
export class ProfileRepository {
  constructor(private readonly db: MemoryDatabase) {}

  getOrCreate(): ProfileRow {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM profile WHERE id = 1").get() as
        | ProfileRow
        | undefined;
      if (existing) return existing;

      const now = new Date().toISOString();
      const anonymousProfileId = randomUUID();
      const language = detectLanguageFromEnv();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO profile (id, anonymous_profile_id, language, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
        )
        .run(anonymousProfileId, language, now, now);

      return this.db.prepare("SELECT * FROM profile WHERE id = 1").get() as unknown as ProfileRow;
    });
  }

  setLanguage(language: string): void {
    assertLanguage(language);
    this.getOrCreate();
    this.db
      .prepare("UPDATE profile SET language = ?, updated_at = ? WHERE id = 1")
      .run(language, new Date().toISOString());
  }
}
