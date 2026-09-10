/**
 * Process-wide runtime: SQLite governance store, global config, Profile
 * identity, and the Hindsight adapter. Built once (memoized) and reused by
 * every session/hook/tool/command in this process.
 *
 * Every failure path here must return a structured `ok: false` result and
 * never throw, so a broken database, malformed config, or unreachable
 * Hindsight deployment disables the memory feature without affecting normal
 * Pi operation (architecture.md "Failure and degradation").
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MemoryDatabase } from "../db/database.js";
import { ProfileRepository } from "../db/profile-repository.js";
import { MemoriesRepository } from "../db/memories-repository.js";
import { CandidatesRepository } from "../db/candidates-repository.js";
import { OperationsRepository } from "../db/operations-repository.js";
import { AuditRepository, ConflictsRepository, UsageRepository } from "../db/audit-conflicts-usage-repository.js";
import { MaintenanceRepository } from "../db/maintenance-repository.js";
import { loadGlobalConfig, loadHindsightApiKey } from "../config/global-config.js";
import { HindsightAdapter } from "../provider/hindsight-adapter.js";
import { profileBankId } from "../identity/bank-id.js";
import type { ProfileRow } from "../db/types.js";

export interface GlobalRuntime {
  agentDir: string;
  db: MemoryDatabase;
  hindsightUrl: string;
  adapter: HindsightAdapter;
  profile: ProfileRow;
  profileBankId: string;
  repos: {
    profiles: ProfileRepository;
    memories: MemoriesRepository;
    candidates: CandidatesRepository;
    operations: OperationsRepository;
    conflicts: ConflictsRepository;
    audit: AuditRepository;
    usage: UsageRepository;
    maintenance: MaintenanceRepository;
  };
}

export type GlobalRuntimeResult = { ok: true; runtime: GlobalRuntime } | { ok: false; reason: string };
export type LocalRuntimeResult = GlobalRuntimeResult;

const COMPAT_CHECK_TIMEOUT_MS = 5000;

let localCached: Promise<LocalRuntimeResult> | undefined;
let localCachedSnapshot: LocalRuntimeResult | undefined;
let providerCheckInFlight: Promise<GlobalRuntimeResult> | undefined;

/**
 * Returns the already-resolved local runtime, if any.
 * Does not open SQLite, create a Profile, or start initialization.
 */
export function peekCachedLocalRuntime(): LocalRuntimeResult | undefined {
  return localCachedSnapshot;
}

/** Returns the memoized local runtime without provider readiness checks. */
export function getLocalRuntime(): Promise<LocalRuntimeResult> {
  if (!localCached) {
    localCached = initLocalRuntime()
      .catch((err) => ({
        ok: false as const,
        reason: `unexpected global runtime initialization error: ${String(err)}`,
      }))
      .then((result) => {
        localCachedSnapshot = result;
        return result;
      });
  }
  return localCached;
}

/** Returns the provider-ready runtime, coalescing only in-flight compatibility checks. */
export function getGlobalRuntime(): Promise<GlobalRuntimeResult> {
  if (!providerCheckInFlight) {
    providerCheckInFlight = ensureProviderReady().finally(() => {
      providerCheckInFlight = undefined;
    });
  }
  return providerCheckInFlight;
}

/** Test-only: clears the memoized runtime so a fresh init can be observed. */
export function resetGlobalRuntimeForTests(): void {
  localCached = undefined;
  localCachedSnapshot = undefined;
  providerCheckInFlight = undefined;
}

async function initLocalRuntime(): Promise<LocalRuntimeResult> {
  const agentDir = getAgentDir();

  const dbResult = await MemoryDatabase.open(agentDir);
  if (!dbResult.ok) {
    return { ok: false, reason: `sqlite unavailable: ${dbResult.reason}` };
  }
  const db = dbResult.db;

  const globalConfigResult = await loadGlobalConfig(agentDir);
  if (!globalConfigResult.ok) {
    return { ok: false, reason: `invalid global config: ${globalConfigResult.reason}` };
  }
  const apiKey = loadHindsightApiKey();

  const profiles = new ProfileRepository(db);
  const profile = profiles.getOrCreate();
  const bankId = profileBankId(profile.anonymous_profile_id);

  const adapter = new HindsightAdapter({ baseUrl: globalConfigResult.config.url, apiKey });
  return {
    ok: true,
    runtime: {
      agentDir,
      db,
      hindsightUrl: globalConfigResult.config.url,
      adapter,
      profile,
      profileBankId: bankId,
      repos: {
        profiles,
        memories: new MemoriesRepository(db),
        candidates: new CandidatesRepository(db),
        operations: new OperationsRepository(db),
        conflicts: new ConflictsRepository(db),
        audit: new AuditRepository(db),
        usage: new UsageRepository(db),
        maintenance: new MaintenanceRepository(db),
      },
    },
  };
}

async function ensureProviderReady(): Promise<GlobalRuntimeResult> {
  const local = await getLocalRuntime();
  if (!local.ok) return local;
  const compat = await local.runtime.adapter.checkCompatibility(AbortSignal.timeout(COMPAT_CHECK_TIMEOUT_MS));
  if (!compat.ok) {
    return { ok: false, reason: `hindsight incompatible or unreachable: ${compat.reason}` };
  }
  return local;
}
