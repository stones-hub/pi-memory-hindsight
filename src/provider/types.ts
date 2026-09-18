/**
 * Provider-facing types for the Hindsight adapter
 * (architecture.md "Bank and identity model", hindsight-contract.md).
 *
 * These types intentionally mirror only the fields the Extension actually
 * uses from the live OpenAPI schemas confirmed against the tested Hindsight
 * baselines (`0.8.3` and `0.10.0`), not the full API surface.
 */

/** Exact API versions the adapter may negotiate. No broad semver range. */
export const SUPPORTED_API_VERSIONS = ["0.8.3", "0.10.0"] as const;
export type SupportedApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

export function isSupportedApiVersion(value: string): value is SupportedApiVersion {
  return (SUPPORTED_API_VERSIONS as readonly string[]).includes(value);
}

export type ProviderFailureCategory =
  | "timeout"
  | "aborted"
  | "network"
  | "http"
  | "malformed"
  | "oversize"
  | "validation";

export type ProviderResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: string;
      category: ProviderFailureCategory;
      status?: number;
      ambiguous?: boolean;
    };

export interface CompatibilityCheck {
  healthy: boolean;
  apiVersion: string;
  bankConfigApiEnabled: boolean;
}

/** Required owned-bank overrides (hindsight-contract.md "Dedicated bank contract"). */
export const OWNED_BANK_CONFIG_OVERRIDES = {
  retain_extraction_mode: "chunks",
  retain_chunk_size: 2048,
  enable_observations: false,
  enable_auto_consolidation: false,
} as const;

export interface RetainOneMemoryInput {
  bankId: string;
  documentId: string;
  text: string;
  /** String-valued governance metadata only; no secrets or evidence bodies. */
  metadata: Record<string, string>;
}

export interface RetainOneMemoryOutput {
  /** Hindsight's memory-unit ID for the single unit created for this document. */
  unitId: string;
}

export interface DeleteDocumentOutput {
  /** True when the document existed and was deleted by this call. */
  deleted: boolean;
  /** True when the document was already absent (404) at call time. */
  alreadyAbsent: boolean;
  memoryUnitsDeleted: number;
}

export type RecallSourceType = "world" | "experience";
export type RecallBudget = "low" | "mid" | "high";

export interface RecallInput {
  bankId: string;
  query: string;
  budget: RecallBudget;
  maxTokens: number;
}

/**
 * Native Recall relevance scores from Hindsight 0.10.0.
 * `final` is a finite number with no artificial 0..1 bound; optional component
 * scores may be null. Validated scores are diagnostics only in this phase.
 */
export interface RecallScores {
  final: number;
  reranker: number | null;
  semantic: number | null;
  keyword: number | null;
}

export interface RecallResultItem {
  id: string;
  text: string;
  type: string | null;
  documentId: string | null;
  metadata: Record<string, string> | null;
  tags: string[] | null;
  context: string | null;
  mentionedAt: string | null;
  /** Present after validation when the provider returned scores; otherwise null. */
  scores?: RecallScores | null;
}

export interface ReflectInput {
  bankId: string;
  query: string;
  budget: RecallBudget;
  maxTokens: number;
}

export interface ReflectOutput {
  text: string;
}
